// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { Attachment, AttachmentOffsets } from "./attachment.ts";
import {
  BotId,
  CommandId,
  ConnectorId,
  EntryId,
  EntryOrder,
  Label,
  NonNegativeInt,
  OpenLiterals,
  RoomId,
  RoutineId,
  UnknownLiteral,
  WorkImageId,
  WorkStepId,
} from "./base.ts";
import { FailureClass, FailureDetails, PermissionMode, ReceivedFailureClass } from "./bot.ts";
import { BrowserTabRef } from "./browser.ts";
import { ConnectorGlyph, ListingRef, SetupPageUrl } from "./connector.ts";
import { Elicitation } from "./elicitation.ts";
import { ConnectorAppRef, MAX_CONNECTOR_APPS_PER_FOLD } from "./connectorApp.ts";
import {
  EVENT_STOP_REASONS,
  EventTrigger,
  OwnTrigger,
  RoutineRun,
  RoutineStep,
} from "./routine.ts";
import { CredentialFill, SiteOrigin } from "./secrets.ts";
import { Visual } from "./visual.ts";
import { StepSkill, StepTool, TurnWork, WorkStepKind } from "./work.ts";

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

/** The most characters of an app's name `LookingAt` holds. */
export const MAX_LOOKING_AT_APP_LENGTH = 100;
/** The most characters of a window's title `LookingAt` holds. */
export const MAX_LOOKING_AT_TITLE_LENGTH = 300;

/** A line break, a tab or any other control character, which one line of `LookingAt` cannot hold. */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** One line of `LookingAt`: trimmed, not empty, at most `max` characters. */
const lookingAtLine = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter((line: string) =>
      line !== line.trim() || NOT_ONE_LINE.test(line)
        ? "One line, trimmed, with no control character."
        : true,
    ),
  );

/**
 * The window the operator was in when they opened quick access, as its chip
 * showed it when they sent the message: the app's name, and the window's
 * title unless they turned titles off. The operator's computer reads both
 * from the other app, which writes them as it likes (a web page names its
 * own tab), so they are information about the message, never words of the
 * operator's.
 */
export const LookingAt = Schema.Struct({
  app: lookingAtLine(MAX_LOOKING_AT_APP_LENGTH),
  title: Schema.optionalKey(lookingAtLine(MAX_LOOKING_AT_TITLE_LENGTH)),
});
export type LookingAt = typeof LookingAt.Type;

/**
 * Whom a room message is for. In a conversation it is always `bots` with no
 * ids: what a message there names is `conversationMentions`. Every member reads every room message in its next turn; the mentions
 * say whom it wakes now.
 */
export const Mentions = Schema.Union([
  /**
   * These members, in the order named, and only they are woken, each told it
   * is addressed. No ids: nobody in particular, which wakes every member but
   * the author.
   */
  Schema.TaggedStruct("bots", { ids: Schema.Array(BotId).check(Schema.isMaxLength(6)) }),
  /** Every member but the author is woken and asked to answer. */
  Schema.TaggedStruct("everyone", {}),
]);
export type Mentions = typeof Mentions.Type;

/** The most bots and rooms one message in a bot's conversation mentions. */
export const MAX_CONVERSATION_MENTIONS = 6;

/**
 * A bot or a room the operator's message mentions in a bot's own
 * conversation (decision 0092): another of their bots, or a room that bot is
 * a member of. A mention there is a reference, not a delivery: it wakes,
 * notifies and writes to nobody but the conversation's bot, which reads each
 * one resolved beside the message and acts on the words.
 */
export const ConversationMention = Schema.Union([
  Schema.TaggedStruct("bot", { botId: BotId }),
  Schema.TaggedStruct("room", { roomId: RoomId }),
]);
export type ConversationMention = typeof ConversationMention.Type;

/** A message's conversation mentions, in the order named, each once. */
export const ConversationMentions = Schema.Array(ConversationMention).check(
  Schema.isMaxLength(MAX_CONVERSATION_MENTIONS),
);

/** The most UTF-16 code units one reaction's emoji takes: a long ZWJ sequence fits. */
export const MAX_REACTION_LENGTH = 32;

/**
 * One emoji a person or a bot reacts with. The contract bounds it and keeps it
 * to one line with no space; the server takes only a single emoji, which
 * needs Unicode's emoji sequences to tell, and the clients render what it
 * sends.
 */
export const ReactionEmoji = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_REACTION_LENGTH),
  Schema.makeFilter((emoji: string) =>
    /[\p{Cc}\p{Z}]/u.test(emoji) ? "One emoji, with no space or control character." : true,
  ),
).pipe(Schema.brand("ReactionEmoji"));
export type ReactionEmoji = typeof ReactionEmoji.Type;

/** Who reacted: the operator, or a bot, whose id outlives it as an author's does. */
export const Reactor = Schema.Union([Schema.TaggedStruct("operator", {}), BotAuthor]);
export type Reactor = typeof Reactor.Type;

/**
 * One reaction on a message. Each person and each bot has at most one on a
 * message: picking another emoji replaces it.
 */
export const Reaction = Schema.Struct({ emoji: ReactionEmoji, by: Reactor });
export type Reaction = typeof Reaction.Type;

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
  /**
   * Where the operator placed each file in `text` (`AttachmentOffsets`).
   * Left out, as for a message sent without places or written by a bot, the
   * files follow the text.
   */
  attachmentOffsets: Schema.optionalKey(AttachmentOffsets),
  mentions: Mentions,
  /**
   * The bots and rooms the operator's message mentions in a bot's
   * conversation (`ConversationMention`). Absent from every other message,
   * and from a server that predates them, which a client then shows as the
   * plain text it is.
   */
  conversationMentions: Schema.optionalKey(ConversationMentions),
  /** Whether it reached its recipients. Messages written by bots are always `delivered`. */
  delivery: MessageDelivery,
  /** The operator's command that created it, so a client can replace its optimistic copy. */
  commandId: Schema.NullOr(CommandId),
  /**
   * A page a bot showed above its words: a chart, a table, a diagram or a
   * mockup, which clients render in a sandboxed frame with no network
   * (docs/architecture/clients.md, "Visuals"). Absent from every other
   * message.
   */
  visual: Schema.optionalKey(Visual),
  /**
   * The window the operator was looking at as they wrote it from quick
   * access, which the message went with. Absent from every other message,
   * and from a server that predates it.
   */
  lookingAt: Schema.optionalKey(LookingAt),
  /**
   * The reactions on it, in the order each reactor first reacted. A server
   * that has reactions sends it with every message, empty for none, and a
   * client offers to react only on a message that carries it: a server that
   * predates reactions leaves it out, and has no `message.react`.
   */
  reactions: Schema.optionalKey(Schema.Array(Reaction)),
});
export type MessageEntry = typeof MessageEntry.Type;

export const QuestionOption = Schema.Struct({
  id: Label,
  label: Label,
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
  /** `recommended` marks the option the bot suggests; `destructive`, one that loses something. */
  style: Schema.Literals(["default", "recommended", "destructive"]),
  /**
   * What choosing the option would look like, as the harness's own question
   * tool shows it beside the option: a sketch, a layout or a few lines of
   * code, shown as written, in a fixed-width block. Absent for most options,
   * and from a server that predates it.
   */
  preview: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type QuestionOption = typeof QuestionOption.Type;

/** The most options one question of `QuestionEntry.questions` holds. */
export const MAX_QUESTION_OPTIONS = 6;
/** The most questions `QuestionEntry.questions` holds. */
export const MAX_CARD_QUESTIONS = 4;

const questionFields = {
  id: Label,
  /**
   * A few words naming what the question is about, shown over it, as the
   * harness's own question tool gives one. Absent from a bot's `ask`, and from
   * a server that predates it.
   */
  header: Schema.optionalKey(Label),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  /** Whether a typed answer is accepted besides the options. */
  acceptsText: Schema.Boolean,
  /** Whether more than one option may be chosen. */
  multiple: Schema.Boolean,
};

export const Question = Schema.Struct({
  ...questionFields,
  options: Schema.Array(QuestionOption).check(Schema.isMaxLength(MAX_QUESTION_OPTIONS)),
});
export type Question = typeof Question.Type;

/** A question with any number of options, as the harness's own question tool may ask one. */
export const WholeQuestion = Schema.Struct({
  ...questionFields,
  options: Schema.Array(QuestionOption),
});
export type WholeQuestion = typeof WholeQuestion.Type;

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
  /**
   * The card's questions, within what every client shows: at most
   * `MAX_CARD_QUESTIONS`, each with at most `MAX_QUESTION_OPTIONS` options.
   * When `whole` is set, a single question that takes no answer, saying the
   * app needs an update to answer it: what a client that predates `whole`
   * shows, since one refuses a card past those limits.
   */
  questions: Schema.NonEmptyArray(Question).check(Schema.isMaxLength(MAX_CARD_QUESTIONS)),
  /**
   * An `engine` question past `questions`' limits, whole: more questions, or a
   * question with more options. Clients show these in place of `questions`
   * (`cardQuestions`), and the server takes answers to these.
   */
  whole: Schema.optionalKey(Schema.NonEmptyArray(WholeQuestion)),
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

/** The questions a card asks and takes answers to: `whole` when it is set, else `questions`. */
export const cardQuestions = (
  entry: Pick<QuestionEntry, "questions" | "whole">,
): readonly [WholeQuestion, ...Array<WholeQuestion>] => entry.whole ?? entry.questions;

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

/** The most values one secret request asks for. */
export const MAX_SECRET_REQUEST_FIELDS = 8;

/**
 * A value's place on a secret request card: `field-1` for the first, up to
 * `field-8`. J3 Bots' own, stable for the request; the engine adapter maps an
 * answer back to the names the bot asked with.
 */
export const SecretRequestFieldId = Schema.String.check(Schema.isPattern(/^field-[1-8]$/)).pipe(
  Schema.brand("SecretRequestFieldId"),
);
export type SecretRequestFieldId = typeof SecretRequestFieldId.Type;

/** One value a secret request asks for, such as "Email" or "Password". */
export const SecretRequestField = Schema.Struct({
  id: SecretRequestFieldId,
  label: Label,
  placeholder: Schema.NullOr(Label),
  /** Whether what is typed is hidden, as for a password. False shows it, as for an email. */
  masked: Schema.Boolean,
});
export type SecretRequestField = typeof SecretRequestField.Type;

/**
 * Where a secret request's values go once sent:
 * - `reference`: a store the bot reaches only through a one-use reference, so
 *   the bot uses the value without seeing it.
 * - `file`: private files, one per value, that the bot's commands can read
 *   for 24 hours.
 *
 * Open: a client shows no promise for a way it does not know.
 */
export const SecretDelivery = OpenLiterals(["reference", "file"]);
export type SecretDelivery = typeof SecretDelivery.Type;

/** The longest value a secret request takes, in UTF-16 code units. */
export const MAX_SECRET_REQUEST_VALUE_LENGTH = 10_000;

/**
 * A value typed into a secret request card: 1 to 10,000 characters, at least
 * one of them not a space, redacted as soon as it is decoded and checked only
 * then, so neither a refused value nor a log of the request prints it.
 */
export const SecretRequestValue = Schema.Redacted(Schema.String).check(
  Schema.makeFilter(
    (value: Redacted.Redacted<string>) => {
      const text = Redacted.value(value);
      return text.length <= MAX_SECRET_REQUEST_VALUE_LENGTH && text.trim() !== "";
    },
    { expected: "a value of 1 to 10,000 characters that is not only spaces" },
  ),
);

/**
 * A bot needs credentials only the operator can give. The client shows an
 * input per value and sends them with `secret.provide`, which hands them to
 * the engine. No value is stored in J3 Bots, so this entry has no field for
 * one. It expires when the turn that asked ends, or when the bot stops
 * waiting for it.
 */
export const SecretRequestEntry = Schema.TaggedStruct("secret-request", {
  ...entry,
  /** What is being asked for, such as "GitHub token" or "Sign in to Mail". */
  label: Label,
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  /** A page where the operator can get or create the value. */
  url: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  /** The hint in the input of a request for one value; null for a request with `fields`. */
  placeholder: Schema.NullOr(Label),
  /**
   * The values asked for, in order. Empty for a request for one masked value,
   * which `label` names: the only kind a server before 0.12.0 sent.
   */
  fields: Schema.Array(SecretRequestField)
    .check(Schema.isMaxLength(MAX_SECRET_REQUEST_FIELDS))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  delivery: SecretDelivery.pipe(Schema.withDecodingDefaultKey(Effect.succeed("reference"))),
  status: Schema.Literals(["pending", "provided", "declined", "expired"]),
});
export type SecretRequestEntry = typeof SecretRequestEntry.Type;

/** The id of the field in `position` (0 for the first) on a secret request card. */
export const secretRequestFieldId = (position: number): SecretRequestFieldId =>
  SecretRequestFieldId.make(`field-${position + 1}`);

/**
 * The operator's answer to a secret request (`secret.provide`): the one value
 * of a request for one, a value for each field of a request with `fields`, or
 * a decline.
 */
export const SecretRequestAnswer = Schema.Union([
  Schema.TaggedStruct("provide", { value: SecretRequestValue }),
  Schema.TaggedStruct("provide-fields", {
    values: Schema.Record(SecretRequestFieldId, SecretRequestValue),
  }),
  Schema.TaggedStruct("decline", {}),
]);
export type SecretRequestAnswer = typeof SecretRequestAnswer.Type;

/**
 * Whether `answer` gives a value for exactly the values a secret request with
 * `fields` asks for: one value (`provide`) for a request without fields or
 * with one, else a value for each field and no other (`provide-fields`). A
 * decline always fits.
 */
export const answersSecretRequest = (
  fields: ReadonlyArray<Pick<SecretRequestField, "id">>,
  answer: SecretRequestAnswer,
): boolean => {
  switch (answer._tag) {
    case "decline":
      return true;
    case "provide":
      return fields.length <= 1;
    case "provide-fields":
      return (
        fields.length > 0 &&
        Object.keys(answer.values).length === fields.length &&
        fields.every((field) => Object.hasOwn(answer.values, field.id))
      );
  }
};

/**
 * What a bot met in its browser that only the operator can get past: a check
 * that a person is at the keyboard (`captcha`), a sign-in it has no
 * credential for (`login`), a one-time code (`two-factor`), a code to scan
 * with a phone (`qr-code`), a passkey, or something else (`other`).
 */
export const BrowserHelpReason = Schema.Literals([
  "captcha",
  "login",
  "two-factor",
  "qr-code",
  "passkey",
  "other",
]);
export type BrowserHelpReason = typeof BrowserHelpReason.Type;

/** The most characters a browser help card's note holds. */
export const MAX_BROWSER_HELP_NOTE_LENGTH = 500;

/**
 * A bot asks the operator to do one step in its browser for it. Asking ended
 * the bot's turn; the card stays open until the operator says the step is
 * done or that they cannot do it, either of which gives the tab back to the
 * bot and wakes it, or until it expires.
 */
export const BrowserHelpEntry = Schema.TaggedStruct("browser-help", {
  ...entry,
  author: BotAuthor,
  reason: BrowserHelpReason,
  /** What the bot needs, in its own words. */
  note: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_BROWSER_HELP_NOTE_LENGTH),
  ),
  /** The host name of the page the tab was on ("example.com"); empty when it had none. */
  site: Schema.String.check(Schema.isMaxLength(253)),
  /**
   * The tab the step is in. A ref names a tab only while the server that
   * minted it runs, so after a restart a client opens the bot's front tab.
   */
  tab: BrowserTabRef,
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    /** The operator did the step. */
    Schema.TaggedStruct("done", {}),
    /** The operator could not do it. */
    Schema.TaggedStruct("declined", {}),
    /**
     * Closed before the operator answered: the tab closed (`tab-closed`), as
     * the engine closes one nobody used for a while, or the card waited too
     * long (`timed-out`). The bot is told either way.
     */
    Schema.TaggedStruct("expired", { cause: Schema.Literals(["tab-closed", "timed-out"]) }),
  ]),
});
export type BrowserHelpEntry = typeof BrowserHelpEntry.Type;

/** The most characters a bot's note on an ask for a secret holds. */
export const MAX_SECRET_ASK_NOTE_LENGTH = 500;

/** The fewest and the most values one ask for secrets takes on its card. */
export const MIN_SECRET_ASK_VALUES = 2;
export const MAX_SECRET_ASK_VALUES = 4;

/**
 * One of the values a bot asks for together, each saved as a single value
 * under its own name: a service's client ID and its client secret, say.
 */
export const SecretAskValue = Schema.Struct({
  /** Its place on the card, `field-1` for the first, which the answer names it by. */
  id: SecretRequestFieldId,
  /** The name it is saved under, which the bot names it by (`secret:<name>`). */
  name: Label,
  /** What the operator reads above its input, such as "Client ID". */
  label: Label,
  /** Whether what is typed is hidden. False shows it, as for an identifier that is not secret. */
  masked: Schema.Boolean,
});
export type SecretAskValue = typeof SecretAskValue.Type;

/**
 * A bot asks the operator for a secret: a login for a site, or a single value
 * such as a token, or a few values that go together, each saved as a single
 * value. The client sends what the operator types with `secrets.add`
 * (`secrets.addFromAsk` for an ask with `values`), naming this card, straight
 * to the server: it never passes through the bot, and this entry has no field
 * for it. Saving, declining (`card.answer` with `dismiss`) or expiring closes
 * it and wakes the bot with the outcome, and once saved, with the secrets'
 * references.
 */
export const SecretAskEntry = Schema.TaggedStruct("secret-ask", {
  ...entry,
  author: BotAuthor,
  /**
   * The name the secret is saved under, which the bot asked for and names
   * it by (`secret:<name>`). A save-login card from before secrets shows the
   * name it was saved under, or its site. For an ask with `values`, the
   * first value's.
   */
  name: Label,
  secret: Schema.Union([
    /** A login for the site at `origin`, where the bot needs to sign in. */
    Schema.TaggedStruct("login", { origin: SiteOrigin }),
    Schema.TaggedStruct("value", {}),
  ]),
  /**
   * The values asked for together, in order, for a `value` ask that takes
   * several on one card; absent for an ask for one secret. A client that
   * does not know it shows one input, and the server refuses that answer
   * (`Invalid("answer")`).
   */
  values: Schema.optionalKey(
    Schema.Array(SecretAskValue).check(
      Schema.isMinLength(MIN_SECRET_ASK_VALUES),
      Schema.isMaxLength(MAX_SECRET_ASK_VALUES),
    ),
  ),
  /**
   * Where the service issues what is asked for, when the bot knows it, which
   * the card links to: a page of the service's own settings, say.
   */
  setup: Schema.optionalKey(SetupPageUrl),
  /** Why the bot needs it, in its own words. */
  note: Schema.String.check(Schema.isMaxLength(MAX_SECRET_ASK_NOTE_LENGTH)),
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("saved", {}),
    Schema.TaggedStruct("declined", {}),
    /** Closed before the operator answered. */
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type SecretAskEntry = typeof SecretAskEntry.Type;

/**
 * A connector a bot called needs the operator to sign in again, in that bot's
 * conversation: written once each time the connector's sign-in ends, by the
 * first call that finds it so, and authored by that bot. Its button opens the
 * sign-in. It closes as `signed-in` once the connector works again, and as
 * `removed` when the operator removes it.
 */
export const ConnectorAuthEntry = Schema.TaggedStruct("connector-auth", {
  ...entry,
  author: BotAuthor,
  connectorId: ConnectorId,
  name: Label,
  glyph: Schema.NullOr(ConnectorGlyph),
  status: Schema.Literals(["pending", "signed-in", "removed"]),
});
export type ConnectorAuthEntry = typeof ConnectorAuthEntry.Type;

/**
 * A bot asks the operator's word before it adds a connector that needs it
 * (decision 0068): one at an address in the operator's own network, which
 * the card names, or a gallery entry that signs in with an app the operator
 * registers at the service, whose client the card takes, with the steps to
 * register it. Only the operator's
 * answer (`card.answer` with `connector-ask`) adds it, as the bot asked; the
 * client's secret goes to the server's secrets and never to the bot. Decline
 * is `card.answer` with `dismiss`. Each close wakes the bot with the outcome.
 */
export const ConnectorAskEntry = Schema.TaggedStruct("connector-ask", {
  ...entry,
  author: BotAuthor,
  /** The connector's name, as it would be added. */
  name: Label,
  glyph: Schema.NullOr(ConnectorGlyph),
  ask: Schema.Union([
    /** The address's host, and its port when it names one, such as `192.168.1.20:8123`. */
    Schema.TaggedStruct("private-network", { host: Schema.String.check(Schema.isMaxLength(300)) }),
    /**
     * The gallery entry: the client reads its setup steps, in the operator's
     * language, and where its sign-ins return with `connectors.get`.
     */
    Schema.TaggedStruct("own-app", { listing: ListingRef }),
  ]),
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("added", { connectorId: ConnectorId }),
    Schema.TaggedStruct("declined", {}),
    /** The operator said yes and the add still failed; the bot is told why. */
    Schema.TaggedStruct("failed", {}),
    /** Closed before the operator answered. */
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type ConnectorAskEntry = typeof ConnectorAskEntry.Type;

/**
 * A connector's server asks the operator for something in the middle of a
 * bot's call (MCP elicitation, decision 0047): a short form, or a page of its
 * own to open on the operator's device. It is in the conversation of the bot
 * whose call asked, authored by that bot, and the call waits on it. The
 * answer goes to the server only (`card.answer` with `connector-input`); the
 * bot never reads it. It closes as `expired` when the call ends first: the
 * bot's turn stopped, or the call ran out of time.
 */
export const ConnectorInputEntry = Schema.TaggedStruct("connector-input", {
  ...entry,
  author: BotAuthor,
  connectorId: ConnectorId,
  /** The connector's name and glyph when the card was written, which it keeps. */
  name: Label,
  glyph: Schema.NullOr(ConnectorGlyph),
  request: Elicitation,
  status: Schema.Union([
    Schema.TaggedStruct("pending", {}),
    Schema.TaggedStruct("answered", { action: Schema.Literals(["accept", "decline", "cancel"]) }),
    Schema.TaggedStruct("expired", {}),
  ]),
});
export type ConnectorInputEntry = typeof ConnectorInputEntry.Type;

/** How a turn ended, as the work fold shows it. */
export const TurnEnding = Schema.Literals(["completed", "interrupted", "failed"]);
export type TurnEnding = typeof TurnEnding.Type;

/**
 * One turn's work, folded into a line that says how the turn ended and how
 * many steps it took. Its steps are read with `entries.workSteps`, work the
 * turn handed off among them. A turn stopped or failed before its first step
 * has a fold of no steps, so how it ended stays in the conversation.
 */
export const WorkFoldEntry = Schema.TaggedStruct("work-fold", {
  ...entry,
  /**
   * When the fold's turn started, the time a working bot's state counts from
   * (`BotState` `since`), which ties the fold to its turn. Null from a server,
   * or a fold, that predates it.
   */
  turnStartedAt: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  stepCount: NonNegativeInt,
  /**
   * The connectors' apps the turn's tool calls opened, in the order they
   * were called, at most `MAX_CONNECTOR_APPS_PER_FOLD`: a client draws each
   * under the fold's line, open or not. Empty from a server, or a fold, that
   * predates them.
   */
  apps: Schema.Array(ConnectorAppRef)
    .check(Schema.isMaxLength(MAX_CONNECTOR_APPS_PER_FOLD))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /**
   * The turn's plan and little ones, as they stand or as the turn left them,
   * for a turn whose audience is this conversation. Null for a turn that had
   * neither, for a room's turn, whose plan and little ones show only in the
   * room (`Room.memberWork`), and from a server, or a fold, that predates it.
   */
  work: Schema.NullOr(TurnWork).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  status: Schema.Union([
    Schema.TaggedStruct("running", {}),
    Schema.TaggedStruct("finished", {
      finishedAt: Schema.DateTimeUtc,
      ending: TurnEnding,
    }),
  ]),
});
export type WorkFoldEntry = typeof WorkFoldEntry.Type;

/** A step replaces an earlier one with the same id: a running command, then its result. */
export const WorkStep = Schema.Struct({
  id: WorkStepId,
  kind: WorkStepKind,
  /**
   * For a `tool` step, the tool in J3 Bots' words, which a client shows in
   * place of the label; `null` for a tool it cannot name, and for every other
   * kind.
   */
  tool: StepTool,
  /**
   * The step in one line: a command, a path, a search. A client says the
   * step in plain words from its kind and tool, and shows this only as the
   * step's detail, one step in. For a tool J3 Bots names, a short English
   * phrase, for a client that predates `tool`; for a tool it cannot name,
   * the tool's own name made readable, which a client says.
   */
  label: Label,
  status: Schema.Literals(["running", "completed", "failed"]),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** For a `login` step, the fill it made or refused. */
  fill: Schema.optionalKey(CredentialFill),
  /** For a `connector-skill` step, the skill it loads; absent when it could not be named. */
  skill: Schema.optionalKey(StepSkill),
  /**
   * For a call to a connector's tool: the connector, and the tool's `_meta.ui`
   * as its server listed it (MCP Apps), null when it has none.
   */
  connector: Schema.optionalKey(
    Schema.Struct({ connectorId: ConnectorId, ui: Schema.NullOr(Schema.JsonObject) }),
  ),
  /**
   * While the step runs, what it last said of how far it got: a connector's
   * progress or its task's status, cleaned, on one line.
   */
  progress: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /**
   * An image the step looked at in the bot's workspace, such as a screenshot
   * it read: a client shows it small in the step and large when opened, from
   * `GET /work-images/<id>`. The file may have changed or gone since; then
   * the image cannot be had.
   */
  image: Schema.optionalKey(Schema.Struct({ id: WorkImageId })),
});
export type WorkStep = typeof WorkStep.Type;

/** What a client needs to say a step in a line: its kind, its tool, its label and the skill it loads. */
export const StepSummary = WorkStep.mapFields(({ kind, tool, label, skill }) => ({
  kind,
  tool,
  label,
  skill,
}));
export type StepSummary = typeof StepSummary.Type;

/**
 * The bot's AI asks the operator before acting, although its permission mode
 * (`permissionMode`) would have it act on its own: the AI's own settings, its
 * account or its model do not allow that mode on the computer running
 * J3 Bots, so each action waits for an approval card. Shown once per working
 * session, in the bot's own conversation, where those cards are (decision
 * 0083). `details` is what the engine said of it, technical and scrubbed of
 * secrets, which clients show only behind "Details".
 */
export const AsksBeforeActing = Schema.TaggedStruct("asks-before-acting", {
  permissionMode: Schema.Literals(["auto", "full-access"]),
  details: Schema.optionalKey(FailureDetails),
});
export type AsksBeforeActing = typeof AsksBeforeActing.Type;

/**
 * Every kind of notice, with the failure class a failed turn's notice takes:
 * the closed one where the server writes, the open one where a client reads.
 */
const notices = <Failure extends Schema.Top>(failure: Failure) =>
  [
    /**
     * Bots talking among themselves hit a limit: a chain of teammate
     * messages its `hops` or `fan-out` budget, or a room `ROOM_QUIET_ROUND`
     * rounds of its bots answering each other since the operator's word last
     * reached it (`room`), after which their messages there wake nobody
     * until it reaches it again.
     */
    Schema.TaggedStruct("chain-stopped", {
      limit: Schema.Literals(["hops", "fan-out", "room"]),
    }),
    /**
     * A turn failed. Retryable with `notice.retry`. `details` is what the
     * engine said of the failure, technical and scrubbed of secrets, which
     * clients show only behind "Details". Absent when the engine said
     * nothing, and from a server that predates it.
     */
    Schema.TaggedStruct("turn-failed", {
      failure,
      details: Schema.optionalKey(FailureDetails),
    }),
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
    /**
     * The bot saved the name the operator asked to be called by, which every
     * bot uses from then on (`Settings.operatorName`). Settings shows it and
     * changes it.
     */
    Schema.TaggedStruct("operator-named", { botId: BotId, name: Label }),
    /**
     * Bot `botId` started room `roomId` on the operator's word, with the
     * room's first message. Shown in the room, at its start, and in the
     * bot's own conversation.
     */
    Schema.TaggedStruct("room-started", { botId: BotId, roomId: RoomId }),
    /**
     * In a bot's own conversation, at its start: bot `botId` created it for
     * room `roomId`, where it opens instead of greeting here.
     */
    Schema.TaggedStruct("made-for-room", { botId: BotId, roomId: RoomId }),
    AsksBeforeActing,
  ] as const;

/**
 * A quiet line where something stopped, or where a bot changed something the
 * operator should know about. Nothing is dropped silently.
 */
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
  /** The trigger as saved by this change: a schedule, a time or a webhook. */
  trigger: OwnTrigger,
  /**
   * The steps as saved by this change, for a routine with several steps:
   * the card draws its track. Absent for a one-step routine, a deletion, and
   * from a server that predates steps.
   */
  steps: Schema.optionalKey(Schema.Array(RoutineStep)),
});
export type RoutineChangeEntry = typeof RoutineChangeEntry.Type;

/** What can happen to a routine whose trigger is a connector's event, as its conversation shows it. */
export const EVENT_ROUTINE_CHANGES = [
  "created",
  "updated",
  "paused",
  "resumed",
  "deleted",
  "stopped",
] as const;

/**
 * A routine whose trigger is a connector's event was created or changed, by
 * the bot or by the operator. A kind of its own, not `routine-change`: a
 * client of protocol 11 built before 0.13.0 reads `routine-change`'s trigger
 * as a schedule, a time or a webhook only, so it would refuse the whole
 * conversation for one it does not know, while an entry of a kind it does not
 * know it passes over (docs/architecture/clients.md, "Protocol compatibility").
 */
export const EventRoutineChangeEntry = Schema.TaggedStruct("event-routine-change", {
  ...entry,
  routineId: RoutineId,
  name: Label,
  /**
   * As `routine-change`'s, and `stopped`: J3 Bots stopped listening for the
   * event, for `stopped`'s reason. Open: a change a client does not know
   * decodes as `unknown`.
   */
  change: OpenLiterals(EVENT_ROUTINE_CHANGES),
  /** The trigger as saved by this change. */
  trigger: EventTrigger,
  /** As `routine-change`'s: the steps as saved by this change, for a routine with several. */
  steps: Schema.optionalKey(Schema.Array(RoutineStep)),
  /** The trigger's connector's name at this change; null when it was already removed. */
  connector: Schema.NullOr(Label),
  /** On a `stopped` change, why. */
  stopped: Schema.optionalKey(OpenLiterals(EVENT_STOP_REASONS)),
});
export type EventRoutineChangeEntry = typeof EventRoutineChangeEntry.Type;

/**
 * A run of a routine with several steps (decision 0080), in its owner's
 * conversation, which the server updates as the run moves: its steps, where
 * each stands, the yes it waits for, and how it ended. Its author is the
 * routine's owner.
 */
export const RoutineRunEntry = Schema.TaggedStruct("routine-run", {
  ...entry,
  author: BotAuthor,
  routineId: RoutineId,
  name: Label,
  /** A schedule, a time or a webhook: an event routine's run is an `event-routine-run`. */
  trigger: OwnTrigger,
  run: RoutineRun,
});
export type RoutineRunEntry = typeof RoutineRunEntry.Type;

/**
 * A run of an event routine with several steps: a `routine-run` whose
 * trigger is a connector's event. A kind of its own for the reason
 * `event-routine-change` is one: a client built before event routines reads
 * `routine-run`'s trigger as a schedule, a time or a webhook only, and passes
 * over a kind it does not know.
 */
export const EventRoutineRunEntry = Schema.TaggedStruct("event-routine-run", {
  ...entry,
  author: BotAuthor,
  routineId: RoutineId,
  name: Label,
  trigger: EventTrigger,
  /** The trigger's connector's name as the card was last brought up to date; null once it is removed. */
  connector: Schema.NullOr(Label),
  run: RoutineRun,
});
export type EventRoutineRunEntry = typeof EventRoutineRunEntry.Type;

export const Entry = Schema.Union([
  MessageEntry,
  QuestionEntry,
  ApprovalEntry,
  SecretRequestEntry,
  BrowserHelpEntry,
  SecretAskEntry,
  ConnectorAuthEntry,
  ConnectorInputEntry,
  ConnectorAskEntry,
  WorkFoldEntry,
  NoticeEntry,
  HandoffEntry,
  RoutineChangeEntry,
  EventRoutineChangeEntry,
  RoutineRunEntry,
  EventRoutineRunEntry,
]);
export type Entry = typeof Entry.Type;

/** Every kind of entry this build knows. */
const entryKinds = Entry.members.map((member) => member.fields._tag.schema.literal);

/** The kind of an entry this build knows, as the server stores it beside the entry. */
export const EntryKind = Schema.Literals(entryKinds);

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
  BrowserHelpEntry,
  SecretAskEntry,
  ConnectorAuthEntry,
  ConnectorInputEntry,
  ConnectorAskEntry,
  WorkFoldEntry,
  ReceivedNoticeEntry,
  HandoffEntry,
  RoutineChangeEntry,
  EventRoutineChangeEntry,
  RoutineRunEntry,
  EventRoutineRunEntry,
  UnknownEntry,
]);
export type ReceivedEntry = typeof ReceivedEntry.Type;

/** The most text an `EntryPreview` carries. */
export const PREVIEW_LENGTH = 200;

/**
 * The text an entry leads with, which its preview carries: the message, the
 * first question, the action, what is asked for (a credential's label, a
 * browser step's note), the name of a secret asked for, the connector a card is
 * about, the routine's name; empty
 * for an entry with no text of its own.
 */
export const entryText = (entry: Entry): string => {
  switch (entry._tag) {
    case "message":
    case "handoff":
      return entry.text;
    case "question":
      return cardQuestions(entry)[0].prompt;
    case "approval":
      return entry.action;
    case "secret-request":
      return entry.label;
    case "browser-help":
      return entry.note;
    case "secret-ask":
      return entry.name;
    case "connector-auth":
    case "connector-input":
    case "connector-ask":
      return entry.name;
    case "routine-change":
    case "event-routine-change":
    case "routine-run":
    case "event-routine-run":
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
  /**
   * The entry's place in its conversation or room: what `entries.markRead`
   * takes to mark everything there read from the roster. `null` from a
   * server that predates it.
   */
  order: Schema.NullOr(EntryOrder).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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
   * it runs, for every other entry, and from a server that predates it. A
   * failed turn's notice comes after its fold, so the roster previews that.
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
