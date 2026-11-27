// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AttachmentOffsets, BotFile, MessageAttachments } from "./attachment.ts";
import { SkillRpcs } from "./skill.ts";
import { ThemeRpcs } from "./theme.ts";
import { VoiceRpcs } from "./voice.ts";
import {
  AttachmentId,
  BotId,
  CommandId,
  ConnectorId,
  DeviceId,
  EffortLevel,
  EntryId,
  EntryOrder,
  Label,
  Language,
  NonNegativeInt,
  ProviderId,
  RoomId,
  RoutineId,
  RoutineRunId,
  SectionId,
  Sequence,
} from "./base.ts";
import { AvatarChoice, Bot, ModelChoice, PermissionMode, Profile } from "./bot.ts";
import { BrowserTabs } from "./browser.ts";
import {
  CommandLine,
  Connector,
  ConnectorFieldValues,
  ConnectorGrant,
  ConnectorListing,
  ConnectorListingDetails,
  ConnectorPrompt,
  ConnectorSource,
  ListingRef,
  OAuthClientInput,
  PromptArguments,
  SignInCallback,
  SignInRedirect,
  SignInStarted,
} from "./connector.ts";
import {
  ConnectorAppAnswer,
  ConnectorAppContext,
  ConnectorAppContextOutcome,
  ConnectorAppResourceUri,
  ConnectorAppToolName,
  ConnectorAppView,
  ConnectorAppViewId,
} from "./connectorApp.ts";
import { Device, PairingCode, PushRegistration } from "./device.ts";
import { ElicitationAnswer } from "./elicitation.ts";
import {
  EngineStatus,
  LaunchArguments,
  MAX_USAGE_TURNS,
  ProviderPath,
  UsageTurn,
} from "./engineStatus.ts";
import {
  ApprovalDecision,
  BrowserHelpEntry,
  EntryPreview,
  EntryTarget,
  LookingAt,
  MAX_SECRET_ASK_VALUES,
  ConversationMentions,
  QuoteRequests,
  Mentions,
  MessageText,
  PREVIEW_LENGTH,
  QuestionAnswers,
  ReactionEmoji,
  ReceivedEntry,
  SecretRequestAnswer,
  SecretRequestFieldId,
  WorkStep,
} from "./entry.ts";
import { CommandError, Conflict, ConnectorCommandError, NotFound } from "./errors.ts";
import { ServerOrigin } from "./link.ts";
import {
  MemoryDocument,
  MemoryFile,
  MemoryPath,
  MemoryRevision,
  MemoryScope,
  MemoryText,
} from "./memory.ts";
import { PairBotIds, PairSeq, TeammateMessage, TeammatePair } from "./pair.ts";
import { Room, RoomMembers, RoomName } from "./room.ts";
import {
  OwnTrigger,
  Routine,
  RoutineAnswer,
  RoutineNotice,
  RoutineInstruction,
  RoutineRun,
} from "./routine.ts";
import {
  HarnessLocation,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
  ProviderSignInStatus,
  SignInHarness,
} from "./provider.ts";
import {
  Secret,
  SecretAccess,
  SecretChanges,
  SecretDraft,
  SecretField,
  SecretId,
  SecretName,
  SecretsStatus,
  SecretValue,
  TotpPreview,
} from "./secrets.ts";
import { Section, SectionName } from "./section.ts";
import { Settings, SettingsChange, TimeZone } from "./settings.ts";
import {
  ClientTelemetryEvent,
  MAX_SENT_TELEMETRY_EVENTS,
  SentTelemetryEvent,
  TelemetryClient,
} from "./telemetry.ts";
import { BotTemplate, TemplateTooLarge } from "./template.ts";

// ---------------------------------------------------------------------------
// Conventions
//
// Every RPC here runs on the socket at `HTTP_PATHS.rpc`, which is authenticated
// once, at the upgrade, and belongs to one device for its whole life. Revoking
// that device closes the socket. A request that fails unexpectedly fails alone,
// with a generic defect: the socket and its other subscriptions carry on.
//
// Subscriptions (`*.subscribe`) send the current state first and then changes.
// Changes carry whole entities, never deltas: the client upserts by id. Only
// `entries.subscribe` and `routines.subscribe` resume: each frame carries a
// sequence, and a client that passes the last one it applied as `after` gets
// only what changed since, or a snapshot when the server cannot replay that far
// (see `entries.subscribe`). The roster and the engine status are small and
// always start with a snapshot.
//
// Commands carry a client-generated `commandId`. Sending the same command again
// with the same id has no further effect and returns the first result, so a
// client retries freely after a dropped connection. `secret.provide`,
// `provider.connect`, the secrets' requests and the connector requests that
// carry a value or a sign-in are the exceptions: what they carry must never be
// stored, so they have no receipt (see there).
//
// A client offers sections, a bot's `sectionId` and `entries.markUnread` only
// once a roster snapshot carries `sections`, and `@` in a bot's conversation
// only once it carries `conversationMentions`, Reply and Quote only once it
// carries `quotes`, a comment on a quoted passage only once it carries
// `quoteComments`, to record the screen only once it carries
// `screenRecordings`, writes down a recording's voice only once it carries
// `recordingTranscripts`, and offers saved themes only once it carries
// `themes` (docs/architecture/clients.md, "Protocol compatibility").
// ---------------------------------------------------------------------------

const after = { after: Schema.NullOr(Sequence) };
const command = { commandId: CommandId };

export const RosterItem = Schema.Union([
  Schema.TaggedStruct("bot", {
    bot: Bot,
    lastEntry: Schema.NullOr(EntryPreview),
    lastActivityAt: Schema.NullOr(Schema.DateTimeUtc),
    /** The conversation has entries after the operator's read mark. */
    unread: Schema.Boolean,
  }),
  Schema.TaggedStruct("room", {
    room: Room,
    lastEntry: Schema.NullOr(EntryPreview),
    lastActivityAt: Schema.NullOr(Schema.DateTimeUtc),
    unread: Schema.Boolean,
  }),
]);
export type RosterItem = typeof RosterItem.Type;

export const RosterItemKey = Schema.Union([
  Schema.TaggedStruct("bot", { botId: BotId }),
  Schema.TaggedStruct("room", { roomId: RoomId }),
]);
export type RosterItemKey = typeof RosterItemKey.Type;

const HistoryLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

/**
 * Who the operator has, and what each is doing. `sections` are every section,
 * in the operator's order: always in a snapshot from a server that has them,
 * and in a change only when the sections themselves changed, replacing the
 * ones the client holds. A section's bots change as upserted bots.
 */
export const RosterRpcs = RpcGroup.make(
  Rpc.make("roster.subscribe", {
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", {
        items: Schema.Array(RosterItem),
        sections: Schema.optionalKey(Schema.Array(Section)),
        /**
         * Always `true` from a server that takes `message.send`'s
         * `conversationMentions`; a client offers `@` in a bot's
         * conversation only then.
         */
        conversationMentions: Schema.optionalKey(Schema.Literal(true)),
        /**
         * Always `true` from a server that takes `message.send`'s `quotes`;
         * a client offers Reply and Quote only then.
         */
        quotes: Schema.optionalKey(Schema.Literal(true)),
        /**
         * Always `true` from a server that takes a comment on a quoted
         * passage (`QuoteRequest`'s `comment`); a client offers one only
         * then.
         */
        quoteComments: Schema.optionalKey(Schema.Literal(true)),
        /**
         * Always `true` from a server that takes screen recordings at
         * `HTTP_PATHS.recordingUploads`; a client offers to record the
         * screen only then.
         */
        screenRecordings: Schema.optionalKey(Schema.Literal(true)),
        /**
         * Always `true` from a server whose voice socket takes `start`'s
         * `transcript` (`VoiceClientFrame`); the desktop app writes down a
         * screen recording's voice through it only then.
         */
        recordingTranscripts: Schema.optionalKey(Schema.Literal(true)),
        /**
         * Always `true` from a server that serves `ThemeRpcs` and takes
         * `say`'s theme offer; a client offers saved themes, the server's
         * default and Create from colors only then.
         */
        themes: Schema.optionalKey(Schema.Literal(true)),
      }),
      Schema.TaggedStruct("changed", {
        upsert: Schema.Array(RosterItem),
        remove: Schema.Array(RosterItemKey),
        sections: Schema.optionalKey(Schema.Array(Section)),
      }),
    ]),
    stream: true,
  }),
);

/** A conversation or a room: what was said, what is running, what is asked. */
export const EntryRpcs = RpcGroup.make(
  /**
   * The snapshot holds the most recent entries, sorted by `order`; older ones are
   * read with `entries.history`. Its `sequence` is the watermark it was read at:
   * every change after it follows as `changed`, and nothing at or before it
   * does, so a client applies frames in order and never double-counts.
   *
   * With `after`, the server sends only the changes after that sequence when it
   * still has them and there are at most a few hundred. Otherwise it sends a
   * snapshot instead, which replaces everything the client holds for the target:
   * the client drops its entries and re-reads history as the operator scrolls.
   *
   * The stream fails with `NotFound` if the bot or room is deleted.
   */
  Rpc.make("entries.subscribe", {
    payload: { target: EntryTarget, ...after },
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", {
        sequence: Sequence,
        entries: Schema.Array(ReceivedEntry),
        hasOlder: Schema.Boolean,
      }),
      Schema.TaggedStruct("changed", { sequence: Sequence, upsert: Schema.Array(ReceivedEntry) }),
    ]),
    error: NotFound,
    stream: true,
  }),
  /** Entries before `before`, oldest first, for scrolling back. */
  Rpc.make("entries.history", {
    payload: { target: EntryTarget, before: EntryOrder, limit: HistoryLimit },
    success: Schema.Struct({ entries: Schema.Array(ReceivedEntry), hasOlder: Schema.Boolean }),
    error: NotFound,
  }),
  /**
   * The steps of a work fold while the operator has it open: every step so far,
   * then each step as it is added or changes (upsert by id). The stream ends
   * once the fold's turn has finished and its last step was sent.
   */
  Rpc.make("entries.workSteps", {
    payload: { entryId: EntryId },
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", { steps: Schema.Array(WorkStep) }),
      Schema.TaggedStruct("step", { step: WorkStep }),
    ]),
    error: NotFound,
    stream: true,
  }),
  /** Everything up to `through` has been read. Moving the mark backwards is ignored. */
  Rpc.make("entries.markRead", {
    payload: { target: EntryTarget, through: EntryOrder },
    error: NotFound,
  }),
  /**
   * Makes the target unread again: the read mark moves back to just before
   * the last entry a bot or J3 Bots wrote, so that entry and everything after
   * it read as new, and the next `entries.markRead` past it clears it. A
   * target with no such entry stays as it is. Calling it again changes
   * nothing more. A command, unlike `entries.markRead`: it moves the mark
   * back, so a retry of one already applied must not undo a read made since.
   */
  Rpc.make("entries.markUnread", {
    payload: { ...command, target: EntryTarget },
    error: CommandError,
  }),
  /**
   * Returns the new message entry. `attachments` are uploaded first with
   * `POST /attachments`. `mentions` only applies in a room, and names
   * members only; leaving it out wakes every member, as `bots` with no ids
   * does. `conversationMentions` only applies in a bot's conversation, and
   * names the operator's other bots and the active rooms that bot is a
   * member of; it wakes nobody but that bot. A mention that breaks either
   * rule fails with `Invalid("mentions")`, writing nothing. Fails with `Invalid("attachment")`, writing nothing, when
   * the files break a limit of the engine that runs the bot: an empty file, an
   * inline image (`INLINE_IMAGE_MEDIA_TYPES`) over `MAX_INLINE_IMAGE_SIZE`, or
   * inline images over `MAX_INLINE_IMAGES_SIZE` together. Fails with
   * `Invalid("message-length")`, writing nothing, when the message as the bot
   * would read it is too long for that engine to take in one message. Fails
   * with `Invalid("quotes")`, writing nothing, for a quote of anything but a
   * message of the same conversation or room, a passage not in its text, the
   * same quote twice, more than one reply, or a comment on a reply. Fails
   * with `Conflict("room-archived")` in an archived room.
   */
  Rpc.make("message.send", {
    payload: {
      ...command,
      target: EntryTarget,
      text: MessageText,
      attachments: MessageAttachments,
      /**
       * Where the operator placed each file in `text` (`AttachmentOffsets`).
       * Left out, the files follow the text. Offsets that do not fit the
       * text and the files fail with `Invalid("attachment")`.
       */
      attachmentOffsets: Schema.optionalKey(AttachmentOffsets),
      mentions: Schema.optionalKey(Mentions),
      /**
       * Offered only once the roster snapshot carries
       * `conversationMentions`: a server that predates them ignores it.
       */
      conversationMentions: Schema.optionalKey(ConversationMentions),
      /**
       * The window the operator was looking at, from quick access: the
       * message keeps it, and its bot reads it beside the message, marked as
       * what it is. A server that predates it ignores it.
       */
      lookingAt: Schema.optionalKey(LookingAt),
      /**
       * The messages it quotes (decision 0094), each of the same
       * conversation or room: at most one whole, as a reply, and passages,
       * each found word for word in its message's text. Offered only once
       * the roster snapshot carries `quotes`: a server that predates them
       * ignores it.
       */
      quotes: Schema.optionalKey(QuoteRequests),
    },
    success: EntryId,
    error: CommandError,
  }),
  /**
   * Resolves a question, approval, browser help or save-login card everywhere.
   * Answering or dismissing an `ask` question wakes the bot with the answer;
   * answering an `engine` question or an approval lets the turn that raised it
   * continue. An `engine` question takes no dismissal: it fails with
   * `Invalid("not-dismissible")`, leaving the card open. When the engine
   * refuses an answer it was sent, the card closes as `refused`, and the turn
   * waits for a Stop. Fails with `Invalid("answer-length")`, leaving the card
   * open, when the answer to an `ask` question as the bot would read it is too
   * long for the engine that runs the bot to take in one message.
   *
   * A browser help card is answered `done` or `declined`: the server gives
   * every tab of the bot a device holds back to the bot, then wakes it with
   * the outcome, so a client need not release the tab first. Fails with
   * `Conflict("card-closed")` once the card has closed, by another device's
   * answer or by expiring.
   *
   * A bot's ask for a secret (`secret-ask`) takes only a dismissal, its
   * Decline, which closes it as declined and wakes the bot to say so; it is
   * saved with `secrets.add`, or `secrets.addFromAsk` for one with `values`.
   *
   * A connector's request for input is answered `connector-input`: the
   * answer goes to the connector's server only, never to the bot, and the
   * call that asked goes on with it. An accepted form must answer its fields
   * (`answersFields`), or it fails with `Invalid("connector-input")`, leaving
   * the card open. Fails with `Conflict("card-closed")` once the call that
   * asked ended.
   */
  Rpc.make("card.answer", {
    payload: {
      ...command,
      entryId: EntryId,
      answer: Schema.Union([
        Schema.TaggedStruct("question", { answers: QuestionAnswers }),
        Schema.TaggedStruct("dismiss", {}),
        Schema.TaggedStruct("approval", { decision: ApprovalDecision }),
        Schema.TaggedStruct("browser-help", { outcome: Schema.Literals(["done", "declined"]) }),
        Schema.TaggedStruct("connector-input", { answer: ElicitationAnswer }),
        /**
         * The operator's yes to a bot's `connector-ask`: with the client they
         * registered for an own app, null for an address in their own network.
         * The secret goes to the server's secrets only, never to a receipt or
         * the bot.
         */
        Schema.TaggedStruct("connector-ask", {
          client: Schema.NullOr(
            Schema.Struct({
              clientId: OAuthClientInput.fields.clientId,
              clientSecret: OAuthClientInput.fields.clientSecret,
            }),
          ),
        }),
      ]),
    },
    error: CommandError,
  }),
  /**
   * Answers a secret request. The values go straight to the engine and are
   * not stored, logged or kept in a receipt.
   *
   * A request for one value takes `provide`; one with `fields` takes
   * `provide-fields`, with a value for each of its fields and no other. A
   * request with one field also takes `provide`, as a client before 0.12.0
   * sends it. Any other answer fails with `Invalid("answer")`, leaving the
   * card open.
   *
   * Success means this call's answer is the one the engine took. When the
   * card had closed another way, or the engine's reply was lost and a retry
   * found the card closed, it fails with `Conflict("card-closed")`: the card
   * shows how it resolved, which may be this answer, another device's, or
   * `expired`.
   */
  Rpc.make("secret.provide", {
    payload: {
      entryId: EntryId,
      answer: SecretRequestAnswer,
    },
    error: CommandError,
  }),
  /** Runs again what a retryable notice says failed. */
  Rpc.make("notice.retry", {
    payload: { ...command, entryId: EntryId },
    error: CommandError,
  }),
  /**
   * Sends again a message whose delivery `failed`, to the recipients it
   * failed for, as new deliveries; the message is `pending` again. Fails with
   * `Conflict("not-retryable")` when its delivery is not `failed`.
   */
  Rpc.make("message.retry", {
    payload: { ...command, entryId: EntryId },
    error: CommandError,
  }),
  /**
   * Sets the operator's reaction on a message, any author's, replacing the
   * one they had there; `null` takes it off. It sets a state, so sending it
   * again changes nothing more, and it takes no command id. A reaction on a
   * bot's message reaches that bot as a light signal, a few seconds later,
   * with whatever the operator left there by then
   * (`docs/architecture/server.md`, Reactions).
   *
   * New in 0.13.0, within protocol 11: a client calls it only on a message
   * that carries `reactions`, which a server that has it always sends. Fails
   * with `Invalid("reaction")` when `emoji` is not one emoji or the entry is
   * not a message, with `NotFound("entry")` for an entry that does not exist,
   * and with `Conflict("room-archived")` in an archived room.
   */
  Rpc.make("message.react", {
    payload: { entryId: EntryId, emoji: Schema.NullOr(ReactionEmoji) },
    error: CommandError,
  }),
);

const ProfileChanges = Schema.Struct({
  name: Schema.optionalKey(Profile.fields.name),
  title: Schema.optionalKey(Profile.fields.title),
  avatar: Schema.optionalKey(AvatarChoice),
  job: Schema.optionalKey(Profile.fields.job),
});
/** The profile fields `bot.update` changes. Fields left out keep their value. */
export type ProfileChanges = typeof ProfileChanges.Type;

export const BotRpcs = RpcGroup.make(
  /**
   * Fields left out take the server's defaults: a free avatar, and a model of
   * the first ready provider, or with none ready, of one still to connect.
   */
  Rpc.make("bot.create", {
    payload: {
      ...command,
      name: Profile.fields.name,
      title: Schema.optionalKey(Profile.fields.title),
      avatar: Schema.optionalKey(AvatarChoice),
      job: Schema.optionalKey(Profile.fields.job),
      model: Schema.optionalKey(ModelChoice),
      /**
       * A level the engine reports for `model` (`Bot.effort`); the default
       * when left out, and for a bot created without a model. A server that
       * predates it creates the bot at the default.
       */
      effort: Schema.optionalKey(Schema.NullOr(EffortLevel)),
      /**
       * Fast mode (`Bot.fast`), for a `model` that has it; off when left out.
       * A server that predates it creates the bot without it.
       */
      fast: Schema.optionalKey(Schema.Boolean),
      permissionMode: Schema.optionalKey(PermissionMode),
      primary: Schema.optionalKey(Schema.Boolean),
      /** Creates it hidden (`Bot.hidden`); visible when left out. */
      hidden: Schema.optionalKey(Schema.Boolean),
    },
    success: Bot,
    error: CommandError,
  }),
  /**
   * Succeeds once the change is saved. A new model, effort or permission mode
   * reaches the bot's working session before its next turn: until the engine
   * has it, the bot takes no new work, and the server keeps trying while the
   * engine is unavailable. A turn already running keeps the settings it
   * started with, and background work still running holds the change, which a
   * `settings-held` notice says and the bot's `settingsHeld` shows; a Stop
   * ends both. Turning the browser on or off reaches it the same way: from
   * its next turn.
   *
   * A new model the bot's effort is not a level of, with no effort given,
   * takes the bot back to the default effort (null). `Invalid("model")`: the
   * model, or the effort or fast mode asked of it, is not one the engine
   * offers now.
   */
  Rpc.make("bot.update", {
    payload: {
      ...command,
      botId: BotId,
      profile: Schema.optionalKey(ProfileChanges),
      model: Schema.optionalKey(ModelChoice),
      /**
       * A level the engine reports for the bot's model, the new one when
       * `model` changes it, or null for the harness's own default (`Bot.effort`).
       */
      effort: Schema.optionalKey(Schema.NullOr(EffortLevel)),
      /**
       * Fast mode (`Bot.fast`), for the bot's model, the new one when `model`
       * changes it. A new model without fast mode, with `fast` left out,
       * turns it off. A server that predates it ignores it.
       */
      fast: Schema.optionalKey(Schema.Boolean),
      permissionMode: Schema.optionalKey(PermissionMode),
      /**
       * Making a bot primary makes the one that was primary before not, in the
       * same transaction: there is never a moment with two.
       */
      primary: Schema.optionalKey(Schema.Boolean),
      pinned: Schema.optionalKey(Schema.Boolean),
      /** The operator's choice, which no bot can change afterwards (decision 0050). */
      hidden: Schema.optionalKey(Schema.Boolean),
      /** Lets the bot use the browser (`Bot.browser`), or stops it. */
      browser: Schema.optionalKey(Schema.Boolean),
      /** Moves the bot into a section, or out of its section with null. */
      sectionId: Schema.optionalKey(Schema.NullOr(SectionId)),
    },
    success: Bot,
    error: CommandError,
  }),
  /**
   * Ends the bot's running work and cancels the messages and wakes it has not
   * received yet. What was already done stays done.
   */
  Rpc.make("bot.stop", { payload: { ...command, botId: BotId }, error: CommandError }),
  /**
   * Stop, for an AI that ignores it (`Bot.forceStop`): stops the bot as
   * `bot.stop` does, then has the engine end the AI's program for each of its
   * sessions whose AI did not confirm a Stop, which ends the turn there.
   * What the program already did stays done. Once no AI ignores a Stop, as
   * when the turn ended meanwhile, it is the Stop alone.
   */
  Rpc.make("bot.forceStop", { payload: { ...command, botId: BotId }, error: CommandError }),
  /**
   * Resets the bot's working context: stops any work it has running, then
   * starts it on a new session that carries nothing over from the old one, not
   * even a digest of the conversation. Conversation, memory, routines and
   * files stay.
   */
  Rpc.make("bot.freshStart", { payload: { ...command, botId: BotId }, error: CommandError }),
  /**
   * Removes the bot, its conversation, memory and routines. What it said in rooms
   * stays, shown as from a deleted bot. A room left with fewer than two
   * members is archived.
   */
  Rpc.make("bot.delete", {
    payload: { ...command, botId: BotId, deleteFiles: Schema.Boolean },
    error: CommandError,
  }),
  /**
   * The bot as a template another J3 Bots can create a bot from: its profile
   * and job, its model and permission mode, the `SKILL.md` of each skill in
   * its workspace and its routines but one-time ones, built from those alone
   * (`BotTemplate`). The job, the skills and the routines' instructions go
   * as written, whatever they hold. The bot's memory, conversation and files,
   * and everything else of this machine, stay out. A skill whose folder or
   * `SKILL.md` is a link, or not what it should be, or whose name or text
   * breaks the template's limits, stays out too; so do skills and routines
   * past the limits. Fails with `TemplateTooLarge` when the file would be
   * over the size any J3 Bots reads.
   */
  Rpc.make("bot.template", {
    payload: { botId: BotId },
    success: BotTemplate,
    error: Schema.Union([NotFound, TemplateTooLarge]),
  }),
  /**
   * Creates a bot from a template the operator has seen in full, as
   * `bot.create` creates one, with the template's skills in its workspace and
   * its routines, every one of them paused. The template is untrusted: it
   * reaches nothing but the new bot, which is never made primary. `model`
   * left out takes the template's where the engine offers it, and the
   * server's default otherwise; `permissionMode` left out takes the
   * template's unless that model's default (`defaultPermissionMode`) allows
   * less (`templatePermissionMode`). Fails with `Invalid("schedule")`,
   * creating nothing, when a routine's schedule is one the server refuses.
   */
  Rpc.make("bot.createFromTemplate", {
    payload: {
      ...command,
      template: BotTemplate,
      model: Schema.optionalKey(ModelChoice),
      /** As `bot.create`'s, for `model`; ignored without one. */
      effort: Schema.optionalKey(Schema.NullOr(EffortLevel)),
      /** As `bot.create`'s, for `model`; ignored without one. */
      fast: Schema.optionalKey(Schema.Boolean),
      permissionMode: Schema.optionalKey(PermissionMode),
      /** Creates it hidden (`Bot.hidden`); visible when left out. */
      hidden: Schema.optionalKey(Schema.Boolean),
    },
    success: Bot,
    error: CommandError,
  }),
  /** Files the bot delivered, newest first, before `before`. */
  Rpc.make("bot.files", {
    payload: { botId: BotId, before: Schema.NullOr(AttachmentId), limit: HistoryLimit },
    success: Schema.Struct({ files: Schema.Array(BotFile), hasOlder: Schema.Boolean }),
    error: NotFound,
  }),
);

/**
 * The roster's sections. Each command's change reaches every client through
 * `roster.subscribe`.
 */
export const SectionRpcs = RpcGroup.make(
  /** Adds a section after the others, and moves `botId` into it when given. */
  Rpc.make("section.create", {
    payload: { ...command, name: SectionName, botId: Schema.optionalKey(BotId) },
    success: Section,
    error: CommandError,
  }),
  /**
   * Renames the section, and with `before` moves it: before that section, or
   * after every other one with null.
   */
  Rpc.make("section.update", {
    payload: {
      ...command,
      sectionId: SectionId,
      name: Schema.optionalKey(SectionName),
      before: Schema.optionalKey(Schema.NullOr(SectionId)),
    },
    success: Section,
    error: CommandError,
  }),
  /** Deletes the section. Its bots stay, in no section. */
  Rpc.make("section.delete", {
    payload: { ...command, sectionId: SectionId },
    error: CommandError,
  }),
);

export const RoomRpcs = RpcGroup.make(
  Rpc.make("room.create", {
    payload: {
      ...command,
      name: RoomName,
      members: RoomMembers,
      /** Creates it hidden (`Room.hidden`); visible when left out. */
      hidden: Schema.optionalKey(Schema.Boolean),
    },
    success: Room,
    error: CommandError,
  }),
  /**
   * `archived: true` archives the room: its pending wakes are cancelled, its
   * running work is stopped as `bot.stop` stops it, and its open `ask` cards
   * expire. An archived room takes only `pinned`, `hidden` and
   * `archived: false`, and fails with `Conflict("room-archived")` for
   * anything else; unarchiving needs two to six members, which the same
   * update may give. `hidden` is the operator's choice, which no bot can
   * change afterwards (decision 0050).
   */
  Rpc.make("room.update", {
    payload: {
      ...command,
      roomId: RoomId,
      name: Schema.optionalKey(RoomName),
      members: Schema.optionalKey(RoomMembers),
      pinned: Schema.optionalKey(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean),
      archived: Schema.optionalKey(Schema.Boolean),
    },
    success: Room,
    error: CommandError,
  }),
  Rpc.make("room.delete", { payload: { ...command, roomId: RoomId }, error: CommandError }),
  /**
   * Stops the work addressed to the room, as `bot.stop` stops a bot's: each
   * member's running or waiting turn for it, and background work those turns
   * left running, end, and its waiting wakes are cancelled. It never ends a
   * member's turn for another audience: it waits for that turn to end. The
   * room stays active and its cards stay open. Fails with
   * `Conflict("room-archived")` in an archived room, whose work its archiving
   * already stopped.
   */
  Rpc.make("room.stop", { payload: { ...command, roomId: RoomId }, error: CommandError }),
  /**
   * Stop, for a member's AI that ignores the room's (`Room.forceStop`): stops
   * the room's work as `room.stop` does, then has the engine end the AI's
   * program wherever it ignores a Stop of the room's work. Fails as
   * `room.stop` does. Once no AI ignores one, it is the Stop alone.
   */
  Rpc.make("room.forceStop", { payload: { ...command, roomId: RoomId }, error: CommandError }),
);

/**
 * Teammate conversations: the messages each pair of bots sent each other, which
 * the operator reads and never writes into. They travel beside the roster,
 * not in it: a pair has no read mark, pin or section. Neither subscription
 * resumes; each starts with a snapshot.
 */
export const TeammatePairRpcs = RpcGroup.make(
  /**
   * Every pair of bots that sent each other a message, latest message first,
   * then each pair as a new message or a change of its latest one moves it
   * (upsert by `botIds`), and each pair that no longer has any (once both its
   * bots are deleted). A pair with one deleted bot stays: the survivor still
   * reads it. Hiding a bot hides nothing here; clients decide where a pair
   * with a hidden or deleted bot shows.
   */
  Rpc.make("pairs.subscribe", {
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", { pairs: Schema.Array(TeammatePair) }),
      Schema.TaggedStruct("changed", {
        upsert: Schema.Array(TeammatePair),
        remove: Schema.Array(PairBotIds),
      }),
    ]),
    stream: true,
  }),
  /**
   * A pair's messages before `before`, or its latest without it, oldest
   * first, for scrolling back. A pair with no messages has none: it is not
   * an error.
   */
  Rpc.make("pairs.history", {
    payload: { botIds: PairBotIds, before: Schema.optionalKey(PairSeq), limit: HistoryLimit },
    success: Schema.Struct({ messages: Schema.Array(TeammateMessage), hasOlder: Schema.Boolean }),
  }),
  /**
   * An open teammate conversation: its latest messages, oldest first, then
   * each message as it is sent or its state changes (upsert by `seq`). A
   * snapshot may come again, when too much changed at once to send as
   * changes; it replaces what the client holds, as for `entries.subscribe`.
   */
  Rpc.make("pairs.messages.subscribe", {
    payload: { botIds: PairBotIds },
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", {
        messages: Schema.Array(TeammateMessage),
        hasOlder: Schema.Boolean,
      }),
      Schema.TaggedStruct("changed", { upsert: Schema.Array(TeammateMessage) }),
    ]),
    stream: true,
  }),
);

export const RoutineRpcs = RpcGroup.make(
  /**
   * Resumes with `after` like `entries.subscribe`. `withEvents` says the
   * client reads a routine whose trigger is a connector's event: without it,
   * as from a client built before 0.13.0, whose triggers are a closed set,
   * the server leaves such routines out, and sends one that becomes one as
   * removed. A server built before ignores the field, and has none.
   */
  Rpc.make("routines.subscribe", {
    payload: { botId: BotId, ...after, withEvents: Schema.optionalKey(Schema.Boolean) },
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", { sequence: Sequence, routines: Schema.Array(Routine) }),
      Schema.TaggedStruct("changed", {
        sequence: Sequence,
        upsert: Schema.Array(Routine),
        remove: Schema.Array(RoutineId),
      }),
    ]),
    error: NotFound,
    stream: true,
  }),
  /** Runs, newest first, before `before`. */
  Rpc.make("routine.runs", {
    payload: {
      routineId: RoutineId,
      before: Schema.NullOr(RoutineRunId),
      limit: HistoryLimit,
    },
    success: Schema.Struct({ runs: Schema.Array(RoutineRun), hasOlder: Schema.Boolean }),
    error: NotFound,
  }),
  Rpc.make("routine.create", {
    payload: {
      ...command,
      botId: BotId,
      name: Routine.fields.name,
      instruction: RoutineInstruction,
      /** A client sets J3 Bots' own triggers only: a connector's event is the bot's to choose. */
      trigger: OwnTrigger,
    },
    success: Routine,
    error: CommandError,
  }),
  Rpc.make("routine.update", {
    payload: {
      ...command,
      routineId: RoutineId,
      name: Schema.optionalKey(Routine.fields.name),
      instruction: Schema.optionalKey(RoutineInstruction),
      /** As `routine.create`'s: a connector's event is the bot's to set. */
      trigger: Schema.optionalKey(OwnTrigger),
      enabled: Schema.optionalKey(Schema.Boolean),
    },
    success: Routine,
    error: CommandError,
  }),
  /** Runs the routine now, as a test. Skipped if a run is still going. */
  Rpc.make("routine.run", { payload: { ...command, routineId: RoutineId }, error: CommandError }),
  Rpc.make("routine.delete", {
    payload: { ...command, routineId: RoutineId },
    error: CommandError,
  }),
  /**
   * Answers the yes a run waits for (decision 0080). A run no longer
   * waiting, or waiting at another yes than `step` names, fails
   * `Conflict("card-closed")`.
   */
  Rpc.make("routine.answer", {
    payload: {
      ...command,
      runId: RoutineRunId,
      /**
       * The yes's place in the run's steps, as the card showed it, so an
       * answer to one yes never closes a later one. Absent from a client
       * that predates it, whose answer goes to the yes the run waits for.
       */
      step: Schema.optionalKey(NonNegativeInt),
      choice: RoutineAnswer.fields.choice,
      note: RoutineAnswer.fields.note,
    },
    error: CommandError,
  }),
  /**
   * Resumes a failed run from the step it failed at, keeping what the steps
   * before reported. A run that is not `retryable` fails
   * `Conflict("not-retryable")`.
   */
  Rpc.make("routine.retry", {
    payload: { ...command, runId: RoutineRunId },
    error: CommandError,
  }),
  /** Ends a run that is going, as a Stop of its owner ends it. A run already over fails `Conflict("card-closed")`. */
  Rpc.make("routine.stopRun", {
    payload: { ...command, runId: RoutineRunId },
    error: CommandError,
  }),
);

export const MemoryRpcs = RpcGroup.make(
  Rpc.make("memory.list", {
    payload: { scope: MemoryScope },
    success: Schema.Array(MemoryFile),
    error: NotFound,
  }),
  Rpc.make("memory.read", {
    payload: { scope: MemoryScope, path: MemoryPath },
    success: MemoryDocument,
    error: NotFound,
  }),
  /**
   * Replaces a file's text. Fails with `Conflict("stale-revision")` if the file
   * changed since `revision` was read; `revision: null` creates a new file.
   * Fails with `Conflict("private-location")`, writing nothing, when the
   * scope's folder has been linked out of the server's private data.
   */
  Rpc.make("memory.write", {
    payload: {
      ...command,
      scope: MemoryScope,
      path: MemoryPath,
      text: MemoryText,
      revision: Schema.NullOr(MemoryRevision),
    },
    success: MemoryDocument,
    error: CommandError,
  }),
);

export const EngineRpcs = RpcGroup.make(
  /** The current status, then every change. */
  Rpc.make("engine.subscribe", { success: EngineStatus, stream: true }),
  /**
   * Has the engine check the provider again now, as after the operator
   * installed its harness or fixed what made its check fail, instead of at
   * its next periodic check, minutes away. It answers once the check ended;
   * what it found follows on `engine.subscribe`.
   * `NotFound("provider")` for a provider the server does not have, and
   * `Conflict("engine-unavailable")` when the engine cannot take it now. A
   * client asks it only under a provider whose `reason` the server reports.
   */
  Rpc.make("engine.recheckProvider", {
    payload: { providerId: ProviderId },
    error: Schema.Union([NotFound, Conflict]),
  }),
  /**
   * Has the engine update the provider's harness to the newer version it
   * knows of, the way the harness's maker updates it, as T3 Code's own
   * Update does. It answers once the update has started; how it goes
   * follows on `engine.subscribe`, as the provider's `update`. Sessions that
   * open meanwhile wait for it; one already open is not stopped.
   * `NotFound("provider")` for a provider the server does not have,
   * `Conflict("provider-not-updatable")` when its `version` cannot be
   * updated, and `Conflict("engine-unavailable")` when the engine cannot
   * take it now. A client asks it only under a provider whose `version` the
   * server reports.
   */
  Rpc.make("engine.updateProvider", {
    payload: { providerId: ProviderId },
    error: Schema.Union([NotFound, Conflict]),
  }),
  /**
   * Adds another account of a harness, as a second Claude Code for a second
   * Claude plan: a provider of its own, with a home of its own and no
   * sign-in, which the operator then signs in (`provider.signIn` with its
   * id). It answers with its id once saved; the engine takes it while it
   * runs, or at its next start. Only from a server that reports providers'
   * `setup`, and only from the operator: no bot tool reaches it.
   */
  Rpc.make("engine.addProvider", {
    payload: { ...command, harness: SignInHarness, name: Label },
    success: ProviderId,
    error: CommandError,
  }),
  /**
   * Changes what the operator can change of a provider (`ProviderSetup`) and
   * its name; fields left out keep their value. The engine rebuilds the
   * provider for a change of anything but its name, which ends what its bots
   * run there, so a client asks only once the operator saved. Bots on a
   * provider turned off wait for it, and say so. `NotFound("provider")` for
   * a provider the server does not have, or that cannot be set up.
   */
  Rpc.make("engine.setUpProvider", {
    payload: {
      ...command,
      providerId: ProviderId,
      name: Schema.optionalKey(Label),
      enabled: Schema.optionalKey(Schema.Boolean),
      binaryPath: Schema.optionalKey(Schema.NullOr(ProviderPath)),
      launchArguments: Schema.optionalKey(LaunchArguments),
    },
    error: CommandError,
  }),
  /**
   * Removes a provider the operator added, and its home, with the account
   * signed in there. Its bots keep their model, which names a provider that
   * is gone: each says so, and waits for the operator to choose another.
   * `Conflict("provider-not-removable")` for the first of a harness,
   * which can only be turned off.
   */
  Rpc.make("engine.removeProvider", {
    payload: { ...command, providerId: ProviderId },
    error: CommandError,
  }),
  /**
   * Turns that started in the `USAGE_PERIOD` before `readAt`, the moment the
   * server read them, newest first, at most `limit`.
   */
  Rpc.make("usage.turns", {
    payload: {
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_USAGE_TURNS })),
    },
    success: Schema.Struct({
      turns: Schema.Array(UsageTurn),
      readAt: Schema.DateTimeUtc,
      hasMore: Schema.Boolean,
    }),
  }),
);

export const SettingsRpcs = RpcGroup.make(
  Rpc.make("settings.get", { success: Settings }),
  /**
   * The settings now, then each change, whoever made it: a device, or a bot
   * the operator told what to call them. A server older than this RPC
   * answers it with a defect, which a client passes over: it then reads them
   * with `settings.get` as before.
   */
  Rpc.make("settings.subscribe", { success: Settings, stream: true }),
  /** Fields left out keep their value. Returns the settings as saved. */
  Rpc.make("settings.update", {
    payload: { ...command, ...SettingsChange.fields },
    success: Settings,
    error: CommandError,
  }),
  /**
   * This device's time zone, which every client gives when its socket opens.
   * Until the operator chooses a time zone, the first device to give one sets
   * the operator's; after that it changes nothing. A zone the server does not
   * know is passed over. A server older than this RPC answers it with a
   * defect, which a client passes over too: it relies on nothing here.
   */
  Rpc.make("settings.deviceTimeZone", { payload: { timeZone: TimeZone } }),
  /**
   * Signs the bots' browser out of every site: deletes the cookies and site
   * data of the one browser profile they all use, on the server's computer.
   * Pages open in it close. `Conflict("engine-unavailable")` when the engine
   * cannot take it now. A server older than this RPC answers it with a
   * defect.
   */
  Rpc.make("browser.signOut", { error: Conflict }),
);

/**
 * Usage data (decision 0099). A client calls these only on a server whose
 * settings carry `telemetry`, which is how a server says it has them.
 */
export const TelemetryRpcs = RpcGroup.make(
  /**
   * What this socket's client is, which every client gives when its socket
   * opens: the server adds it to the events this socket's requests cause.
   */
  Rpc.make("telemetry.hello", { payload: { client: TelemetryClient } }),
  /** Something a client saw the operator do that the server cannot see. Passed over while it is off. */
  Rpc.make("telemetry.record", { payload: { event: ClientTelemetryEvent } }),
  /** The newest events sent, exactly as they left, newest first. */
  Rpc.make("telemetry.sent", {
    success: Schema.Array(SentTelemetryEvent).check(Schema.isMaxLength(MAX_SENT_TELEMETRY_EVENTS)),
  }),
);

/**
 * The entries a bot adds that notify: what it says to the operator and the
 * cards that wait on the operator. A push of each kind shows on Android in a
 * notification channel of its own, whose id is the kind, so the operator can
 * mute or silence one kind alone.
 */
export const NotificationKind = Schema.Literals([
  "message",
  "question",
  "approval",
  "secret-request",
  "browser-help",
  /** A connector a bot called, or added, needs the operator to sign in. */
  "connector",
]);
export type NotificationKind = typeof NotificationKind.Type;

/**
 * Which connector card a `connector` notification is about: a connector a bot
 * called or added that needs a sign-in, or a connector's server asking the
 * operator something. Each is worded apart.
 */
export const ConnectorNotice = Schema.Literals(["sign-in", "input"]);
export type ConnectorNotice = typeof ConnectorNotice.Type;

/** An entry worth the operator's attention, added where no connected client has it in view. */
export const Notification = Schema.Struct({
  target: EntryTarget,
  entryId: EntryId,
  /** The bot that wrote it. The operator's own entries never notify. */
  botId: BotId,
  kind: NotificationKind,
  /**
   * The first line of the entry's text, at most `PREVIEW_LENGTH` characters:
   * the message, the question or the action. Null when the operator does not
   * allow previews, or when the entry has no text of its own, and always for
   * a `browser-help` notification, whose card's note is the bot's own words
   * and could quote a sign-in link or a code: `browserHelp` stands for it.
   */
  preview: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PREVIEW_LENGTH))),
  /** For a `connector` notification, which card made it; null for every other kind. */
  connector: Schema.NullOr(ConnectorNotice).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /**
   * A `browser-help` notification's preview, in fixed words: why the bot
   * asks and the site its tab is on, never its note. Null when the operator
   * does not allow previews, for every other kind, and from a server that
   * predates it.
   */
  browserHelp: Schema.NullOr(
    Schema.Struct({ reason: BrowserHelpEntry.fields.reason, site: BrowserHelpEntry.fields.site }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * A run of a routine with several steps that needs the operator (decision
   * 0080), always a `question`: its routine's name, and why, in fixed words.
   * For the yes it waits for, the preview is what the yes asks; for a step
   * it failed at, it names that step's bot. Absent for every other
   * notification, and from a server that predates steps.
   */
  routine: Schema.optionalKey(RoutineNotice),
});
export type Notification = typeof Notification.Type;

/**
 * A pairing code, and the origins the server listens at as another device
 * reaches it, best first, as `j3-bots pair` lists them: what a pairing link
 * (`PairingLink`) can carry. Empty when the server knows none, as over HTTPS
 * with a certificate that names no host, and from a server older than
 * `origins`, which answers without it at the same protocol version.
 */
export const PairingStarted = Schema.Struct({
  code: PairingCode,
  expiresAt: Schema.DateTimeUtc,
  origins: Schema.Array(ServerOrigin).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type PairingStarted = typeof PairingStarted.Type;

export const ClientRpcs = RpcGroup.make(
  /**
   * What the operator is looking at on this socket. The server notifies about
   * entries in a target no connected client has in view.
   */
  Rpc.make("client.view", { payload: { target: Schema.NullOr(EntryTarget) } }),
  /** Notifications for this socket to show. Live only: missed ones are not replayed. */
  Rpc.make("notifications.subscribe", { success: Notification, stream: true }),
  Rpc.make("devices.list", { success: Schema.Array(Device) }),
  /** A code a new client can pair with, shown on this one. */
  Rpc.make("pairing.start", { success: PairingStarted }),
  /**
   * Closes that device's sockets at once, refuses its token from now on and
   * deletes its push registration.
   */
  Rpc.make("device.revoke", {
    payload: { ...command, deviceId: DeviceId },
    error: NotFound,
  }),
  /**
   * Registers this socket's device for push notifications, replacing what it
   * registered before, and takes the token from any other device that
   * registered it. While the device has no socket open, the server pushes to
   * it what it would otherwise tell it. `NotFound("device")` when the device
   * was revoked.
   */
  Rpc.make("push.register", {
    payload: { ...command, ...PushRegistration.fields },
    error: CommandError,
  }),
  /**
   * Ends this socket's device's push registration, if it has one.
   * `NotFound("device")` when the device was revoked.
   */
  Rpc.make("push.unregister", { payload: command, error: CommandError }),
);

/**
 * Setting up the providers from a client, as `j3-bots provider` does on the
 * server's machine. A sign-in opens a page that returns to the harness on the
 * server's machine, so a client offers it only where it runs the server
 * itself: the desktop app hosting it (docs/architecture/engine.md, "Signing
 * in from the app"). A client calls them only on a server it runs itself,
 * of its own release, and shows the command to run instead when one fails
 * with a defect.
 */
export const ProviderRpcs = RpcGroup.make(
  /** Where the server finds each harness, looked up again on every call. */
  Rpc.make("provider.harnesses", { success: Schema.Array(HarnessLocation) }),
  /**
   * Follows the harness's own sign-in, run without a terminal for J3 Bots'
   * home for it: where it stands, then each change, ending once it ended.
   * With `start`, one starts unless one is under way, from this client or
   * another, which it follows instead. Without, it follows the one under way,
   * or answers how the last one ended, or nothing when there was none: what
   * a client asks again on a new socket, so a sign-in that ended meanwhile
   * is not run a second time. A sign-in keeps running while no client
   * follows it, until it ends, is cancelled or times out.
   */
  Rpc.make("provider.signIn", {
    payload: {
      harness: SignInHarness,
      start: Schema.Boolean,
      /**
       * The provider to sign in, one of `harness`'s, from a server that
       * reports providers' `setup`; the first of `harness` when left out. A
       * client sends it to an older server for no other provider.
       */
      providerId: Schema.optionalKey(ProviderId),
    },
    success: ProviderSignInStatus,
    stream: true,
  }),
  /** Stops the harness's sign-in under way, if any. Its home is as it was. */
  Rpc.make("provider.cancelSignIn", {
    payload: { harness: SignInHarness, providerId: Schema.optionalKey(ProviderId) },
  }),
  /**
   * Connects Claude Code and Codex to an endpoint, as `j3-bots provider
   * connect` does, restarting the engine. It has no command id: a receipt
   * would keep the key. Sending it again stores the same connection again.
   */
  Rpc.make("provider.connect", {
    payload: ProviderConnectionRequest,
    success: ProviderConnectionOutcome,
  }),
  /**
   * Installs J3 Bots' own copy of the harness, or brings it to the version
   * the publisher lists as latest, in the background: what it does follows
   * on `engine.subscribe`, in the provider's `copy`. Answers once it started,
   * or at once when one is under way already. A client sends it only under a
   * provider that carries `copy`.
   * `Conflict("harness-not-installable")` when J3 Bots installs no copy of
   * it here: the server runs the one the operator installed, or
   * J3 Bots has no build of it for the server's system. No command id: doing
   * it again does nothing more.
   */
  Rpc.make("provider.installHarness", {
    payload: { harness: SignInHarness },
    error: CommandError,
  }),
  /**
   * Stops the install or update of the harness under way, if any, before it
   * switches: the provider keeps the copy it had, or none.
   */
  Rpc.make("provider.cancelHarnessInstall", { payload: { harness: SignInHarness } }),
);

export const BrowserRpcs = RpcGroup.make(
  /**
   * The tabs the bot opened in the engine's browser, then the whole list
   * again on every change: a tab opened, closed, navigated or loaded, or
   * taken or given back by a person. Small, and always starts afresh. A
   * tab's picture and control are on the media socket (`HTTP_PATHS.browser`).
   */
  Rpc.make("browser.subscribe", {
    payload: { botId: BotId },
    success: BrowserTabs,
    error: NotFound,
    stream: true,
  }),
);

/**
 * Secrets: what the operator types for bots to use without reading them
 * (docs/architecture/server.md, "Secrets"). Any paired client may read and
 * change them. None of these requests has a command id, since a receipt
 * would keep what it carries; each is safe to send again instead:
 * `secrets.add` names the secret it makes. No value they carry or answer is
 * stored outside the secrets' file, logged or kept in an error. Every request
 * but `secrets.status` fails with `Conflict("secrets-unavailable")` while the
 * state is not `ready`. A value that cannot be opened or read back fails with
 * `Conflict("secrets-damaged")`.
 */
export const SecretsRpcs = RpcGroup.make(
  /** The secrets' state now, then each change. */
  Rpc.make("secrets.status", { success: SecretsStatus, stream: true }),
  /** Every secret, by name, without its values. */
  Rpc.make("secrets.list", { success: Schema.Array(Secret), error: CommandError }),
  /**
   * One value of a secret, for the operator to see. The server records when
   * it was shown and on which device, never the value. Fails with
   * `NotFound("secret")` for a field the secret does not have.
   */
  Rpc.make("secrets.reveal", {
    payload: { id: SecretId, field: SecretField },
    success: Schema.Redacted(Schema.String),
    error: CommandError,
  }),
  /**
   * Adds a secret as `id`, under `name`, usable by the bots of `access`.
   * With `request`, it answers that bot's `secret-ask` card, which closes as
   * saved and wakes the bot with the reference; the card's name and kind are
   * the secret's, and its bot may use it whatever `access` says. When `id` is
   * added already, nothing changes and the secret is returned as it is, so a
   * retry adds nothing. Fails with `Conflict("secret-name-taken")` for a name
   * another secret has, and with `Invalid("totp")` when `totp` is not a
   * one-time code setup.
   */
  Rpc.make("secrets.add", {
    payload: {
      id: SecretId,
      name: SecretName,
      draft: SecretDraft,
      access: SecretAccess,
      request: Schema.NullOr(EntryId),
    },
    success: Secret,
    error: CommandError,
  }),
  /**
   * Answers a bot's `secret-ask` card that asks for several values
   * (`values`): each value is added as a single value under the name the
   * card gives it, as `id`, usable by the bots of `access` and always by the
   * bot that asked. The card closes as saved once every one is added, and
   * wakes the bot with their references. Every value must be given, and only
   * those: else `Invalid("answer")`, and nothing is added. A name another
   * secret took since the ask fails with `Conflict("secret-name-taken")`;
   * values added before it stay added. Sent again, under any ids, the
   * values added already are returned as they are.
   */
  Rpc.make("secrets.addFromAsk", {
    payload: {
      request: EntryId,
      access: SecretAccess,
      values: Schema.Array(
        Schema.Struct({ field: SecretRequestFieldId, id: SecretId, value: SecretValue }),
      ).check(Schema.isMaxLength(MAX_SECRET_ASK_VALUES)),
    },
    success: Schema.Array(Secret),
    error: CommandError,
  }),
  /**
   * Changes a secret's name or values. Fails with `Invalid("secret-kind")`
   * for a login's field on a single value or the other way round. A bot that
   * named it by its old name no longer finds it.
   */
  Rpc.make("secrets.update", {
    payload: { id: SecretId, changes: SecretChanges },
    success: Secret,
    error: CommandError,
  }),
  /** Deletes the secret. Deleting one already gone succeeds. */
  Rpc.make("secrets.delete", { payload: { id: SecretId }, error: CommandError }),
  /** Replaces which bots may use the secret. */
  Rpc.make("secrets.setAccess", {
    payload: { id: SecretId, access: SecretAccess },
    success: Secret,
    error: CommandError,
  }),
  /**
   * A login's one-time code now, so the operator can check it against the
   * site's. Fails with `NotFound("secret")` for a secret without one.
   */
  Rpc.make("secrets.totpPreview", {
    payload: { id: SecretId },
    success: TotpPreview,
    error: CommandError,
  }),
);

/** What `connectors.subscribe` sends: every connector, then each change. */
export const ConnectorsEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { connectors: Schema.Array(Connector) }),
  Schema.TaggedStruct("changed", {
    upsert: Schema.Array(Connector),
    remove: Schema.Array(ConnectorId),
  }),
]);
export type ConnectorsEvent = typeof ConnectorsEvent.Type;

/**
 * Connectors (docs/architecture/server.md, "Connectors"): the gallery to find
 * them in, and the operator's own, which every paired client may add, sign in
 * to, share among bots and remove.
 *
 * Nothing a connector holds leaves the server: a token, a key, a header's
 * value, a sign-in's code or `state`. What a client sends of them travels
 * redacted, and the requests that carry one (`connector.add`,
 * `connector.update`, `connector.beginSignIn`, `connector.completeSignIn`)
 * have no command id, since a receipt would keep it; each is safe to send
 * again instead. A request that needs a connector's secrets fails with the
 * secrets' conflict while they are not `ready` (`secrets.status`).
 */
export const ConnectorRpcs = RpcGroup.make(
  /** The curated list, in the client's language: what the gallery features. */
  Rpc.make("connectors.list", {
    payload: { language: Language },
    success: Schema.Array(ConnectorListing),
  }),
  /**
   * The curated entries that match, then the MCP Registry's, best first.
   * Without `all`, only those J3 Bots can connect from any client: no
   * `unsupported` and no `command` listing. When the registry does not answer
   * in time, `registry` says so and the curated matches come alone.
   */
  Rpc.make("connectors.search", {
    payload: {
      query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      language: Language,
      all: Schema.Boolean,
    },
    success: Schema.Struct({
      listings: Schema.Array(ConnectorListing),
      registry: Schema.Literals(["answered", "unavailable"]),
    }),
  }),
  /**
   * One gallery entry's page: what it does, what Connect asks for and, when
   * its server lists them openly, its tools. `NotFound("connector-listing")`
   * when there is no such entry; `Conflict("registry-unavailable")` when the
   * registry does not answer for one of its own.
   */
  Rpc.make("connectors.get", {
    payload: { ref: ListingRef, language: Language },
    success: ConnectorListingDetails,
    error: CommandError,
  }),
  /**
   * The operator's connectors, then each one again on every change: a status,
   * a grant, a tool list or a review. Small, and always starts afresh. A
   * connector shows how it is reached only as `displayTransport` words it.
   */
  Rpc.make("connectors.subscribe", {
    success: ConnectorsEvent,
    stream: true,
  }),
  /**
   * Adds the connector as `id`, its secrets to the secrets' file, and lists its tools
   * when it needs no sign-in; one that does is added as `needs-sign-in`, and
   * `connector.beginSignIn` follows. When `id` is added already, nothing
   * changes and the connector is returned as it is, so a retry adds nothing.
   * `grant` left out gives it to every bot. The connector records the
   * operator as who added it. Fails with `Conflict("private-network")` for an
   * address in the operator's own network without `privateNetwork`,
   * `Invalid("connector-fields")` for a form's values that do not fit it, or
   * a command's environment that names a variable twice,
   * `Invalid("command-unpinned")` for a command that runs a package at no
   * exact version, and `Invalid("connector-unsupported")` for an entry J3
   * Bots cannot connect. A command connector's process starts when it is
   * first used, which may be at once, to list its tools.
   * The connector returned, like every one after it, shows the address only
   * as its origin and the command only as its program (`displayTransport`):
   * the rest, which can carry a key, stays with the secrets. A reference to
   * one of the operator's secrets (`${secret:<name>}`) in a header, an
   * argument or a variable must name one every bot of `grant` may use, or it
   * fails with `SecretRefused`, as one in the address does.
   */
  Rpc.make("connector.add", {
    payload: {
      id: ConnectorId,
      source: ConnectorSource,
      grant: Schema.optionalKey(ConnectorGrant),
    },
    success: Connector,
    error: ConnectorCommandError,
  }),
  /**
   * Renames the connector, or replaces the values its form took, such as a
   * token the service refused, or a command connector's environment values:
   * fields left out keep their value, and so does each value `values` does
   * not name. A variable that decides which code runs (`codeVariable`) is
   * part of the command line, so `values` naming one fails with
   * `Invalid("connector-fields")`: its new value comes with `command`.
   * `command` replaces a command connector's whole command line
   * and environment, which the client sends only once the operator confirmed
   * it as for an add: its process, if it runs, stops, and the next use runs
   * the new one, whose tools wait on the operator's review where they differ.
   * It fails with `Invalid("connector-unsupported")` for a connector that is
   * not run by command, and as `connector.add` does for its command and for
   * a secret its values name.
   */
  Rpc.make("connector.update", {
    payload: {
      connectorId: ConnectorId,
      name: Schema.optionalKey(Connector.fields.name),
      values: Schema.optionalKey(ConnectorFieldValues),
      command: Schema.optionalKey(CommandLine),
    },
    success: Connector,
    error: ConnectorCommandError,
  }),
  /**
   * Removes the connector: bots lose its tools at once, its sign-in is
   * revoked at the service when the service offers that, and its secrets
   * are deleted. The operator's account at the service is not changed.
   * Removing one already gone succeeds.
   */
  Rpc.make("connector.remove", {
    payload: { ...command, connectorId: ConnectorId },
    error: CommandError,
  }),
  /**
   * Replaces which bots may use the connector. A bot that gains it gets its
   * tools from its next model call. It fails with `SecretRefused` when a bot
   * of `grant` may not use a secret the connector's settings name.
   */
  Rpc.make("connector.setBots", {
    payload: { ...command, connectorId: ConnectorId, grant: ConnectorGrant },
    success: Connector,
    error: ConnectorCommandError,
  }),
  /**
   * Starts a sign-in for the connector, which this device opens in the system
   * browser; it returns to the server or to this device as `redirect` says.
   * The sign-in is this device's alone and lasts ten minutes; another starts
   * a new one. Fails with `Conflict("no-server-redirect")` for `server` where
   * the server cannot be returned to, `Conflict("sign-in-unsupported")` or
   * `Conflict("registration-refused")` when the service does not sign in as
   * J3 Bots requires, `Conflict("sign-in-unreachable")` when it does not
   * answer, and `Invalid` for a connector that signs in no other way
   * than its form.
   */
  Rpc.make("connector.beginSignIn", {
    payload: { connectorId: ConnectorId, redirect: SignInRedirect },
    success: SignInStarted,
    error: CommandError,
  }),
  /**
   * Finishes a `relay` or `paste` sign-in with the address the browser
   * returned to, which only the device that began it may send. Success means
   * the connector is signed in; its status follows on `connectors.subscribe`.
   * Fails with `Invalid("sign-in-url")` for an address this sign-in does not
   * expect, `NotFound("sign-in")` for one that ended or expired, and
   * `Conflict("sign-in-refused")` when the service refused it, and
   * `Conflict("sign-in-unreachable")` when its token endpoint did not answer.
   */
  Rpc.make("connector.completeSignIn", {
    payload: { url: SignInCallback },
    error: CommandError,
  }),
  /**
   * The prompts of the connectors `botId` may use that are connected, for the
   * composer's `/` menu in that bot's conversation. A connector whose server
   * could not list them now is left out. Fails with `NotFound("bot")`.
   */
  Rpc.make("connector.prompts", {
    payload: { botId: BotId },
    success: Schema.Array(ConnectorPrompt),
    error: CommandError,
  }),
  /**
   * The prompt rendered by its server with the arguments the operator gave,
   * as text: the client puts it in the composer, where the operator reads it
   * and sends it as their own message. Its server wrote it, so it is never
   * sent unseen. Fails with `NotFound("connector")` for a connector `botId`
   * may not use, `Invalid("prompt-arguments")` for a required argument
   * missing or one the prompt does not take, and
   * `Conflict("connector-unavailable")` when its server did not render it.
   */
  Rpc.make("connector.renderPrompt", {
    payload: {
      botId: BotId,
      connectorId: ConnectorId,
      name: ConnectorPrompt.fields.name,
      arguments: PromptArguments,
    },
    success: Schema.Struct({ text: Schema.String, cut: Schema.Boolean }),
    error: CommandError,
  }),
);

/**
 * A connector's app, which a bot's reply shows (`ConnectorAppEntry`, and
 * `WorkFoldEntry.apps` before 0.14.0): its document, and what the app asks
 * of its connector while a client draws it (decisions 0048 and 0093). Each
 * request goes out as the bot whose call opened the app, through that bot's
 * own session with the connector, checked as the bot's own calls are; a
 * client asks the operator first when a call answers `needs-allow`.
 */
export const ConnectorAppRpcs = RpcGroup.make(
  /** The app, ready to draw. `NotFound("connector-app")` once its conversation's work is gone. */
  Rpc.make("connectorApp.open", {
    payload: { viewId: ConnectorAppViewId },
    success: ConnectorAppView,
    error: NotFound,
  }),
  /**
   * A `tools/call` the app asked for: a tool of its own connector whose
   * `visibility` includes `app`. `allowed` says the operator pressed Allow
   * for the tool in the app's card; without it the call runs only while the
   * bot is in full access, and is refused `needs-allow` otherwise. The answer
   * is the connector's, or why it was not passed on.
   */
  Rpc.make("connectorApp.callTool", {
    payload: {
      viewId: ConnectorAppViewId,
      name: ConnectorAppToolName,
      arguments: Schema.JsonObject,
      allowed: Schema.Boolean,
    },
    success: ConnectorAppAnswer,
    error: NotFound,
  }),
  /** A `resources/read` the app asked for, of its own connector. */
  Rpc.make("connectorApp.readResource", {
    payload: { viewId: ConnectorAppViewId, uri: ConnectorAppResourceUri },
    success: ConnectorAppAnswer,
    error: NotFound,
  }),
  /**
   * What the app sets as context for its bot (`ui/update-model-context`):
   * it replaces what the same app set before, and the bot reads it, framed
   * as the connector's data, in its next turn where the app is shown. It
   * wakes nobody. Refused `gone` once the bot no longer has the connector.
   * Offered only against a view that carries `modelContext`.
   */
  Rpc.make("connectorApp.setContext", {
    payload: { viewId: ConnectorAppViewId, context: ConnectorAppContext },
    success: ConnectorAppContextOutcome,
    error: NotFound,
  }),
);

/** Every RPC a paired client can make, on the socket at `HTTP_PATHS.rpc`. */
export const J3Rpcs = RosterRpcs.merge(
  EntryRpcs,
  BotRpcs,
  SectionRpcs,
  RoomRpcs,
  TeammatePairRpcs,
  RoutineRpcs,
  MemoryRpcs,
  EngineRpcs,
  SettingsRpcs,
  TelemetryRpcs,
  ClientRpcs,
  ProviderRpcs,
  BrowserRpcs,
  SecretsRpcs,
  ConnectorRpcs,
  ConnectorAppRpcs,
  SkillRpcs,
  VoiceRpcs,
  ThemeRpcs,
);
