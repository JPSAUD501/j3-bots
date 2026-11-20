import * as Schema from "effect/Schema";
import {
  AttachmentId,
  BotId,
  CommandId,
  EntryId,
  Label,
  NonNegativeInt,
  RoomId,
  RoutineId,
} from "./base.ts";
import { FailureClass } from "./bot.ts";
import { RoutineTrigger } from "./routine.ts";

/** Where entries live: a bot's conversation with the operator, or a room. */
export const EntryTarget = Schema.Union([
  Schema.TaggedStruct("conversation", { botId: BotId }),
  Schema.TaggedStruct("room", { roomId: RoomId }),
]);
export type EntryTarget = typeof EntryTarget.Type;

export const Author = Schema.Union([
  Schema.TaggedStruct("operator", {}),
  Schema.TaggedStruct("bot", { botId: BotId }),
  /** J3 Bots itself. */
  Schema.TaggedStruct("system", {}),
]);
export type Author = typeof Author.Type;

export const Attachment = Schema.Struct({
  id: AttachmentId,
  name: Label,
  mediaType: Label,
  /** Bytes. */
  size: NonNegativeInt,
});
export type Attachment = typeof Attachment.Type;

export const MessageText = Schema.String.check(Schema.isMaxLength(100_000));

const entry = {
  id: EntryId,
  author: Author,
  createdAt: Schema.DateTimeUtc,
};

export const MessageEntry = Schema.TaggedStruct("message", {
  ...entry,
  text: MessageText,
  attachments: Schema.Array(Attachment),
  /**
   * `pending`: recorded, and the bot has not received it yet (it is busy, or the
   * message waits on a budget). `delivered`: it reached the bot.
   * Messages written by bots are always `delivered`.
   */
  delivery: Schema.Literals(["pending", "delivered"]),
  /** The operator's command that created it, so a client can replace its optimistic copy. */
  commandId: Schema.NullOr(CommandId),
});
export type MessageEntry = typeof MessageEntry.Type;

export const QuestionOption = Schema.Struct({
  id: Label,
  label: Label,
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
});
export type QuestionOption = typeof QuestionOption.Type;

export const Question = Schema.Struct({
  id: Label,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  options: Schema.Array(QuestionOption).check(Schema.isMaxLength(6)),
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
 * `expired`: the turn that asked ended before an answer (stopped, failed, or the
 * engine dropped the request). Answering it is refused.
 */
export const QuestionEntry = Schema.TaggedStruct("question", {
  ...entry,
  questions: Schema.NonEmptyArray(Question).check(Schema.isMaxLength(4)),
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("answered", { answers: QuestionAnswers }),
    /** The operator dismissed it, which the bot reads as "no". */
    Schema.TaggedStruct("dismissed", {}),
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type QuestionEntry = typeof QuestionEntry.Type;

export const ApprovalDecision = Schema.Literals(["allow-once", "allow-session", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const ApprovalEntry = Schema.TaggedStruct("approval", {
  ...entry,
  kind: Schema.Literals(["command", "file-change", "file-read", "tool", "other"]),
  /** The exact action, in one line: the command, the file, the tool. */
  action: Label,
  /** The full command or change, when the one line cannot hold it. */
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(20_000))),
  /** Whether "Allow for session" is offered. */
  allowsSession: Schema.Boolean,
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("decided", { decision: ApprovalDecision }),
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type ApprovalEntry = typeof ApprovalEntry.Type;

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

export const WorkStep = Schema.Struct({
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
  /** A turn the operator started ended twice without delivering anything. Retryable. */
  Schema.TaggedStruct("undelivered", {}),
  /** In a room: this bot is waiting on the operator in its own conversation. */
  Schema.TaggedStruct("waiting-in-conversation", { botId: BotId }),
]);
export type Notice = typeof Notice.Type;

export const NoticeEntry = Schema.TaggedStruct("notice", {
  ...entry,
  notice: Notice,
  /** Whether `notice.retry` is still accepted for it. */
  retryable: Schema.Boolean,
});
export type NoticeEntry = typeof NoticeEntry.Type;

/** A bot sent a teammate a message. The reply arrives later, as its own turn. */
export const HandoffEntry = Schema.TaggedStruct("handoff", {
  ...entry,
  recipientId: BotId,
  text: MessageText,
  urgent: Schema.Boolean,
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
  WorkFoldEntry,
  NoticeEntry,
  HandoffEntry,
  RoutineChangeEntry,
]);
export type Entry = typeof Entry.Type;
