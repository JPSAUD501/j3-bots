// SPDX-License-Identifier: AGPL-3.0-or-later
import { avatarShapeNames, botColors } from "@j3-bots/design-tokens/names";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BotId,
  EffortLevel,
  EntryId,
  Label,
  ModelId,
  OpenLiterals,
  ProviderId,
  SectionId,
} from "./base.ts";
import { ActivityKind, StepTool } from "./work.ts";

const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

/**
 * A bot's avatar as the server sends it: two design tokens the clients render.
 * They are any token, so a client older than the server still decodes a shape
 * or color it does not know, and draws its fallback (`resolveAvatar`).
 */
export const Avatar = Schema.Struct({
  shape: Token,
  color: Token,
});
export type Avatar = typeof Avatar.Type;

/** An avatar as the operator or a bot chooses it: a shape and a color this version has. */
export const AvatarChoice = Schema.Struct({
  shape: Schema.Literals(avatarShapeNames),
  color: Schema.Literals(botColors),
});
export type AvatarChoice = typeof AvatarChoice.Type;

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
  /** The provider rejected the credentials or a permission check: its account is signed out. */
  "permission-error",
  /** The provider's service could not be reached, after the engine's own retries. */
  "unreachable",
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

/**
 * A failure class as a client receives it: one added after this build reads
 * as `unknown`, a failure the client words without naming it. The server
 * writes and stores only a `FailureClass`.
 */
export const ReceivedFailureClass = OpenLiterals(FailureClass.literals);

/** The most text `FailureDetails` holds. */
export const MAX_FAILURE_DETAILS = 2_000;

/**
 * What the engine said of a failure, in its own technical words (an error's
 * class, code and message), scrubbed of secrets. Never the words a client
 * leads with: they show it only behind "Details".
 */
export const FailureDetails = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_FAILURE_DETAILS),
);

const since = { since: Schema.DateTimeUtc };
/**
 * Set by the server when the turn has shown no activity for long enough that it
 * may be stuck. Clients show it; they never derive it from their own timers.
 */
const stalled = {
  stalled: Schema.Boolean,
  /**
   * While the turn is stalled, when it last showed activity: what "No activity
   * for…" counts from. Null while it is not, and from a server that predates it.
   */
  quietSince: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
};

/**
 * Set by the server while it holds the bot's next message for a moment
 * before posting it, as a person types one: between the messages of a bot's
 * first contact. Clients show the bot typing. False from a server that
 * predates it.
 */
const typing = {
  typing: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
};

/**
 * Set by the server while the turn's AI has failed and the engine is trying it
 * again on its own. Clients say so in place of what the bot is doing: a retry
 * that succeeds leaves no trace, and one that gives up ends the turn as
 * failed. False from a server that predates it.
 */
const retrying = {
  retrying: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
};

/**
 * What the bot is doing. A bot is in exactly one state. Whether it has said
 * something the operator has not read is not a state: it is the roster item's
 * `unread`, and a client shows an idle bot with unread entries as done.
 */
export const BotState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  /** A turn started and no visible work has happened yet. */
  Schema.TaggedStruct("thinking", { ...since, ...stalled, ...typing, ...retrying }),
  /** A turn is running tools. */
  Schema.TaggedStruct("working", {
    ...since,
    ...stalled,
    ...typing,
    ...retrying,
    /**
     * The label of the step it is on (`WorkStep.label`): a command, a path,
     * a tool's name. A client says what the bot is doing in plain words from
     * `activityKind` and `tool`, never the raw command or path; it reads
     * this only for a tool J3 Bots cannot name, whose label is the tool's
     * readable name. A client that predates `activityKind` shows it as is.
     */
    activity: Schema.NullOr(Label),
    /** The kind of the step it is on (`WorkStep.kind`), while one runs. */
    activityKind: ActivityKind,
    /**
     * The tool it is using, when J3 Bots names it: clients say that in place
     * of `activity`, which then carries an English phrase for older clients.
     */
    tool: StepTool,
    /**
     * How many of its little ones work now (`LittleOnes.working`), in
     * whichever audience its turn speaks to: a count only, which says
     * nothing of the work. Zero from a server that predates it.
     */
    littleOnes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(0)),
    ),
  }),
  /** The bot asked a question or needs an approval: the card awaiting the operator. */
  Schema.TaggedStruct("waiting", {
    entryId: EntryId,
    /**
     * When the turn that waits on the card started (an approval the engine
     * holds it on); null while the bot waits between turns, on a card it
     * asked, and from a server that predates it.
     */
    since: Schema.NullOr(Schema.DateTimeUtc).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null)),
    ),
  }),
  /** The turn cannot continue. */
  Schema.TaggedStruct("blocked", {
    /** Open: the server builds a bot's state and never reads one back. */
    failure: ReceivedFailureClass,
    /** When a usage limit resets, if the provider said. */
    retryAt: Schema.NullOr(Schema.DateTimeUtc),
  }),
]);
export type BotState = typeof BotState.Type;

/** The longest suggested reply the server offers, in UTF-16 units. */
export const MAX_SUGGESTED_REPLY_LENGTH = 300;

/**
 * A message the operator might send next in a bot's conversation: the AI's
 * guess after the bot answered them, offered in the empty composer. It
 * follows the bot's message `after`, and is offered only while that message
 * is the newest entry of the conversation. Never sent by itself: taking it
 * puts its text in the composer.
 */
export const SuggestedReply = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SUGGESTED_REPLY_LENGTH)),
  after: EntryId,
});
export type SuggestedReply = typeof SuggestedReply.Type;

export const Bot = Schema.Struct({
  id: BotId,
  profile: Profile,
  model: ModelChoice,
  /**
   * How much the bot's AI thinks before it acts: one of the levels the engine
   * reports for its model (`ProviderStatus.models`), or null for the
   * harness's own default, for which nothing is sent. A level its model does
   * not offer now runs as the default, and never fails a turn. Only the
   * operator chooses it. Null from a server that predates it.
   */
  effort: Schema.NullOr(EffortLevel).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  permissionMode: PermissionMode,
  /** The operator's default contact. At most one bot is primary. */
  primary: Schema.Boolean,
  pinned: Schema.Boolean,
  /**
   * Kept out of the roster, among the hidden conversations: still running,
   * notifying and reachable. The operator sets it, and so may a bot, for one
   * it made or as the primary bot, unless the operator chose (decision 0050).
   */
  hidden: Schema.Boolean,
  /**
   * The bot may use a web browser on the server's computer, signed in to
   * every site the operator signed in to there. Off unless the operator
   * turns it on. False from a server that predates it.
   */
  browser: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /**
   * The roster section the bot is in, or null for none. Null from a server
   * that predates sections, whose roster sends no `sections`.
   */
  sectionId: Schema.NullOr(SectionId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  state: BotState,
  /**
   * A change of the bot's model or permission mode waits for background work
   * still running in its session, which applying it would end. The bot takes
   * no new work meanwhile; a Stop ends the work, and the change applies then.
   * Clients offer the Stop while it is true, whatever the state.
   */
  settingsHeld: Schema.Boolean,
  /**
   * The engine asked the bot's AI to stop, and the AI has not confirmed it in
   * time: it ignores the Stop. Clients offer Force stop in place of Stop while
   * it is true, whatever the state, since the work it ignores may have
   * outlived its turn (`bot.forceStop`). False from a server that predates it.
   */
  forceStop: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /**
   * The bot's opening, the first turn in which it speaks first, is still to
   * come or under way. While it is and the conversation is empty, clients say
   * the bot is getting ready, whatever its state between turns. False from a
   * server that predates it.
   */
  opening: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /**
   * What the operator might reply to the bot's last message in its
   * conversation, while the operator's switch for suggested replies is on.
   * Null when there is none, and from a server that predates it.
   */
  suggestedReply: Schema.NullOr(SuggestedReply).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Schema.DateTimeUtc,
});
export type Bot = typeof Bot.Type;
