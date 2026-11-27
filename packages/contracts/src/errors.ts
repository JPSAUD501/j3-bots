// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { SecretName } from "./secrets.ts";

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
  /** Only an answer to a request about sections names it. */
  "section",
  /** A secret, which only the secrets' requests name. */
  "secret",
  /** A connector, a gallery entry, or a sign-in to one: only connector requests name them. */
  "connector",
  "connector-listing",
  "sign-in",
  /** A provider, which only `engine.*Provider` requests name. */
  "provider",
  /** A skill, which only skill requests name. */
  "skill",
  /** A connector's app, which only `connectorApp` requests, new in 0.9.0, name. */
  "connector-app",
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
     * The room is of bots only (`Room.botsOnly`): the operator reads it and
     * does not write, react or change who is in it. A client that knows it
     * offers none of these there.
     */
    "room-bots-only",
    /**
     * Where the file would go now leads, through a symbolic link made after
     * start, out of the server's private data. Nothing was written; removing
     * the link lets it through again.
     */
    "private-location",
    /**
     * The operator's secrets cannot be read now: their state
     * (`secrets.status`) is not `ready`, and says why.
     */
    "secrets-unavailable",
    /**
     * A value of a secret does not open under its key, or does not read as
     * what it should be: the file was changed by hand or damaged. The server's log names the record
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
    /** The connector's server did not answer as asked, or cannot be reached now. */
    "connector-unavailable",
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
    /** The provider is the first of its harness, which can be turned off, never removed. */
    "provider-not-removable",
    /**
     * The engine cannot update this provider's harness itself, or knows no
     * newer version of it. Only `engine.updateProvider` answers it.
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
    /**
     * The server's disk lacks room for the file and the copy a bot's
     * workspace takes of it. Only a recording upload answers it
     * (`HTTP_PATHS.recordingUploads`), so no client of an earlier version
     * meets it.
     */
    "no-space",
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
    /** A login's field for a single value, or a single value's for a login. */
    "secret-kind",
    /** The one-time code setup is neither a base32 secret nor an `otpauth://totp/` address. */
    "totp",
    /** A connect form's values: a required one missing, or one the form does not ask for. */
    "connector-fields",
    /** A connector's prompt was given an argument it does not take, or not one it requires. */
    "prompt-arguments",
    /** An answer to a connector's form that does not fit its fields. */
    "connector-input",
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
    /**
     * A reaction that is not one emoji, or on an entry that is not a message.
     * Only `message.react`, new in 0.13.0, names it: an older client never
     * sends one.
     */
    "reaction",
    /**
     * A message's quotes: one of anything but a message of its conversation
     * or room, a passage not in its message's text, one twice, or more than
     * one reply. Only `message.send`'s `quotes`, new in 0.14.0, names it: an
     * older client never sends one.
     */
    "quotes",
  ]),
}) {
  override get message(): string {
    return `The command is invalid: ${this.reason}.`;
  }
}

/**
 * A connector's settings name a secret (`${secret:<name>}`) that cannot be
 * used as they are written. Nothing changed. `problem`:
 * - `missing`: no secret has that name;
 * - `no-value`: the secret has no such value, as a single value's user name;
 * - `not-shared`: a bot the connector would go to may not use it: the
 *   operator shares it with that bot in Secrets, or narrows who uses the
 *   connector;
 * - `not-yours`: the bot that wrote the settings may not use it itself;
 * - `in-address`: it is in the connector's address, where no reference is
 *   resolved: one goes in a header, an argument or an environment value;
 * - `destination`: a bot's change would change where settings that name
 *   it send it (the program, its arguments, a variable's other text), which
 *   only the operator may: a bot uses a secret without reading it.
 */
export class SecretRefused extends Schema.TaggedError<SecretRefused>()("SecretRefused", {
  secret: SecretName,
  problem: Schema.Literals([
    "missing",
    "no-value",
    "not-shared",
    "not-yours",
    "in-address",
    "destination",
  ]),
}) {
  override get message(): string {
    return `The connector cannot use the secret "${this.secret}": ${this.problem}.`;
  }
}

/** What a command can fail with. */
export const CommandError = Schema.Union([NotFound, Conflict, Invalid]);
export type CommandError = typeof CommandError.Type;

/**
 * What a connector command that sets what a connector sends, or which bots
 * it goes to, can fail with: any command's errors, and a secret its settings
 * name that those bots cannot use.
 */
export const ConnectorCommandError = Schema.Union([NotFound, Conflict, Invalid, SecretRefused]);
export type ConnectorCommandError = typeof ConnectorCommandError.Type;
