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
  /** A connector, a gallery entry, or a sign-in to one: only connector requests name them. */
  "connector",
  "connector-listing",
  "sign-in",
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
    /** The vault is locked: a client unlocks it with the master password first. */
    "vault-locked",
    /** The vault has no master password yet: `vault.setup` sets one. */
    "vault-not-set-up",
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
    /** The service refused to register J3 Bots as a client. */
    "registration-refused",
    /** The service answered the sign-in with an error, or refused its code. */
    "sign-in-refused",
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
    /** A connect form's values: a required one missing, or one the form does not ask for. */
    "connector-fields",
    /** The gallery entry cannot be connected yet (`ConnectKind` `unsupported`). */
    "connector-unsupported",
    /** The address the browser returned to is not one this sign-in expects. */
    "sign-in-url",
  ]),
}) {
  override get message(): string {
    return `The command is invalid: ${this.reason}.`;
  }
}

/** What a command can fail with. */
export const CommandError = Schema.Union([NotFound, Conflict, Invalid]);
export type CommandError = typeof CommandError.Type;
