// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { Attachment } from "./attachment.ts";
import {
  BotId,
  CommandId,
  EntryId,
  EntryOrder,
  Label,
  NonNegativeInt,
  RoomId,
  RoutineId,
  WorkStepId,
} from "./base.ts";
import { FailureClass } from "./bot.ts";
import { RoutineTrigger } from "./routine.ts";

/** Where entries live: a bot's conversation with the operator, or a room. */
export const EntryTarget = Schema.Union([
  Schema.TaggedStruct("conversation", { botId: BotId }),
  Schema.TaggedStruct("room", { roomId: RoomId }),
]);
export type EntryTarget = typeof EntryTarget.Type;

/**
 * The bot's id outlives the bot: entries keep it after the bot is deleted. A
 * client that finds no bot with this id in the roster renders a deleted bot.
 */
export const BotAuthor = Schema.TaggedStruct("bot", { botId: BotId });

export const Author = Schema.Union([
  Schema.TaggedStruct("operator", {}),
  BotAuthor,
  /** J3 Bots itself. */
  Schema.TaggedStruct("system", {}),
]);
export type Author = typeof Author.Type;

/** The most characters (UTF-16 code units) one message can hold. */
export const MAX_MESSAGE_LENGTH = 100_000;

export const MessageText = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/**
 * Who a room message addresses. In a conversation it is always `bots` with no
 * ids. The server routes room wakes from it, never from the text.
 */
export const Mentions = Schema.Union([
  /** These members, in this order. No ids: nobody in particular, which wakes the host. */
  Schema.TaggedStruct("bots", { ids: Schema.Array(BotId).check(Schema.isMaxLength(6)) }),
  /** Every member, one at a time in member order. */
  Schema.TaggedStruct("everyone", {}),
]);
export type Mentions = typeof Mentions.Type;

const entry = {
  id: EntryId,
  order: EntryOrder,
  author: Author,
  createdAt: Schema.DateTimeUtc,
};

/**
 * - `pending`: recorded, and not every recipient has received it yet (one is
 *   busy, or the message waits on a budget).
 * - `delivered`: it reached every recipient.
 * - `cancelled`: the operator stopped a recipient before it received the
 *   message, so it never will. A recipient the operator deleted, or removed
 *   from the room, before it received the message no longer counts: the
 *   message shows the other recipients' delivery, and `cancelled` only when
 *   it had no other.
 * - `failed`: J3 Bots gave up delivering it to a recipient, and will not try
 *   again on its own; `message.retry` sends it again. `rejected`: the engine
 *   refused it. `unresolved`: whether the engine took it could not be
 *   learned. `stopped`: a room's Stop cancelled it in the engine on its way to
 *   a bot in private. A failed message can still turn out `delivered`, when
 *   the engine had taken it after all.
 */
export const MessageDelivery = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("delivered", {}),
  Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("failed", {
    reason: Schema.Literals(["rejected", "unresolved", "stopped"]),
  }),
]);
export type MessageDelivery = typeof MessageDelivery.Type;

export const MessageEntry = Schema.TaggedStruct("message", {
  ...entry,
  text: MessageText,
  attachments: Schema.Array(Attachment),
  mentions: Mentions,
  /** Whether it reached its recipients. Messages written by bots are always `delivered`. */
  delivery: MessageDelivery,
  /** The operator's command that created it, so a client can replace its optimistic copy. */
  commandId: Schema.NullOr(CommandId),
});
export type MessageEntry = typeof MessageEntry.Type;

export const QuestionOption = Schema.Struct({
  id: Label,
  label: Label,
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
  /** `recommended` marks the option the bot suggests; `destructive`, one that loses something. */
  style: Schema.Literals(["default", "recommended", "destructive"]),
});
export type QuestionOption = typeof QuestionOption.Type;

/** The most options one question shows. */
export const MAX_QUESTION_OPTIONS = 6;
/** The most questions one card holds. */
export const MAX_CARD_QUESTIONS = 4;

export const Question = Schema.Struct({
  id: Label,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  options: Schema.Array(QuestionOption).check(Schema.isMaxLength(MAX_QUESTION_OPTIONS)),
  /** Whether a typed answer is accepted besides the options. */
  acceptsText: Schema.Boolean,
  /** Whether more than one option may be chosen. */
  multiple: Schema.Boolean,
});
export type Question = typeof Question.Type;

export const QuestionAnswer = Schema.Struct({
  optionIds: Schema.Array(Label),
  text: Schema.NullOr(MessageText),
});
export type QuestionAnswer = typeof QuestionAnswer.Type;

/** Answers keyed by question id. */
export const QuestionAnswers = Schema.Record(Label, QuestionAnswer);
export type QuestionAnswers = typeof QuestionAnswers.Type;

/**
 * A question for the operator. The two origins have different lifecycles:
 *
 * - `ask`: the bot called `ask`, which ended its turn. The card stays open until
 *   the operator answers or dismisses it, however long that takes; either one
 *   wakes the bot again with the answer. In a room, archiving the room expires
 *   it.
 * - `engine`: the harness's own question tool held a running turn. Answering it
 *   lets that turn continue. It cannot be dismissed: the engine refuses that
 *   while the turn waits, so the turn goes on only once it is answered or
 *   stopped. It expires when its turn ends.
 */
export const QuestionEntry = Schema.TaggedStruct("question", {
  ...entry,
  origin: Schema.Literals(["ask", "engine"]),
  questions: Schema.NonEmptyArray(Question).check(Schema.isMaxLength(MAX_CARD_QUESTIONS)),
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("answered", { answers: QuestionAnswers }),
    /** The operator dismissed an `ask` question, which the bot reads as "no". */
    Schema.TaggedStruct("dismissed", {}),
    /**
     * Closed before an answer: an `engine` question when its turn ended, an
     * `ask` question when its room was archived. Answering it is refused.
     */
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type QuestionEntry = typeof QuestionEntry.Type;

export const ApprovalDecision = Schema.Literals(["allow-once", "allow-session", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

/** The most an approval's action or detail carries. */
export const APPROVAL_TEXT_LENGTH = 100_000;

/**
 * Text an approval shows as given, whitespace and all: never trimmed, so a
 * command's indentation and a diff's context lines reach the operator intact.
 * Never blank, and it ends with no line break.
 */
const ApprovalText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(APPROVAL_TEXT_LENGTH),
  Schema.isPattern(/\S/),
  Schema.isPattern(/[^\r\n]$/),
);

/**
 * An exact file change's text, with what the change does to the file, which
 * decides what the text is:
 * - `update`: the file changes in place, or moves; `text` is a unified diff.
 * - `add`: a new file; `text` is its contents.
 * - `delete`: the file goes; `text` is the contents it had.
 * - `null`: the engine did not say; `text` is shown as the provider gave it.
 *
 * Only a `update` is read as a diff: the contents of a file can start lines
 * with `+` or `-` too.
 */
export const ApprovalChange = Schema.Struct({
  operation: Schema.NullOr(Schema.Literals(["add", "delete", "update"])),
  text: ApprovalText,
});
export type ApprovalChange = typeof ApprovalChange.Type;

/**
 * What a grant for the session allows without asking again, for the rest of
 * the session, as the provider applies it: every later request of that kind,
 * whatever it runs or changes.
 */
export const SessionGrant = Schema.Struct({
  covers: Schema.Literals(["every-command", "every-file-change"]),
});
export type SessionGrant = typeof SessionGrant.Type;

/** The engine holds a running turn on it. It expires when that turn ends. */
export const ApprovalEntry = Schema.TaggedStruct("approval", {
  ...entry,
  kind: Schema.Literals(["command", "file-change", "file-read", "tool", "other"]),
  /**
   * What the operator decides on. When `exact`, the engine's own record of it:
   * the whole command, every line; or the changed files' paths, one per line.
   * Otherwise the provider's summary of it, which may leave things out. The
   * card always shows it.
   */
  action: ApprovalText,
  /**
   * Only with an exact file change of one file: the change, as the engine
   * gives it. Null otherwise.
   */
  detail: Schema.NullOr(ApprovalChange),
  /**
   * Why the bot or its provider asks, such as the escalation a sandboxed
   * command needs. Never the action itself. Null when nothing was said.
   */
  reason: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed(), Schema.isMaxLength(2_000)),
  ),
  /**
   * Whether `action` and `detail` are exactly what will run or change, taken
   * from the engine's structured record. False when the provider shared only a
   * summary: the card says so, shows it as prose, and offers no grant for the
   * session, so nothing unseen is allowed beyond this once.
   */
  exact: Schema.Boolean,
  /**
   * What "Allow for session" would allow from then on, when the card offers
   * it: only when `exact`, and the provider takes such a grant for this
   * approval and its scope is known. Null otherwise, and always for a summary,
   * since a grant allows again what nobody has seen exactly.
   */
  sessionGrant: Schema.NullOr(SessionGrant),
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("decided", { decision: ApprovalDecision }),
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type ApprovalEntry = typeof ApprovalEntry.Type;

/**
 * A bot needs a credential only the operator can give. The client shows a
 * masked input and sends the value with `secret.provide`, which hands it to the
 * engine. The value is never stored in J3 Bots, so this entry has no field for
 * it. It expires when the turn that asked ends.
 */
export const SecretRequestEntry = Schema.TaggedStruct("secret-request", {
  ...entry,
  /** What is being asked for, such as "GitHub token". */
  label: Label,
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  /** A page where the operator can get or create the value. */
  url: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  placeholder: Schema.NullOr(Label),
  status: Schema.Literals(["pending", "provided", "declined", "expired"]),
});
export type SecretRequestEntry = typeof SecretRequestEntry.Type;

/** How a turn ended, as the work fold shows it. */
export const TurnEnding = Schema.Literals(["completed", "interrupted", "failed"]);
export type TurnEnding = typeof TurnEnding.Type;

/** One turn's work, folded into a line. Its steps are read with `entries.workSteps`. */
export const WorkFoldEntry = Schema.TaggedStruct("work-fold", {
  ...entry,
  stepCount: NonNegativeInt,
  status: Schema.Union([
    Schema.TaggedStruct("running", {}),
    Schema.TaggedStruct("finished", { finishedAt: Schema.DateTimeUtc, ending: TurnEnding }),
  ]),
});
export type WorkFoldEntry = typeof WorkFoldEntry.Type;

/** A step replaces an earlier one with the same id: a running command, then its result. */
export const WorkStep = Schema.Struct({
  id: WorkStepId,
  kind: Schema.Literals([
    "command",
    "edit",
    "read",
    "search",
    "web",
    "tool",
    "delegation",
    "other",
  ]),
  label: Label,
  status: Schema.Literals(["running", "completed", "failed"]),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type WorkStep = typeof WorkStep.Type;

/** A quiet line where something stopped. Nothing is dropped silently. */
export const Notice = Schema.Union([
  /** A chain of bot-to-bot wakes hit a budget. */
  Schema.TaggedStruct("chain-stopped", { limit: Schema.Literals(["hops", "fan-out"]) }),
  /** A turn failed. Retryable with `notice.retry`. */
  Schema.TaggedStruct("turn-failed", { failure: FailureClass }),
  /**
   * Urgent teammate messages from `senders` never reached this bot: J3 Bots
   * gave up waking it with them. Retryable with `notice.retry`.
   */
  Schema.TaggedStruct("handoff-failed", { senders: Schema.NonEmptyArray(BotId) }),
  /** A turn the operator started ended twice without delivering anything. Retryable. */
  Schema.TaggedStruct("undelivered", {}),
  /** In a room: this bot is waiting on the operator in its own conversation. */
  Schema.TaggedStruct("waiting-in-conversation", { botId: BotId }),
  /**
   * The engine no longer has the bot's working session. Messages wait until
   * the bot is given a new one.
   */
  Schema.TaggedStruct("session-lost", {}),
  /**
   * The bot's new model or permission mode waits for background work its
   * session runs, which applying it would end; its messages wait too. A Stop
   * ends that work, and the change applies then.
   */
  Schema.TaggedStruct("settings-held", {}),
  /**
   * J3 Bots could not apply what the engine reported for the bot, and keeps
   * trying. What the bot shows may be behind until it succeeds.
   */
  Schema.TaggedStruct("observation-failed", {}),
  /**
   * Something the bot was to be told before its next turn (a teammate's held
   * message, what a routine said) was too long to pass on, and was left out.
   */
  Schema.TaggedStruct("too-long", {}),
  /**
   * J3 Bots paused one of the bot's routines because it could not read when
   * the routine runs next. The operator edits it to turn it back on.
   */
  Schema.TaggedStruct("routine-paused", { routineId: RoutineId, name: Label }),
]);
export type Notice = typeof Notice.Type;

export const NoticeEntry = Schema.TaggedStruct("notice", {
  ...entry,
  notice: Notice,
  /** Whether `notice.retry` is still accepted for it. */
  retryable: Schema.Boolean,
});
export type NoticeEntry = typeof NoticeEntry.Type;

/** Where a teammate message stands (`HandoffEntry.state`). */
export const HandoffState = Schema.Literals(["sent", "not-delivered", "stopped", "unconfirmed"]);
export type HandoffState = typeof HandoffState.Type;

/**
 * A bot sent a teammate a message. Both conversations show it: the sender's
 * as `sent`, the recipient's as `received`. Its author is the sender either
 * way. The reply arrives later, as its own turn.
 */
export const HandoffEntry = Schema.TaggedStruct("handoff", {
  ...entry,
  author: BotAuthor,
  recipientId: BotId,
  direction: Schema.Literals(["sent", "received"]),
  text: MessageText,
  urgent: Schema.Boolean,
  /**
   * Where the message stands, the same on both cards. `sent`: on its way or
   * read, which the cards do not tell apart; once read, it stays `sent`.
   * `not-delivered`: an urgent message J3 Bots gave up waking the recipient
   * with; the recipient's conversation has a `handoff-failed` notice that
   * sends it again, and it is `sent` again once it is, or when the engine
   * turns out to have taken it after all. `stopped`: the operator's Stop of
   * the sender ended it before the recipient read it, and nothing sends it
   * again. A Stop of the recipient never does: an urgent message it cancels
   * waits on as one the recipient reads in its next turn, and stays `sent`.
   * `unconfirmed`: the envelope that carried it was sent, and whether the
   * engine took it can no longer be learned; it is not carried again. Both
   * `stopped` and `unconfirmed` become `sent` when the engine turns out to
   * have taken it after all.
   */
  state: HandoffState,
});
export type HandoffEntry = typeof HandoffEntry.Type;

/** A routine was created or changed, by the bot or by the operator. */
export const RoutineChangeEntry = Schema.TaggedStruct("routine-change", {
  ...entry,
  routineId: RoutineId,
  name: Label,
  change: Schema.Literals(["created", "updated", "paused", "resumed", "deleted"]),
  /** The trigger as saved by this change. */
  trigger: RoutineTrigger,
});
export type RoutineChangeEntry = typeof RoutineChangeEntry.Type;

export const Entry = Schema.Union([
  MessageEntry,
  QuestionEntry,
  ApprovalEntry,
  SecretRequestEntry,
  WorkFoldEntry,
  NoticeEntry,
  HandoffEntry,
  RoutineChangeEntry,
]);
export type Entry = typeof Entry.Type;

/** The most text an `EntryPreview` carries. */
export const PREVIEW_LENGTH = 200;

/**
 * The text an entry leads with, which its preview carries: the message, the
 * first question, the action, what is asked for, the routine's name; empty
 * for an entry with no text of its own.
 */
export const entryText = (entry: Entry): string => {
  switch (entry._tag) {
    case "message":
    case "handoff":
      return entry.text;
    case "question":
      return entry.questions[0].prompt;
    case "approval":
      return entry.action;
    case "secret-request":
      return entry.label;
    case "routine-change":
      return entry.name;
    case "work-fold":
    case "notice":
      return "";
  }
};

/**
 * What the roster shows under a name: the latest entry, cut short. `text` is
 * the message, the question or the action, at most `PREVIEW_LENGTH` characters,
 * and empty for entries with no text of their own.
 */
export const EntryPreview = Schema.Struct({
  entryId: EntryId,
  kind: Schema.Literals([
    "message",
    "question",
    "approval",
    "secret-request",
    "work-fold",
    "notice",
    "handoff",
    "routine-change",
  ]),
  author: Author,
  text: Schema.String.check(Schema.isMaxLength(PREVIEW_LENGTH)),
  /** A teammate message's recipient; `null` for every other entry. */
  recipientId: Schema.NullOr(BotId),
  createdAt: Schema.DateTimeUtc,
});
export type EntryPreview = typeof EntryPreview.Type;
