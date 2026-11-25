// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

/**
 * The request carried no device credential, or one that is unknown, expired or
 * revoked. Sent by the HTTP routes; a socket with a bad credential is refused at
 * the upgrade and a revoked device's sockets are closed.
 */
export class NotAuthenticated extends Schema.TaggedError<NotAuthenticated>()(
  "NotAuthenticated",
  {},
) {
  override get message(): string {
    return "This device is not paired, or its pairing was revoked.";
  }
}

/** Too many failed attempts. Nothing is accepted until `retryAt`. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAt: Schema.DateTimeUtc,
}) {
  override get message(): string {
    return "Too many attempts. Try again later.";
  }
}

export const Resource = Schema.Literals([
  "bot",
  "room",
  "entry",
  "routine",
  "routine-run",
  "memory-file",
  "device",
  "attachment",
  /** Only an answer to a request about sections names it, which an older client never makes. */
  "section",
  /** A secret, which only the secrets' requests name. */
  "secret",
  /** A connector, a gallery entry, or a sign-in to one: only connector requests name them. */
  "connector",
  "connector-listing",
  "sign-in",
  /** A provider, which only `engine.recheckProvider`, new in 0.8.0, names: an older client never asks it. */
  "provider",
  /** A skill, which only skill requests name. */
  "skill",
]);
export type Resource = typeof Resource.Type;

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Resource,
}) {
  override get message(): string {
    return `The ${this.resource} does not exist.`;
  }
}

/** The command is valid, but the current state does not allow it. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  reason: Schema.Literals([
    /** The command id was already used for a different command. */
    "command-id-reused",
    /** The card was already answered, dismissed or expired. */
    "card-closed",
    /** The memory file changed after it was read. */
    "stale-revision",
    /** The notice or message can no longer be retried. */
    "not-retryable",
    /** The engine cannot take the command right now; retry once it is ready. */
    "engine-unavailable",
    /** The room is archived: it takes no messages and no changes. */
    "room-archived",
    /**
     * Where the file would go now leads, through a symbolic link made after
     * start, out of the server's private data. Nothing was written; removing
     * the link lets it through again.
     */
    "private-location",
    /**
     * The operator's secrets are in a vault sealed under a master password,
     * from before secrets, which waits for that password to be typed one last
     * time (`secrets.openOldVault`).
     */
    "secrets-old-vault",
    /**
     * The key that opens the operator's secrets is missing or is another one:
     * its file was deleted or replaced.
     */
    "secrets-unreadable",
    /**
     * A newer release of J3 Bots changed the secrets' file, which this one
     * cannot read. Nothing in it can be used until that release runs again.
     */
    "secrets-newer",
    /**
     * A value of a secret does not open under its key, or does not read as
     * what it should be, or an old vault's key settings are out of range: the
     * file was changed by hand or damaged. The server's log names the record
     * and field, never the value. Restoring the file from a backup fixes it.
     */
    "secrets-damaged",
    /** Another secret has that name already. */
    "secret-name-taken",
    /**
     * The connector's address is in the operator's own network. Nothing was
     * added; the operator confirms it, and the client sends it again saying so.
     */
    "private-network",
    /** The connector's tools changed again after the review the operator answered. */
    "tool-review-stale",
    /**
     * The gallery's search of the MCP Registry, or its read of one entry
     * there, did not answer; the curated list still does.
     */
    "registry-unavailable",
    /**
     * The server cannot be where the browser returns after a sign-in: its
     * address is not `https:`, and it does not run on the device's computer.
     */
    "no-server-redirect",
    /**
     * The connector's service does not sign in as J3 Bots requires: no
     * metadata to find it by, no PKCE with S256, an endpoint that is not
     * `https:`.
     */
    "sign-in-unsupported",
    /**
     * The service did not answer while J3 Bots signed in (its metadata, its
     * registration or its token endpoint): a network error, a timeout or an
     * error of its own. Trying again may work.
     */
    "sign-in-unreachable",
    /** The service refused to register J3 Bots as a client. */
    "registration-refused",
    /** The service answered the sign-in with an error, or refused its code. */
    "sign-in-refused",
    /**
     * The engine cannot update this provider's harness itself, or knows no
     * newer version of it. Only `engine.updateProvider`, new in 0.8.0,
     * answers it.
     */
    "provider-not-updatable",
    /**
     * J3 Bots installs no copy of the harness on this server: it runs the one
     * the operator installed, or J3 Bots has no build of it for
     * the server's system and processor.
     */
    "harness-not-installable",
    /** The skill is one J3 Bots ships (`j3-…`), which it installs again at every start. */
    "skill-shipped",
    /**
     * A skill of the other scope has that name: a bot's own and a shared one
     * would share it, and Claude Code lists only one of the two.
     */
    "skill-name-taken",
    /** The scope holds as many skills as it may (`SKILL_LIMITS.perScope`). */
    "skill-limit",
    /** The repository could not be fetched: unreachable, refused, or no such commit or branch. */
    "skill-fetch",
  ]),
}) {
  override get message(): string {
    return `The command conflicts with the current state: ${this.reason}.`;
  }
}

/** The command is malformed in a way only the server can tell. */
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
  reason: Schema.Literals([
    "pairing-code",
    "answer",
    "room-members",
    "mentions",
    "attachment",
    "schedule",
    "time-zone",
    "model",
    "memory-path",
    "message-length",
    /** An answer to a bot's question too long to reach the bot. */
    "answer-length",
    /** A dismissal of a question the harness asked: only a bot's `ask` question takes one. */
    "not-dismissible",
    /** The password given is not the one the old vault was sealed under. */
    "old-vault-password",
    /** A login's field for a single value, or a single value's for a login. */
    "secret-kind",
    /** The one-time code setup is neither a base32 secret nor an `otpauth://totp/` address. */
    "totp",
    /** A connect form's values: a required one missing, or one the form does not ask for. */
    "connector-fields",
    /** The gallery entry cannot be connected yet (`ConnectKind` `unsupported`). */
    "connector-unsupported",
    /** The address the browser returned to is not one this sign-in expects. */
    "sign-in-url",
    /**
     * A command connector runs a package through `npx` or `uvx` with no exact
     * version (a tag, a range, none), or the server cannot tell which package
     * it runs: its command line names it at an exact version instead.
     */
    "command-unpinned",
    /**
     * A skill's `SKILL.md` does not open with frontmatter naming the skill,
     * with a one-line `description` of when it applies, or a file of it breaks
     * a limit (`SKILL_LIMITS`).
     */
    "skill-text",
    /**
     * The folder of the repository is not a skill (no `SKILL.md`), holds a
     * link or a submodule, or breaks a limit (`SKILL_LIMITS`).
     */
    "skill-repository",
  ]),
}) {
  override get message(): string {
    return `The command is invalid: ${this.reason}.`;
  }
}

/** What a command can fail with. */
export const CommandError = Schema.Union([NotFound, Conflict, Invalid]);
export type CommandError = typeof CommandError.Type;

