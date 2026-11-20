import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import {
  BotId,
  CommandId,
  DeviceId,
  EntryId,
  Label,
  PositiveInt,
  RoomId,
  RoutineId,
  RoutineRunId,
  Sequence,
} from "./base.ts";
import { Avatar, Bot, ModelChoice, PermissionMode, Profile } from "./bot.ts";
import { Device, DeviceToken, PairingCode } from "./device.ts";
import { EngineStatus, UsageTurn } from "./engineStatus.ts";
import {
  ApprovalDecision,
  Entry,
  EntryTarget,
  MessageText,
  QuestionAnswers,
  WorkStep,
} from "./entry.ts";
import { CommandError, Invalid, NotAuthenticated, NotFound } from "./errors.ts";
import {
  MemoryDocument,
  MemoryFile,
  MemoryPath,
  MemoryRevision,
  MemoryScope,
  MemoryText,
} from "./memory.ts";
import { Room, RoomMembers } from "./room.ts";
import { Routine, RoutineInstruction, RoutineRun, RoutineTrigger } from "./routine.ts";

/** Where clients open the WebSocket that carries every RPC in this file. */
export const RPC_PATH = "/ws";

/**
 * Bumped when a change to these groups would break a client built against the
 * previous version. Clients compare it with `server.info` before anything else.
 */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Conventions
//
// Subscriptions (`*.subscribe`) stream a snapshot first and then changes. Each
// frame carries a sequence; a client stores the sequence of the last frame it
// applied and passes it as `after` when it subscribes again. If the server can
// replay from there it sends only the newer changes; otherwise it sends a fresh
// snapshot, which replaces what the client holds. Changes carry whole entities,
// never deltas: the client upserts by id.
//
// Commands carry a client-generated `commandId`. Sending the same command again
// with the same id has no further effect and returns the first result, so a
// client retries freely after a dropped connection.
// ---------------------------------------------------------------------------

const after = { after: Schema.NullOr(Sequence) };
const command = { commandId: CommandId };

export const ServerInfo = Schema.Struct({
  protocolVersion: PositiveInt,
  /** The J3 Bots release. */
  version: Label,
  startedAt: Schema.DateTimeUtc,
});
export type ServerInfo = typeof ServerInfo.Type;

// The two groups a client may use before it is paired.

/** The first request a client makes: it checks `protocolVersion` before anything else. */
export const ServerRpcs = RpcGroup.make(Rpc.make("server.info", { success: ServerInfo }));

export const PairingRpcs = RpcGroup.make(
  /** Exchanges a pairing code for this client's device token. */
  Rpc.make("device.pair", {
    payload: { code: PairingCode, name: Label },
    success: Schema.Struct({ deviceId: DeviceId, token: DeviceToken }),
    error: Invalid,
  }),
);

/** The paired device that made the current request. */
export class CurrentDevice extends Context.Service<CurrentDevice, { readonly id: DeviceId }>()(
  "@j3-bots/contracts/rpc/CurrentDevice",
) {}

/**
 * Every request outside `ServerRpcs` and `PairingRpcs` carries the device token in its
 * `authorization` header as `Bearer <token>`. Revoking a device fails its next
 * request and ends its open subscriptions with `NotAuthenticated`.
 */
export class DeviceAuth extends RpcMiddleware.Service<DeviceAuth, { provides: CurrentDevice }>()(
  "@j3-bots/contracts/rpc/DeviceAuth",
  { error: NotAuthenticated, requiredForClient: true },
) {}

export const RosterItem = Schema.Union([
  Schema.TaggedStruct("bot", {
    bot: Bot,
    lastEntry: Schema.NullOr(Entry),
    lastActivityAt: Schema.NullOr(Schema.DateTimeUtc),
    unread: Schema.Boolean,
  }),
  Schema.TaggedStruct("room", {
    room: Room,
    lastEntry: Schema.NullOr(Entry),
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
    payload: after,
    success: Schema.Union([
      Schema.TaggedStruct("snapshot", { sequence: Sequence, items: Schema.Array(RosterItem) }),
      Schema.TaggedStruct("changed", {
        sequence: Sequence,
        upsert: Schema.Array(RosterItem),
        remove: Schema.Array(RosterItemKey),
      }),
    ]),
    stream: true,
  }),
).middleware(DeviceAuth);

/** A conversation or a room: what was said, what is running, what is asked. */
export const EntryRpcs = RpcGroup.make(
  /**
   * The snapshot holds the most recent entries; older ones are read with
   * `entries.history`. The stream fails with `NotFound` if the bot or room is
   * deleted.
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
    payload: { target: EntryTarget, before: EntryId, limit: HistoryLimit },
    success: Schema.Struct({ entries: Schema.Array(Entry), hasOlder: Schema.Boolean }),
    error: NotFound,
  }),
  /** The steps of a work fold, in order, when the operator opens it. */
  Rpc.make("entries.workSteps", {
    payload: { entryId: EntryId },
    success: Schema.Array(WorkStep),
    error: NotFound,
  }),
  /** Everything up to `through` has been read. Moving the mark backwards is ignored. */
  Rpc.make("entries.markRead", {
    payload: { target: EntryTarget, through: EntryId },
    error: NotFound,
  }),
  /** Returns the new message entry. */
  Rpc.make("message.send", {
    payload: { ...command, target: EntryTarget, text: MessageText.check(Schema.isMinLength(1)) },
    success: EntryId,
    error: CommandError,
  }),
  /** Resolves a question or approval card everywhere. */
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
  /** Runs again what a retryable notice says failed. */
  Rpc.make("notice.retry", {
    payload: { ...command, entryId: EntryId },
    error: CommandError,
  }),
).middleware(DeviceAuth);

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
  /** Ends the bot's running work. What was already done stays done. */
  Rpc.make("bot.stop", { payload: { ...command, botId: BotId }, error: CommandError }),
  /** Resets the bot's working context. Conversation, memory, routines and files stay. */
  Rpc.make("bot.freshStart", { payload: { ...command, botId: BotId }, error: CommandError }),
  /** Removes the bot, its conversation, memory and routines. */
  Rpc.make("bot.delete", {
    payload: { ...command, botId: BotId, deleteFiles: Schema.Boolean },
    error: CommandError,
  }),
).middleware(DeviceAuth);

export const RoomRpcs = RpcGroup.make(
  Rpc.make("room.create", {
    payload: {
      ...command,
      name: Room.fields.name,
      members: RoomMembers,
      hostId: BotId,
      hopLimit: Schema.optionalKey(Room.fields.hopLimit),
    },
    success: Room,
    error: CommandError,
  }),
  Rpc.make("room.update", {
    payload: {
      ...command,
      roomId: RoomId,
      name: Schema.optionalKey(Room.fields.name),
      members: Schema.optionalKey(RoomMembers),
      hostId: Schema.optionalKey(BotId),
      hopLimit: Schema.optionalKey(Room.fields.hopLimit),
      pinned: Schema.optionalKey(Schema.Boolean),
    },
    success: Room,
    error: CommandError,
  }),
  Rpc.make("room.delete", { payload: { ...command, roomId: RoomId }, error: CommandError }),
).middleware(DeviceAuth);

export const RoutineRpcs = RpcGroup.make(
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
).middleware(DeviceAuth);

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
).middleware(DeviceAuth);

export const EngineRpcs = RpcGroup.make(
  Rpc.make("engine.subscribe", {
    payload: after,
    success: Schema.Struct({ sequence: Sequence, status: EngineStatus }),
    stream: true,
  }),
  /** Turns that started after `since`, newest first. */
  Rpc.make("usage.turns", {
    payload: { since: Schema.DateTimeUtc },
    success: Schema.Array(UsageTurn),
  }),
).middleware(DeviceAuth);

export const Notification = Schema.Struct({
  target: EntryTarget,
  entryId: EntryId,
  reason: Schema.Literals(["entry", "waiting"]),
});
export type Notification = typeof Notification.Type;

export const ClientRpcs = RpcGroup.make(
  /**
   * What the operator is looking at on this connection. The server notifies
   * about entries in a target no connected client has in view.
   */
  Rpc.make("client.view", { payload: { target: Schema.NullOr(EntryTarget) } }),
  /** Notifications for this connection to show. Live only: missed ones are not replayed. */
  Rpc.make("notifications.subscribe", { success: Notification, stream: true }),
  Rpc.make("devices.list", { success: Schema.Array(Device) }),
  /** A code a new client can pair with, shown on this one. */
  Rpc.make("pairing.start", {
    success: Schema.Struct({ code: PairingCode, expiresAt: Schema.DateTimeUtc }),
  }),
  /** Closes that device's connection and refuses its token from now on. */
  Rpc.make("device.revoke", {
    payload: { ...command, deviceId: DeviceId },
    error: NotFound,
  }),
).middleware(DeviceAuth);

/** Every RPC a J3 Bots client can make, served at `RPC_PATH`. */
export const J3Rpcs = ServerRpcs.merge(
  PairingRpcs,
  RosterRpcs,
  EntryRpcs,
  BotRpcs,
  RoomRpcs,
  RoutineRpcs,
  MemoryRpcs,
  EngineRpcs,
  ClientRpcs,
);
