// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runPowerShell } from "../system/PowerShell.ts";

// A private folder on Windows. Mode bits mean nothing there: who may open a
// folder is its access control list (its DACL) and its owner. The server's
// home, and the desktop's before it starts a server there, is private when
// only this user, SYSTEM and the Administrators group may open it.
//
// Why those three: they are what Windows itself gives a user's profile
// folder, where the desktop keeps the home, and what everything under
// `%APPDATA%` inherits. SYSTEM runs the backup, indexing and antivirus
// services that read the profile; an administrator can take ownership of any
// file on the machine whatever its list says, so leaving them out would keep
// no one out and break the tools that back the profile up.
//
// The list is read with PowerShell's `Get-Acl`, by security identifier (SID)
// and numeric rights, never by account name: `icacls` prints names in the
// system's language (`AUTORIDADE NT\SISTEMA` on a Brazilian Windows) and has
// no way to print SIDs, so parsing it would break on most of the world's
// machines. PowerShell 5.1 comes with every supported Windows, so this needs
// nothing installed. Node has no API for either.

/** Well-known SIDs, the same on every Windows. */
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
/** Stands for whoever creates something in the folder; such a rule applies only to what it creates. */
const CREATOR_OWNER = "S-1-3-0";
/** Stands for the folder's owner. */
const OWNER_RIGHTS = "S-1-3-4";

/** One access rule, as `Get-Acl` gives it. */
const AccessRule = Schema.Struct({
  sid: Schema.String,
  allow: Schema.Boolean,
  /** `FileSystemRights`, as a number. */
  rights: Schema.Number,
  inherited: Schema.Boolean,
  /** Whether it applies only to what is inside the folder, not to the folder itself. */
  inheritOnly: Schema.Boolean,
});

/** What Windows says of a folder's ownership and access, by SID. */
export const FolderAcl = Schema.Struct({
  /** This process's user. */
  user: Schema.String,
  /** The groups its token holds, such as Everyone and Users: a rule that denies one of them denies the user. */
  groups: Schema.Array(Schema.String),
  owner: Schema.String,
  /** Whether its rules no longer come from its parent's (inheritance off). */
  protected: Schema.Boolean,
  rules: Schema.Array(AccessRule),
});
export type FolderAcl = typeof FolderAcl.Type;

/** Why a folder is not private, in the terms `HomeNotPrivate` uses for every system. */
export type AclVerdict = "private" | "not-owned" | "open-to-others" | "closed-to-owner";

/** `FileSystemRights` the owner needs on the folder itself: read, write, create, list, traverse and delete in it (`Modify`). */
const OWNER_NEEDS = 0x301bf;
const FULL_CONTROL = 0x1f01ff;

/** The rights a rule grants, its generic rights mapped to the ones they stand for on a file system. */
const effectiveRights = (rights: number) => {
  const generic: ReadonlyArray<readonly [bit: number, means: number]> = [
    [0x10000000, FULL_CONTROL], // GENERIC_ALL
    [0x80000000, 0x120089], // GENERIC_READ
    [0x40000000, 0x120116], // GENERIC_WRITE
    [0x20000000, 0x1200a0], // GENERIC_EXECUTE
  ];
  // PowerShell may give rights above 2^31 as a negative 32-bit number.
  const bits = rights >>> 0;
  let specific = bits & 0x0fffffff;
  for (const [bit, means] of generic) {
    if ((bits & bit) !== 0) specific |= means;
  }
  return specific;
};

/**
 * Whether `acl` keeps a folder private: owned by this user, SYSTEM or the
 * Administrators group (the others already own anything they want to),
 * opened by no other account, whatever the rule (one that applies only to
 * what is inside counts too), and granting this user `Modify` on the folder
 * itself by name, which no rule for it or one of its groups denies. A grant
 * through a group is not counted: the home is created with one by name, and
 * the repair command gives it one.
 */
export const judgeAcl = (acl: FolderAcl): AclVerdict => {
  const trusted = new Set([acl.user, SYSTEM, ADMINISTRATORS]);
  if (!trusted.has(acl.owner)) return "not-owned";
  const mayOpen = new Set([...trusted, CREATOR_OWNER, OWNER_RIGHTS]);
  if (acl.rules.some((rule) => rule.allow && rule.rights !== 0 && !mayOpen.has(rule.sid))) {
    return "open-to-others";
  }
  const onFolder = acl.rules.filter((rule) => !rule.inheritOnly);
  const isUser = (sid: string) =>
    sid === acl.user || (sid === OWNER_RIGHTS && acl.owner === acl.user);
  const groups = new Set(acl.groups);
  const granted = onFolder
    .filter((rule) => rule.allow && isUser(rule.sid))
    .reduce((rights, rule) => rights | effectiveRights(rule.rights), 0);
  const denied = onFolder
    .filter((rule) => !rule.allow && (isUser(rule.sid) || groups.has(rule.sid)))
    .reduce((rights, rule) => rights | effectiveRights(rule.rights), 0);
  return (granted & ~denied & OWNER_NEEDS) === OWNER_NEEDS ? "private" : "closed-to-owner";
};

const decodeAcl = Schema.decodeUnknownEffect(Schema.fromJsonString(FolderAcl));

/** The folder's path reaches the scripts as this variable, never in their text. */
const PATH_VARIABLE = "J3_PRIVATE_FOLDER";

const SID_TYPE = "[Security.Principal.SecurityIdentifier]";

const INSPECT = `
$acl = Get-Acl -LiteralPath $env:${PATH_VARIABLE}
$rules = @($acl.GetAccessRules($true, $true, ${SID_TYPE}) | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Value
    allow = ($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow)
    rights = [long]$_.FileSystemRights
    inherited = $_.IsInherited
    inheritOnly = (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
  }
})
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$found = [ordered]@{
  user = $identity.User.Value
  groups = @($identity.Groups | ForEach-Object { $_.Value })
  owner = $acl.GetOwner(${SID_TYPE}).Value
  protected = $acl.AreAccessRulesProtected
  rules = $rules
}
[Console]::Out.Write((ConvertTo-Json -InputObject $found -Depth 4 -Compress))
`;

/** Unreadable, or not decodable: what `Get-Acl` said of the folder could not be used. */
export class AclUnreadable extends Schema.TaggedError<AclUnreadable>()("AclUnreadable", {
  folder: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Windows did not say who may open ${this.folder}: ${this.detail}`;
  }
}

/** What Windows says of `folder`'s owner and access, by SID. */
export const readFolderAcl = Effect.fn("windowsAcl.read")(function* (folder: string) {
  const unreadable = (detail: string) => new AclUnreadable({ folder, detail });
  const output = yield* runPowerShell(INSPECT, { [PATH_VARIABLE]: folder }).pipe(
    Effect.mapError((error) => unreadable(error.detail)),
  );
  return yield* decodeAcl(output).pipe(Effect.mapError((error) => unreadable(error.message)));
});

/**
 * Creates `folder`, whose parent must exist, private from its first moment:
 * the folder is made with its list in place (inheritance off, full control
 * for this user, SYSTEM and Administrators, passed on to everything made
 * inside), so nothing can be put in it before it is private. A folder already
 * there is left as it is, for the caller to check (`readFolderAcl`).
 */
export const createPrivateFolder = Effect.fn("windowsAcl.createPrivate")(function* (
  folder: string,
) {
  yield* runPowerShell(
    `
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetAccessRuleProtection($true, $false)
$everyone = @(
  [Security.Principal.WindowsIdentity]::GetCurrent().User,
  (New-Object Security.Principal.SecurityIdentifier '${SYSTEM}'),
  (New-Object Security.Principal.SecurityIdentifier '${ADMINISTRATORS}')
)
foreach ($sid in $everyone) {
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)))
}
[void][IO.Directory]::CreateDirectory($env:${PATH_VARIABLE}, $security)
`,
    { [PATH_VARIABLE]: folder },
  ).pipe(Effect.mapError((error) => new AclUnreadable({ folder, detail: error.detail })));
});

/**
 * The `icacls` command that makes `folder` private as `judgeAcl` wants it,
 * for the operator to run: inheritance off, full control for this user,
 * SYSTEM and Administrators, and every rule for anyone else removed. SIDs,
 * written `*S-1-…`, mean the same in every language; each is quoted, so it
 * runs the same in a Command Prompt and in PowerShell.
 */
export const repairCommand = (folder: string, acl: FolderAcl) => {
  const others = [
    ...new Set(
      acl.rules
        .filter((rule) => ![acl.user, SYSTEM, ADMINISTRATORS].includes(rule.sid))
        .map((rule) => rule.sid),
    ),
  ];
  return [
    `icacls "${folder}" /inheritance:r`,
    ...[acl.user, SYSTEM, ADMINISTRATORS].map((sid) => `/grant:r "*${sid}:(OI)(CI)F"`),
    ...(others.length === 0 ? [] : ["/remove", ...others.map((sid) => `"*${sid}"`)]),
  ].join(" ");
};
