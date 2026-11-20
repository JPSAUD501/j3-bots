// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, EntryId, Label, ModelId, ProviderId } from "./base.ts";

const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

/** Two choices the operator makes. The values are design tokens the clients render. */
export const Avatar = Schema.Struct({
  shape: Token,
  color: Token,
});
export type Avatar = typeof Avatar.Type;

/** The longest text each profile field takes. */
export const PROFILE_LIMITS = { name: 40, title: 40, job: 2_000 } as const;

export const Profile = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(PROFILE_LIMITS.name)),
  /** Short role, such as "Research". Empty when the operator gave none. */
  title: Schema.String.check(Schema.isMaxLength(PROFILE_LIMITS.title)),
  avatar: Avatar,
  /** What the bot is for and where its limits are, in plain language. */
  job: Schema.String.check(Schema.isMaxLength(PROFILE_LIMITS.job)),
});
export type Profile = typeof Profile.Type;

export const ModelChoice = Schema.Struct({
  providerId: ProviderId,
  modelId: ModelId,
});
export type ModelChoice = typeof ModelChoice.Type;

/** How much a bot may do without asking. */
export const PermissionMode = Schema.Literals([
  "supervised",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type PermissionMode = typeof PermissionMode.Type;

/** Why a turn could not run or continue. */
export const FailureClass = Schema.Literals([
  /** The provider's usage window is exhausted until a reset time. */
  "usage-limit",
  /** The provider refused or failed the request. */
  "provider-error",
  /** The provider rejected the credentials or a permission check. */
  "permission-error",
  /** The engine could not be reached or restarted mid-turn. */
  "engine-unavailable",
  /** The bot's working context could not be resumed. */
  "session-lost",
  /**
   * A Stop that does not cover the work ended it before it reached the bot: a
   * room's archival or deletion, or a stop from the engine's own console.
   */
  "stopped",
  "unknown",
]);
export type FailureClass = typeof FailureClass.Type;

const since = { since: Schema.DateTimeUtc };
/**
 * Set by the server when the turn has shown no activity for long enough that it
 * may be stuck. Clients show it; they never derive it from their own timers.
 */
const stalled = { stalled: Schema.Boolean };

/**
 * What the bot is doing. A bot is in exactly one state. Whether it has said
 * something the operator has not read is not a state: it is the roster item's
 * `unread`, and a client shows an idle bot with unread entries as done.
 */
export const BotState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  /** A turn started and no visible work has happened yet. */
  Schema.TaggedStruct("thinking", { ...since, ...stalled }),
  /** A turn is running tools. */
  Schema.TaggedStruct("working", {
    ...since,
    ...stalled,
    /** One line saying what it is doing right now. */
    activity: Schema.NullOr(Label),
  }),
  /** The bot asked a question or needs an approval: the card awaiting the operator. */
  Schema.TaggedStruct("waiting", { entryId: EntryId }),
  /** The turn cannot continue. */
  Schema.TaggedStruct("blocked", {
    failure: FailureClass,
    /** When a usage limit resets, if the provider said. */
    retryAt: Schema.NullOr(Schema.DateTimeUtc),
  }),
]);
export type BotState = typeof BotState.Type;

export const Bot = Schema.Struct({
  id: BotId,
  profile: Profile,
  model: ModelChoice,
  permissionMode: PermissionMode,
  /** The operator's default contact. At most one bot is primary. */
  primary: Schema.Boolean,
  pinned: Schema.Boolean,
  /** Kept out of the roster; still running and reachable through search. */
  hidden: Schema.Boolean,
  state: BotState,
  createdAt: Schema.DateTimeUtc,
});
export type Bot = typeof Bot.Type;
