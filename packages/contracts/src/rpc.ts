// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { BotFile, MAX_ATTACHMENTS_PER_MESSAGE } from "./attachment.ts";
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
  Sequence,
} from "./base.ts";
import { Avatar, Bot, ModelChoice, PermissionMode, Profile } from "./bot.ts";
import { Device, PairingCode } from "./device.ts";
import { EngineStatus, UsageTurn } from "./engineStatus.ts";
import {
  ApprovalDecision,
  Entry,
  EntryPreview,
  EntryTarget,
  Mentions,
  MessageText,
  QuestionAnswers,
  WorkStep,
} from "./entry.ts";
import { CommandError, NotFound } from "./errors.ts";
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
import { Budgets, NotificationSettings, Settings, TimeZone } from "./settings.ts";

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
// client retries freely after a dropped connection. `secret.provide` is the one
// exception: its value must never be stored, so it has no receipt (see there).
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

/** Who the operator has, and what each is doing. */
export const RosterRpcs = RpcGroup.make(
  Rpc.make("roster.subscribe", {
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", { items: Schema.Array(RosterItem) }),
      Schema.TaggedStruct("changed", {
        upsert: Schema.Array(RosterItem),
        remove: Schema.Array(RosterItemKey),
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
        entries: Schema.Array(Entry),
        hasOlder: Schema.Boolean,
      }),
      Schema.TaggedStruct("changed", { sequence: Sequence, upsert: Schema.Array(Entry) }),
    ]),
    error: NotFound,
    stream: true,
  }),
  /** Entries before `before`, oldest first, for scrolling back. */
  Rpc.make("entries.history", {
    payload: { target: EntryTarget, before: EntryOrder, limit: HistoryLimit },
    success: Schema.Struct({ entries: Schema.Array(Entry), hasOlder: Schema.Boolean }),
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
   * Returns the new message entry. `attachments` are uploaded first with
   * `POST /attachments`. `mentions` only applies in a room; leaving it out
   * mentions nobody. Fails with `Invalid("attachment")`, writing nothing, when
   * the files break a limit of the engine that runs the bot: an empty file, an
   * inline image (GIF, JPEG, PNG or WebP) over 10 MiB, or inline images over
   * 80 MiB together. Fails with `Conflict("room-archived")` in an archived room.
   */
  Rpc.make("message.send", {
    payload: {
      ...command,
      target: EntryTarget,
      text: MessageText,
      attachments: Schema.Array(AttachmentId).check(
        Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE),
      ),
      mentions: Schema.optionalKey(Mentions),
    },
    success: EntryId,
    error: CommandError,
  }),
  /**
   * Resolves a question or approval card everywhere. Answering or dismissing an
   * `ask` question wakes the bot with the answer; answering an `engine` question
   * or an approval lets the turn that raised it continue.
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
   * Answers how the card resolved. `confirmed` is true only when this call's
   * own answer is the one the engine took. Otherwise the card was already
   * closed, or the engine's reply was lost and a retry found it closed: the
   * resolution is what the card shows, which may be this answer, another
   * device's, or `expired`. Only a confirmed `provided` or `declined` means
   * this call did it; `expired` means no answer was taken.
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
    success: Schema.Struct({
      resolution: Schema.Literals(["provided", "declined", "expired"]),
      confirmed: Schema.Boolean,
    }),
    error: CommandError,
  }),
  /** Runs again what a retryable notice says failed. */
  Rpc.make("notice.retry", {
    payload: { ...command, entryId: EntryId },
    error: CommandError,
  }),
);

const ProfileChanges = Schema.Struct({
  name: Schema.optionalKey(Profile.fields.name),
  title: Schema.optionalKey(Profile.fields.title),
  avatar: Schema.optionalKey(Avatar),
  job: Schema.optionalKey(Profile.fields.job),
});

export const BotRpcs = RpcGroup.make(
  /** Fields left out take the server's defaults: a free avatar, the first ready model. */
  Rpc.make("bot.create", {
    payload: {
      ...command,
      name: Profile.fields.name,
      title: Schema.optionalKey(Profile.fields.title),
      avatar: Schema.optionalKey(Avatar),
      job: Schema.optionalKey(Profile.fields.job),
      model: Schema.optionalKey(ModelChoice),
      permissionMode: Schema.optionalKey(PermissionMode),
      primary: Schema.optionalKey(Schema.Boolean),
    },
    success: Bot,
    error: CommandError,
  }),
  Rpc.make("bot.update", {
    payload: {
      ...command,
      botId: BotId,
      profile: Schema.optionalKey(ProfileChanges),
      model: Schema.optionalKey(ModelChoice),
      permissionMode: Schema.optionalKey(PermissionMode),
      primary: Schema.optionalKey(Schema.Boolean),
      pinned: Schema.optionalKey(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean),
    },
    success: Bot,
    error: CommandError,
  }),
  /**
   * Ends the bot's running work and cancels the messages and wakes it has not
   * received yet. What was already done stays done.
   */
  Rpc.make("bot.stop", { payload: { ...command, botId: BotId }, error: CommandError }),
  /** Resets the bot's working context. Conversation, memory, routines and files stay. */
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
  /** Files the bot delivered, newest first, before `before`. */
  Rpc.make("bot.files", {
    payload: { botId: BotId, before: Schema.NullOr(AttachmentId), limit: HistoryLimit },
    success: Schema.Struct({ files: Schema.Array(BotFile), hasOlder: Schema.Boolean }),
    error: NotFound,
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
  /** Turns that started after `since`, newest first, at most `limit`. */
  Rpc.make("usage.turns", {
    payload: {
      since: Schema.DateTimeUtc,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    },
    success: Schema.Struct({ turns: Schema.Array(UsageTurn), hasMore: Schema.Boolean }),
  }),
);

export const SettingsRpcs = RpcGroup.make(
  Rpc.make("settings.get", { success: Settings }),
  /** Fields left out keep their value. Returns the settings as saved. */
  Rpc.make("settings.update", {
    payload: {
      ...command,
      timeZone: Schema.optionalKey(TimeZone),
      budgets: Schema.optionalKey(Budgets),
      notifications: Schema.optionalKey(NotificationSettings),
    },
    success: Settings,
    error: CommandError,
  }),
);

export const Notification = Schema.Struct({
  target: EntryTarget,
  entryId: EntryId,
  reason: Schema.Literals(["entry", "waiting"]),
});
export type Notification = typeof Notification.Type;

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
  Rpc.make("pairing.start", {
    success: Schema.Struct({ code: PairingCode, expiresAt: Schema.DateTimeUtc }),
  }),
  /** Closes that device's sockets at once and refuses its token from now on. */
  Rpc.make("device.revoke", {
    payload: { ...command, deviceId: DeviceId },
    error: NotFound,
  }),
);

/** Every RPC a paired client can make, on the socket at `HTTP_PATHS.rpc`. */
export const J3Rpcs = RosterRpcs.merge(
  EntryRpcs,
  BotRpcs,
  RoomRpcs,
  RoutineRpcs,
  MemoryRpcs,
  EngineRpcs,
  SettingsRpcs,
  ClientRpcs,
);
