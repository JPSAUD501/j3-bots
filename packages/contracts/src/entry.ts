// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { Attachment } from "./attachment.ts";
import {
  BotId,
  CommandId,
  EntryId,
  EntryOrder,
  Label,
  NonNegativeInt,
  OpenLiterals,
  RoomId,
  RoutineId,
  UnknownLiteral,
  WorkStepId,
} from "./base.ts";
import { FailureClass, PermissionMode, ReceivedFailureClass } from "./bot.ts";
import { RoutineTrigger } from "./routine.ts";
import { StepTool } from "./work.ts";

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
 *   busy, or the message waits on a budget). `behindOpening`: it waits behind
 *   the bot's hello, which waits for the bot's provider to be ready. Once the
 *   hello has gone to the engine, the field is left out and the message waits
 *   like any other.
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
  Schema.TaggedStruct("pending", { behindOpening: Schema.optionalKey(Schema.Literal(true)) }),
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
 *   stopped. It expires when its turn ends, and closes as `refused` when the
 *   engine refuses its answer.
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
    /**
     * An `engine` question whose answer the engine refused. The bot cannot
     * take another, and its turn waits until the operator stops it or it
     * ends; the bot can be asked again in a message.
     */
    Schema.TaggedStruct("refused", {}),
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
    /**
     * The engine refused the operator's decision. The bot cannot take
     * another, and its turn waits until the operator stops it or it ends.
     */
    Schema.TaggedStruct("refused", {}),
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

/**
 * One turn's work, folded into a line. Its steps are read with
 * `entries.workSteps`. The line says how long the bot worked: from the start
 * of its turn (`turnStartedAt`) to its end, less `waitedBeforeMs` and
 * `waitedMs`; from a server that predates `turnStartedAt`, from the fold's
 * first step, less `waitedMs`. A turn stopped or failed before its first step
 * has a fold of no steps, so how it ended stays in the conversation.
 */
export const WorkFoldEntry = Schema.TaggedStruct("work-fold", {
  ...entry,
  /**
   * When the fold's turn started, the time a working bot's state counts from
   * (`BotState` `since`), so the fold and the turn's clock agree. Null from a
   * server, or a fold, that predates it.
   */
  turnStartedAt: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  stepCount: NonNegativeInt,
  status: Schema.Union([
    Schema.TaggedStruct("running", {}),
    Schema.TaggedStruct("finished", {
      finishedAt: Schema.DateTimeUtc,
      ending: TurnEnding,
      /**
       * How long the turn waited on the operator after the fold was
       * written: for a card it asked them to answer (an approval, a
       * question, a credential), from the card's arrival until it closed.
       */
      waitedMs: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
      /**
       * How long the turn waited on the operator before its fold was written,
       * from `turnStartedAt`: kept apart from `waitedMs`, which counts from the
       * fold's creation as clients before `turnStartedAt` read it.
       */
      waitedBeforeMs: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
      /**
       * Work the turn handed off still runs, as the engine last reported:
       * a background task it started, say. The fold's steps go on changing
       * until it ends.
       */
      background: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
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
  /**
   * For a `tool` step, the tool in J3 Bots' words, which a client shows in
   * place of the label; `null` for a tool it cannot name, and for every other
   * kind.
   */
  tool: StepTool,
  /**
   * The step in one line: a command, a path, a search. For a tool J3 Bots
   * names, a short English phrase, for a client that predates `tool`.
   */
  label: Label,
  status: Schema.Literals(["running", "completed", "failed"]),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type WorkStep = typeof WorkStep.Type;

/** What a client needs to say a step in a line: its kind, its tool and its label. */
export const StepSummary = WorkStep.mapFields(({ kind, tool, label }) => ({ kind, tool, label }));
export type StepSummary = typeof StepSummary.Type;

/**
 * Every kind of notice, with the failure class a failed turn's notice takes:
 * the closed one where the server writes, the open one where a client reads.
 */
const notices = <Failure extends Schema.Top>(failure: Failure) =>
  [
    /** A chain of bot-to-bot wakes hit a budget. */
    Schema.TaggedStruct("chain-stopped", { limit: Schema.Literals(["hops", "fan-out"]) }),
    /** A turn failed. Retryable with `notice.retry`. */
    Schema.TaggedStruct("turn-failed", { failure }),
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
     * J3 Bots could not open the bot's working session, or bring it to the
     * bot's settings, several times in a row, and keeps trying. Messages wait
     * until it is ready. A model the engine no longer offers keeps it so until
     * the operator chooses another.
     */
    Schema.TaggedStruct("session-not-ready", {}),
    /**
     * The engine refuses the bot's permission mode, as an administrator's
     * policy on its machine can, so the bot cannot start, cannot take its new
     * settings, or cannot run a turn in the mode it has. `allowed` is the
     * highest mode the policy allows, when the engine names one. Messages wait
     * until the operator chooses a lower permission mode, or raises the
     * policy's limit and restarts J3 Bots.
     */
    Schema.TaggedStruct("permission-mode-refused", {
      permissionMode: PermissionMode,
      allowed: Schema.NullOr(PermissionMode),
    }),
    /**
     * In a room, at the time it was written: the engine refused this member's
     * permission mode, so it took no part here from then until the operator
     * chose a lower one or raised the policy's limit. Its own conversation
     * says which modes. The rest of the room went on, and what was said to it
     * waited.
     */
    Schema.TaggedStruct("member-mode-refused", { botId: BotId }),
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
  ] as const;

/** A quiet line where something stopped. Nothing is dropped silently. */
export const Notice = Schema.Union(notices(FailureClass));
export type Notice = typeof Notice.Type;

/**
 * A notice of a kind added after this build, as a client receives it. The
 * client shows one line saying it needs a newer version of the app, and
 * offers no Try again: the operator could not tell what it would run again.
 */
export const UnknownNotice = Schema.Struct({
  _tag: UnknownLiteral(Notice.members.map((member) => member.fields._tag.schema.literal)),
}).pipe(
  Schema.decodeTo(Schema.toType(Schema.TaggedStruct("unknown", { kind: Schema.String })), {
    decode: SchemaGetter.transform(({ _tag }: { readonly _tag: string }) => ({
      _tag: "unknown" as const,
      kind: _tag,
    })),
    encode: SchemaGetter.transform(({ kind }: { readonly kind: string }) => ({ _tag: kind })),
  }),
);
export type UnknownNotice = typeof UnknownNotice.Type;

const retryable = {
  /** Whether `notice.retry` is still accepted for it. */
  retryable: Schema.Boolean,
};

/** A notice the server writes: always of a kind this build knows. */
export const NoticeEntry = Schema.TaggedStruct("notice", {
  ...entry,
  notice: Notice,
  ...retryable,
});
export type NoticeEntry = typeof NoticeEntry.Type;

/**
 * A notice entry as a client receives it, of any kind, known or not, and a
 * failed turn's of any failure class.
 */
export const ReceivedNoticeEntry = Schema.TaggedStruct("notice", {
  ...entry,
  notice: Schema.Union([...notices(ReceivedFailureClass), UnknownNotice]),
  ...retryable,
});
export type ReceivedNoticeEntry = typeof ReceivedNoticeEntry.Type;

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

/** Every kind of entry this build knows. */
const entryKinds = Entry.members.map((member) => member.fields._tag.schema.literal);

/** What keeps an entry in its place in a conversation. */
const placement = { id: EntryId, order: EntryOrder, createdAt: Schema.DateTimeUtc };

const UnknownEntryWire = Schema.Struct({ _tag: UnknownLiteral(entryKinds), ...placement });
const UnknownEntryValue = Schema.TaggedStruct("unknown", { kind: Schema.String, ...placement });

/**
 * An entry of a kind added after this build, as a client receives it: its
 * kind, and only what keeps it in its place, so the rest of the conversation
 * stays readable and the read mark can pass it. The client shows one line
 * saying it needs a newer version of the app.
 */
export const UnknownEntry = UnknownEntryWire.pipe(
  Schema.decodeTo(Schema.toType(UnknownEntryValue), {
    decode: SchemaGetter.transform(({ _tag: kind, ...placed }: typeof UnknownEntryWire.Type) => ({
      _tag: "unknown" as const,
      kind,
      ...placed,
    })),
    encode: SchemaGetter.transform(
      ({ kind, _tag: _, ...placed }: typeof UnknownEntryValue.Type) => ({ _tag: kind, ...placed }),
    ),
  }),
);
export type UnknownEntry = typeof UnknownEntry.Type;

/**
 * An entry as a client receives it. The kinds of entry, and of notice, stay
 * open: a server newer than the client may add one, which the client decodes
 * as `UnknownEntry` or `UnknownNotice` instead of refusing the conversation
 * that holds it (docs/architecture/clients.md, "Protocol compatibility").
 * The server only ever writes an `Entry`.
 */
export const ReceivedEntry = Schema.Union([
  MessageEntry,
  QuestionEntry,
  ApprovalEntry,
  SecretRequestEntry,
  WorkFoldEntry,
  ReceivedNoticeEntry,
  HandoffEntry,
  RoutineChangeEntry,
  UnknownEntry,
]);
export type ReceivedEntry = typeof ReceivedEntry.Type;

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

/** How a work fold's turn ended, once it has; null for a fold still running and every other entry. */
export const foldEnding = (entry: Entry): TurnEnding | null =>
  entry._tag === "work-fold" && entry.status._tag === "finished" ? entry.status.ending : null;

/**
 * What the roster shows under a name: the latest entry, cut short. `text` is
 * the message, the question or the action, at most `PREVIEW_LENGTH` characters,
 * and empty for entries with no text of their own.
 */
export const EntryPreview = Schema.Struct({
  entryId: EntryId,
  /** The entry's kind; `unknown` for one added after this build. */
  kind: OpenLiterals(entryKinds),
  author: Author,
  text: Schema.String.check(Schema.isMaxLength(PREVIEW_LENGTH)),
  /** A teammate message's recipient; `null` for every other entry. */
  recipientId: Schema.NullOr(BotId),
  /**
   * A work fold's last step, which says what the bot did; `null` for a fold
   * with none, for every other entry, and from a server that predates it.
   */
  step: Schema.NullOr(StepSummary).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * How a work fold's turn ended, once it has (`foldEnding`), so a fold of no
   * steps, a turn stopped or failed before its first, says so; `null` while
   * it runs, for every other entry, and from a server that predates it.
   */
  ending: Schema.NullOr(TurnEnding).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * A notice's own words, of any kind; `null` for every other entry, and
   * from a server that predates it.
   */
  notice: Schema.NullOr(ReceivedNoticeEntry.fields.notice).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Schema.DateTimeUtc,
});
export type EntryPreview = typeof EntryPreview.Type;
