// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  Label,
  LaunchArguments,
  ProviderPath,
  type ProviderSetup,
  type ProviderStatus,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AccountChanges } from "../stores/EngineStatus.ts";
import type { SignInAccount } from "../stores/ProviderSetup.ts";
import type { AiAccount } from "./aiAccount.ts";

// Settings → Providers on a server that lets the operator set each AI account up
// (decision 0108): every Claude Code and Codex account, its switch, its name,
// and under Advanced the executable, the launch arguments and the folder it
// keeps the sign-in in.

/** One account in Settings, with what the operator can set up of it. */
export interface SetUpAccount {
  readonly account: SignInAccount;
  readonly provider: ProviderStatus;
  readonly setup: ProviderSetup;
}

/**
 * Whether the server lets the operator add and set up accounts: it reports
 * what each can be set up with. An older server does not, and a client then
 * offers none of it.
 */
export const canSetUpAccounts = (engine: EngineStatus | null): boolean =>
  engine?.providers.some((provider) => provider.setup !== undefined) === true;

/** The accounts the operator set up, in the server's order: each harness's first, then those added. */
export const setUpAccounts = (engine: EngineStatus | null): ReadonlyArray<SetUpAccount> =>
  (engine?.providers ?? []).flatMap((provider) => {
    const { setup, harness } = provider;
    if (setup === undefined || harness === "other") return [];
    return [{ account: { harness, providerId: provider.id }, provider, setup }];
  });

/** What the operator typed in an account's form; null for a field they left alone. */
export interface AccountEdits {
  readonly name: string | null;
  /** The executable's path; empty for J3 Bots' own copy or the one on the server's `PATH`. */
  readonly binaryPath: string | null;
  readonly launchArguments: string | null;
}

export const noAccountEdits: AccountEdits = { name: null, binaryPath: null, launchArguments: null };

export type AccountField = "name" | "binaryPath" | "launchArguments";

/**
 * What saving an account's form would send:
 * - `unchanged`: nothing differs from the account;
 * - `invalid`: a field the server would refuse: an empty or too long name,
 *   a path that is not absolute or too long, arguments on more than a line;
 * - `changes`, and whether they `rebuild` the account, which ends what its
 *   bots run there: anything but its name.
 */
export type AccountPatch =
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "invalid"; readonly fields: ReadonlySet<AccountField> }
  | { readonly _tag: "changes"; readonly changes: AccountChanges; readonly rebuild: boolean };

const decodeName = Schema.decodeUnknownOption(Label);
const decodePath = Schema.decodeUnknownOption(ProviderPath);
const decodeArguments = Schema.decodeUnknownOption(LaunchArguments);

/** An absolute path on a Unix-like system, or on Windows, by a drive or a share. */
const isAbsolute = (path: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/u.test(path);

/** The fields the operator changed from `setup` and `name`, trimmed, and only those. */
export function accountPatch(
  name: string,
  setup: ProviderSetup,
  edits: AccountEdits,
): AccountPatch {
  const invalid = new Set<AccountField>();
  const changes: { -readonly [K in keyof AccountChanges]: AccountChanges[K] } = {};
  if (edits.name !== null && edits.name.trim() !== name) {
    const decoded = decodeName(edits.name.trim());
    if (Option.isNone(decoded)) invalid.add("name");
    else changes.name = decoded.value;
  }
  if (edits.binaryPath !== null) {
    const trimmed = edits.binaryPath.trim();
    if (trimmed === "") {
      if (setup.binaryPath !== null) changes.binaryPath = null;
    } else if (trimmed !== setup.binaryPath) {
      const decoded = decodePath(trimmed);
      if (Option.isNone(decoded) || !isAbsolute(trimmed)) invalid.add("binaryPath");
      else changes.binaryPath = decoded.value;
    }
  }
  if (edits.launchArguments !== null) {
    const trimmed = edits.launchArguments.trim();
    if (trimmed !== setup.launchArguments) {
      const decoded = decodeArguments(trimmed);
      if (Option.isNone(decoded)) invalid.add("launchArguments");
      else changes.launchArguments = decoded.value;
    }
  }
  if (invalid.size > 0) return { _tag: "invalid", fields: invalid };
  if (Object.keys(changes).length === 0) return { _tag: "unchanged" };
  return {
    _tag: "changes",
    changes,
    rebuild: changes.binaryPath !== undefined || changes.launchArguments !== undefined,
  };
}

/** The name an account of `harness` is first given, numbered past the ones there are. */
export function newAccountName(
  engine: EngineStatus | null,
  harness: AiAccount,
  base: string,
): string {
  const taken = new Set(
    setUpAccounts(engine)
      .filter(({ account }) => account.harness === harness)
      .map(({ provider }) => provider.name),
  );
  for (let number = taken.size + 1; ; number++) {
    const name = `${base} ${number}`;
    if (!taken.has(name)) return name;
  }
}
