// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { BotFile, MessageAttachments } from "./attachment.ts";
import {
  AttachmentId,
  BotId,
  CommandId,
  DeviceId,
  EntryId,
  EntryOrder,
  RoomId,
  RoutineId,
  RoutineRunId,
  SectionId,
  Sequence,
} from "./base.ts";
import { AvatarChoice, Bot, ModelChoice, PermissionMode, Profile } from "./bot.ts";
import {
  Connector,
  ConnectorFieldValues,
  ConnectorGrant,
  ConnectorId,
  ConnectorListing,
  ConnectorListingDetails,
  ConnectorSource,
  ListingRef,
  SignInCallback,
  SignInRedirect,
  SignInStarted,
  ToolReviewRevision,
} from "./connector.ts";
import { Device, Language, PairingCode, PushRegistration } from "./device.ts";
import { EngineStatus, MAX_USAGE_TURNS, UsageTurn } from "./engineStatus.ts";
import {
  ApprovalDecision,
  EntryPreview,
  EntryTarget,
  Mentions,
  MessageText,
  PREVIEW_LENGTH,
  QuestionAnswers,
  ReceivedEntry,
  WorkStep,
} from "./entry.ts";
import { CommandError, NotFound } from "./errors.ts";
import { ServerOrigin } from "./link.ts";
import {
  MemoryDocument,
  MemoryFile,
  MemoryPath,
  MemoryRevision,
  MemoryScope,
  MemoryText,
} from "./memory.ts";
import { Room, RoomHopLimit, RoomMembers, RoomName } from "./room.ts";
import { Routine, RoutineInstruction, RoutineRun, RoutineTrigger } from "./routine.ts";
import {
  HarnessLocation,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
  ProviderSignInStatus,
  SignInHarness,
} from "./provider.ts";
import { Section, SectionName } from "./section.ts";
import { Settings, SettingsChange, TimeZone } from "./settings.ts";
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
// client retries freely after a dropped connection. `secret.provide` and the
// connector requests that carry a value or a sign-in are the exceptions: what
// they carry must never be stored, so they have no receipt (see there).
//
// A roster snapshot that carries `sections` comes from a server that organizes
// the roster: sections, a bot's `sectionId` and `entries.markUnread`. A client
// offers those only then, so it never calls them on a server that predates them
// (docs/architecture/clients.md, "Protocol compatibility").
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
   * once the fold's turn has finished, and any work it handed off with it
   * (`background`), and its last step was sent.
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
   * `POST /attachments`. `mentions` only applies in a room; leaving it out
   * mentions nobody. Fails with `Invalid("attachment")`, writing nothing, when
   * the files break a limit of the engine that runs the bot: an empty file, an
   * inline image (`INLINE_IMAGE_MEDIA_TYPES`) over `MAX_INLINE_IMAGE_SIZE`, or
   * inline images over `MAX_INLINE_IMAGES_SIZE` together. Fails with
   * `Invalid("message-length")`, writing nothing, when the message as the bot
   * would read it is too long for that engine to take in one message. Fails
   * with `Conflict("room-archived")` in an archived room.
   */
  Rpc.make("message.send", {
    payload: {
      ...command,
      target: EntryTarget,
      text: MessageText,
      attachments: MessageAttachments,
      mentions: Schema.optionalKey(Mentions),
    },
    success: EntryId,
    error: CommandError,
  }),
  /**
   * Resolves a question or approval card everywhere. Answering or dismissing an
   * `ask` question wakes the bot with the answer; answering an `engine` question
   * or an approval lets the turn that raised it continue. An `engine` question
   * takes no dismissal: it fails with `Invalid("not-dismissible")`, leaving
   * the card open. When the engine refuses an answer it was sent, the card
   * closes as `refused`, and the turn waits for a Stop. Fails with `Invalid("answer-length")`, leaving the card open, when
   * the answer to an `ask` question as the bot would read it is too long for
   * the engine that runs the bot to take in one message. A connector
   * suggestion takes only a dismissal, its Not now, which closes it without
   * waking the bot; its Connect is `connector.add` or `connector.setBots`.
   */
  Rpc.make("card.answer", {
    payload: {
      ...command,
      entryId: EntryId,
      answer: Schema.Union([
        Schema.TaggedStruct("question", { answers: QuestionAnswers }),
        Schema.TaggedStruct("dismiss", {}),
        Schema.TaggedStruct("approval", { decision: ApprovalDecision }),
      ]),
    },
    error: CommandError,
  }),
  /**
   * Answers a secret request. The value goes straight to the engine and is not
   * stored, logged or kept in a receipt.
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
      answer: Schema.Union([
        Schema.TaggedStruct("provide", {
          value: Schema.Redacted(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
          ),
        }),
        Schema.TaggedStruct("decline", {}),
      ]),
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
      permissionMode: Schema.optionalKey(PermissionMode),
      primary: Schema.optionalKey(Schema.Boolean),
    },
    success: Bot,
    error: CommandError,
  }),
  /**
   * Succeeds once the change is saved. A new model or permission mode reaches
   * the bot's working session before its next turn: until the engine has it,
   * the bot takes no new work, and the server keeps trying while the engine
   * is unavailable. A turn already running keeps the settings it started with,
   * and background work still running holds the change, which a
   * `settings-held` notice says and the bot's `settingsHeld` shows; a Stop
   * ends both.
   */
  Rpc.make("bot.update", {
    payload: {
      ...command,
      botId: BotId,
      profile: Schema.optionalKey(ProfileChanges),
      model: Schema.optionalKey(ModelChoice),
      permissionMode: Schema.optionalKey(PermissionMode),
      /**
       * Making a bot primary makes the one that was primary before not, in the
       * same transaction: there is never a moment with two.
       */
      primary: Schema.optionalKey(Schema.Boolean),
      pinned: Schema.optionalKey(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean),
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
   * Resets the bot's working context: stops any work it has running, then
   * starts it on a new session that carries nothing over from the old one, not
   * even a digest of the conversation. Conversation, memory, routines and
   * files stay.
   */
  Rpc.make("bot.freshStart", { payload: { ...command, botId: BotId }, error: CommandError }),
  /**
   * Removes the bot, its conversation, memory and routines. What it said in rooms
   * stays, shown as from a deleted bot. A room it hosted passes to another
   * member; a room left with fewer than two members is archived.
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
      permissionMode: Schema.optionalKey(PermissionMode),
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
      hostId: BotId,
      hopLimit: Schema.optionalKey(RoomHopLimit),
    },
    success: Room,
    error: CommandError,
  }),
  /**
   * `archived: true` archives the room: its pending wakes are cancelled, its
   * running work is stopped as `bot.stop` stops it, and its open `ask` cards
   * expire. An archived room takes only `pinned` and `archived: false`, and
   * fails with `Conflict("room-archived")` for anything else; unarchiving
   * needs two to six members and a host, which the same update may give.
   */
  Rpc.make("room.update", {
    payload: {
      ...command,
      roomId: RoomId,
      name: Schema.optionalKey(RoomName),
      members: Schema.optionalKey(RoomMembers),
      hostId: Schema.optionalKey(BotId),
      hopLimit: Schema.optionalKey(RoomHopLimit),
      pinned: Schema.optionalKey(Schema.Boolean),
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
);

export const RoutineRpcs = RpcGroup.make(
  /** Resumes with `after` like `entries.subscribe`. */
  Rpc.make("routines.subscribe", {
    payload: { botId: BotId, ...after },
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
      trigger: RoutineTrigger,
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
      trigger: Schema.optionalKey(RoutineTrigger),
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
);

/**
 * The entries a bot adds that notify: what it says to the operator, an urgent
 * message to a teammate, and the cards that wait on the operator. A push of
 * each kind shows on Android in a notification channel of its own, whose id
 * is the kind, so the operator can mute or silence one kind alone.
 */
export const NotificationKind = Schema.Literals([
  "message",
  "handoff",
  "question",
  "approval",
  "secret-request",
  /** A connector card: a bot suggests one, or one it called needs a sign-in again. */
  "connector",
]);
export type NotificationKind = typeof NotificationKind.Type;

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
   * allow previews, or when the entry has no text of its own.
   */
  preview: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PREVIEW_LENGTH))),
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
 * in from the app"). Each is new in 0.3.0, at protocol 7: a client calls them
 * only on a server it runs itself, of its own release, and a server from
 * before answers each with a defect, which the client shows as the command
 * to run instead.
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
    payload: { harness: SignInHarness, start: Schema.Boolean },
    success: ProviderSignInStatus,
    stream: true,
  }),
  /** Stops the harness's sign-in under way, if any. Its home is as it was. */
  Rpc.make("provider.cancelSignIn", { payload: { harness: SignInHarness } }),
  /**
   * Connects Claude Code and Codex to an endpoint, as `j3-bots provider
   * connect` does, restarting the engine. It has no command id: a receipt
   * would keep the key. Sending it again stores the same connection again.
   */
  Rpc.make("provider.connect", {
    payload: ProviderConnectionRequest,
    success: ProviderConnectionOutcome,
  }),
);

/**
 * Connectors (docs/architecture/server.md, "Connectors"): the gallery to find
 * them in, and the operator's own, which every paired client may add, sign in
 * to, share among bots and remove. New in 0.4.0, at protocol 8.
 *
 * Nothing a connector holds leaves the server: a token, a key, a header's
 * value, a sign-in's code or `state`. What a client sends of them travels
 * redacted, and the requests that carry one (`connector.add`,
 * `connector.update`, `connector.beginSignIn`, `connector.completeSignIn`)
 * have no command id, since a receipt would keep it; each is safe to send
 * again instead. A request that needs a connector's secrets fails with
 * `Conflict("vault-locked")` while the vault is locked, and one that would
 * keep a secret, with `Conflict("vault-not-set-up")` before the vault has a
 * master password (decision 0028).
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
   * a grant, a tool list or a review. Small, and always starts afresh.
   */
  Rpc.make("connectors.subscribe", {
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", { connectors: Schema.Array(Connector) }),
      Schema.TaggedStruct("changed", {
        upsert: Schema.Array(Connector),
        remove: Schema.Array(ConnectorId),
      }),
    ]),
    stream: true,
  }),
  /**
   * Adds the connector as `id`, its secrets to the vault, and lists its tools
   * when it needs no sign-in; one that does is added as `needs-sign-in`, and
   * `connector.beginSignIn` follows. When `id` is added already, nothing
   * changes and the connector is returned as it is, so a retry adds nothing.
   * `grant` left out gives it to the bot whose card `suggestion` is, else the
   * primary bot, else no bot. With `suggestion`, that bot's card closes once
   * the bot can use it. Fails with `Conflict("private-network")` for an
   * address in the operator's own network without `privateNetwork`,
   * `Invalid("connector-fields")` for a form's values that do not fit it, and
   * `Invalid("connector-unsupported")` for an entry J3 Bots cannot connect.
   */
  Rpc.make("connector.add", {
    payload: {
      id: ConnectorId,
      source: ConnectorSource,
      grant: Schema.optionalKey(ConnectorGrant),
      suggestion: Schema.NullOr(EntryId),
    },
    success: Connector,
    error: CommandError,
  }),
  /**
   * Renames the connector, or replaces the values its form took, such as a
   * token the service refused: fields left out keep their value, and so does
   * each value `values` does not name.
   */
  Rpc.make("connector.update", {
    payload: {
      connectorId: ConnectorId,
      name: Schema.optionalKey(Connector.fields.name),
      values: Schema.optionalKey(ConnectorFieldValues),
    },
    success: Connector,
    error: CommandError,
  }),
  /**
   * Removes the connector: bots lose its tools at once, its sign-in is
   * revoked at the service when the service offers that, and its secrets
   * leave the vault. The operator's account at the service is not changed.
   * Removing one already gone succeeds.
   */
  Rpc.make("connector.remove", {
    payload: { ...command, connectorId: ConnectorId },
    error: CommandError,
  }),
  /** Replaces which bots may use the connector. A bot that gains it gets its tools from its next model call. */
  Rpc.make("connector.setBots", {
    payload: { ...command, connectorId: ConnectorId, grant: ConnectorGrant },
    success: Connector,
    error: CommandError,
  }),
  /**
   * Starts a sign-in for the connector, which this device opens in the system
   * browser; it returns to the server or to this device as `redirect` says.
   * The sign-in is this device's alone and lasts ten minutes; another starts
   * a new one. Fails with `Conflict("no-server-redirect")` for `server` where
   * the server cannot be returned to, `Conflict("sign-in-unsupported")` or
   * `Conflict("registration-refused")` when the service does not sign in as
   * J3 Bots requires, and `Invalid` for a connector that signs in no other way
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
   * `Conflict("sign-in-refused")` when the service refused it.
   */
  Rpc.make("connector.completeSignIn", {
    payload: { url: SignInCallback },
    error: CommandError,
  }),
  /**
   * Answers the connector's held tool changes, as the review at `revision`
   * showed them: `accept` gives bots those tools as they now are; `keep`
   * leaves bots the tools they had, and the review closes until the tools
   * change again. Fails with `Conflict("tool-review-stale")`, changing
   * nothing, when they changed after that review or none wait.
   */
  Rpc.make("connector.acceptToolChanges", {
    payload: {
      ...command,
      connectorId: ConnectorId,
      revision: ToolReviewRevision,
      decision: Schema.Literals(["accept", "keep"]),
    },
    success: Connector,
    error: CommandError,
  }),
);

/** Every RPC a paired client can make, on the socket at `HTTP_PATHS.rpc`. */
export const J3Rpcs = RosterRpcs.merge(
  EntryRpcs,
  BotRpcs,
  SectionRpcs,
  RoomRpcs,
  RoutineRpcs,
  MemoryRpcs,
  EngineRpcs,
  SettingsRpcs,
  ClientRpcs,
  ProviderRpcs,
  ConnectorRpcs,
);
