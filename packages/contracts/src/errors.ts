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
  ]),
}) {
  override get message(): string {
    return `The command is invalid: ${this.reason}.`;
  }
}

/** What a command can fail with. */
export const CommandError = Schema.Union([NotFound, Conflict, Invalid]);
export type CommandError = typeof CommandError.Type;
