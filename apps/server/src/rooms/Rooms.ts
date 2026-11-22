// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandError,
  type CommandId,
  Conflict,
  Invalid,
  NotFound,
  PositiveInt,
  Room,
  RoomId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Attachments } from "../attachments/Attachments.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Flag, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { roomRefusals } from "../turns/modeRefusals.ts";
import { RoomStates } from "../turns/RoomStates.ts";
import { RoomWork } from "./RoomWork.ts";

const RoomRow = Schema.Struct({
  id: RoomId,
  name: Schema.String,
  status: Schema.Literals(["active", "archived"]),
  host_bot_id: Schema.NullOr(BotId),
  hop_limit: PositiveInt,
  pinned: Flag,
  archived_at: Schema.NullOr(Time),
  created_at: Time,
});

const MemberRow = Schema.Struct({ room_id: RoomId, bot_id: BotId });

const decodeRoom = Schema.decodeUnknownEffect(Room);

/** The changes `room.update` may ask for. */
export interface RoomChanges {
  readonly name?: string;
  readonly members?: ReadonlyArray<BotId>;
  readonly hostId?: BotId;
  readonly hopLimit?: number;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

/**
 * Rooms: their members, host and status. An active room has two to six
 * members and a host among them; an archived room takes no changes but
 * `pinned` and unarchiving (`docs/architecture/server.md`, Rooms).
 */
export class Rooms extends Context.Service<
  Rooms,
  {
    readonly find: (id: RoomId) => Effect.Effect<Option.Option<Room>>;
    /** Every room, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<Room>>;
    /** The rooms `botId` is a member of. */
    readonly ofBot: (botId: BotId) => Effect.Effect<ReadonlyArray<Room>>;
    readonly create: (input: {
      readonly commandId: CommandId;
      readonly name: string;
      readonly members: ReadonlyArray<BotId>;
      readonly hostId: BotId;
      readonly hopLimit?: number;
    }) => Effect.Effect<Room, CommandError>;
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
      readonly changes: RoomChanges;
    }) => Effect.Effect<Room, CommandError>;
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
    }) => Effect.Effect<void, CommandError>;
    /**
     * `room.stop`: stops the work addressed to an active room, as a bot's
     * Stop stops a bot's, without archiving it. Its cards stay open.
     */
    readonly stop: (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
    }) => Effect.Effect<void, CommandError>;
    /**
     * Takes `botId` out of every room before it is deleted, in the caller's
     * transaction: a room it hosted passes to the member who joined first
     * among the rest, and an active room left with fewer than two members is
     * archived.
     */
    readonly releaseBot: (botId: BotId) => Effect.Effect<void>;
  }
>()("@j3-bots/server/rooms/Rooms") {}

export const layer = Layer.effect(
  Rooms,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const changes = yield* ChangeLog;
    const receipts = yield* CommandReceipts;
    const settings = yield* SettingsStore;
    const work = yield* RoomWork;
    const states = yield* RoomStates;
    const ids = yield* Ids;
    const attachments = yield* Attachments;
    const refusals = roomRefusals(sql, yield* Entries);

    const SELECT = sql.literal(`
      SELECT id, name, status, host_bot_id, hop_limit, pinned, archived_at, created_at
      FROM rooms
    `);
    const roomRows = SqlSchema.findAll({
      Request: Schema.Struct({ id: Schema.NullOr(RoomId), botId: Schema.NullOr(BotId) }),
      Result: RoomRow,
      execute: ({ id, botId }) =>
        id !== null
          ? sql`${SELECT} WHERE id = ${id}`
          : botId !== null
            ? sql`${SELECT} WHERE id IN (SELECT room_id FROM room_members WHERE bot_id = ${botId})
                ORDER BY created_at, id`
            : sql`${SELECT} ORDER BY created_at, id`,
    });
    const memberRows = SqlSchema.findAll({
      Request: Schema.Array(RoomId),
      Result: MemberRow,
      execute: (roomIds) =>
        sql`SELECT room_id, bot_id FROM room_members WHERE ${sql.in("room_id", roomIds)}
          ORDER BY room_id, position`,
    });

    const toRooms = Effect.fn("Rooms.toRooms")(function* (
      rows: ReadonlyArray<typeof RoomRow.Type>,
    ) {
      if (rows.length === 0) return [];
      const roomIds = rows.map((row) => row.id);
      const members = yield* memberRows(roomIds);
      const working = yield* states.workOf(roomIds);
      return yield* Effect.forEach(rows, (row) =>
        decodeRoom({
          id: row.id,
          name: row.name,
          hopLimit: row.hop_limit,
          pinned: row.pinned,
          createdAt: row.created_at,
          status: row.status,
          members: members.filter((member) => member.room_id === row.id).map((m) => m.bot_id),
          hostId: row.host_bot_id,
          ...(row.archived_at === null
            ? { work: working.get(row.id) ?? "none" }
            : { archivedAt: row.archived_at }),
        }),
      );
    }, Effect.orDie);

    const select = Effect.fn("Rooms.select")(function* (filter: {
      readonly id: RoomId | null;
      readonly botId: BotId | null;
    }) {
      return yield* toRooms(yield* roomRows(filter).pipe(Effect.orDie));
    });

    const find = Effect.fn("Rooms.find")(function* (id: RoomId) {
      const [room] = yield* select({ id, botId: null });
      return Option.fromNullishOr(room);
    });

    const require = Effect.fn("Rooms.require")(function* (id: RoomId) {
      const room = yield* find(id);
      if (Option.isNone(room)) return yield* new NotFound({ resource: "room" });
      return room.value;
    });

    /** Two to six distinct bots that exist, with the host among them. */
    const checkMembers = Effect.fn("Rooms.checkMembers")(function* (
      members: ReadonlyArray<BotId>,
      hostId: BotId,
    ) {
      const distinct = new Set(members);
      const known = yield* sql<{ readonly id: string }>`
        SELECT id FROM bots WHERE ${sql.in("id", [...distinct])}
      `.pipe(Effect.orDie);
      if (
        distinct.size !== members.length ||
        members.length < 2 ||
        members.length > 6 ||
        known.length !== distinct.size ||
        !distinct.has(hostId)
      ) {
        return yield* new Invalid({ reason: "room-members" });
      }
    });

    const writeMembers = Effect.fn("Rooms.writeMembers")(function* (
      roomId: RoomId,
      members: ReadonlyArray<BotId>,
    ) {
      yield* sql`DELETE FROM room_members WHERE room_id = ${roomId}`;
      for (const [position, botId] of members.entries()) {
        yield* sql`
          INSERT INTO room_members (room_id, bot_id, position)
          VALUES (${roomId}, ${botId}, ${position})
        `;
      }
    }, Effect.orDie);

    const archive = Effect.fn("Rooms.archive")(function* (roomId: RoomId, at: DateTime.Utc) {
      yield* sql`
        UPDATE rooms SET status = 'archived', archived_at = ${timeText(at)},
          updated_at = ${timeText(at)}
        WHERE id = ${roomId}
      `.pipe(Effect.orDie);
      yield* work.end(roomId);
    });

    const create = Effect.fn("Rooms.create")(function* (input: {
      readonly commandId: CommandId;
      readonly name: string;
      readonly members: ReadonlyArray<BotId>;
      readonly hostId: BotId;
      readonly hopLimit?: number;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        method: "room.create",
        payload: input,
        result: Room,
        apply: Effect.gen(function* () {
          yield* checkMembers(input.members, input.hostId);
          const id = RoomId.make(yield* ids.make("room"));
          const at = timeText(yield* DateTime.now);
          const hopLimit = input.hopLimit ?? (yield* settings.get).budgets.hops;
          yield* sql`
            INSERT INTO rooms (id, name, host_bot_id, hop_limit, created_at, updated_at)
            VALUES (${id}, ${input.name}, ${input.hostId}, ${hopLimit}, ${at}, ${at})
          `.pipe(Effect.orDie);
          yield* writeMembers(id, input.members);
          yield* refusals.joined(id, input.members);
          yield* changes.touch({ _tag: "room", roomId: id });
          return yield* require(id).pipe(Effect.orDie);
        }),
      });
    });

    const update = Effect.fn("Rooms.update")(function* (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
      readonly changes: RoomChanges;
    }) {
      const { changes: change } = input;
      return yield* receipts.once({
        commandId: input.commandId,
        method: "room.update",
        payload: input,
        result: Room,
        apply: Effect.gen(function* () {
          const room = yield* require(input.roomId);
          const changesMore =
            change.name !== undefined ||
            change.members !== undefined ||
            change.hostId !== undefined ||
            change.hopLimit !== undefined;
          if (room.status === "archived" && change.archived !== false && changesMore) {
            return yield* new Conflict({ reason: "room-archived" });
          }
          const now = yield* DateTime.now;
          const at = timeText(now);
          const members = change.members ?? room.members;
          const hostId = change.hostId ?? room.hostId;
          const active =
            change.archived === undefined ? room.status === "active" : !change.archived;
          if (active && (changesMore || room.status === "archived")) {
            if (hostId === null) return yield* new Invalid({ reason: "room-members" });
            yield* checkMembers(members, hostId);
          }
          yield* sql`
            UPDATE rooms SET ${sql.update({
              name: change.name ?? room.name,
              host_bot_id: hostId,
              hop_limit: change.hopLimit ?? room.hopLimit,
              pinned: (change.pinned ?? room.pinned) ? 1 : 0,
              updated_at: at,
              ...(active ? { status: "active", archived_at: null } : {}),
            })}
            WHERE id = ${room.id}
          `.pipe(Effect.orDie);
          if (change.members !== undefined) {
            yield* writeMembers(room.id, change.members);
            const stay = new Set(change.members);
            yield* work.leave(
              room.id,
              room.members.filter((botId) => !stay.has(botId)),
            );
          }
          if (!active && room.status === "active") yield* archive(room.id, now);
          if (active) {
            // A room taken out of the archive has every member arrive anew.
            const before = new Set(room.status === "active" ? room.members : []);
            yield* refusals.joined(
              room.id,
              members.filter((botId) => !before.has(botId)),
            );
          }
          yield* changes.touch({ _tag: "room", roomId: room.id });
          return yield* require(room.id).pipe(Effect.orDie);
        }),
      });
    });

    const remove = Effect.fn("Rooms.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "room.delete",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          yield* require(input.roomId);
          yield* work.end(input.roomId);
          // Its entries go with it, and the files only they carried.
          const carried = yield* attachments.ofTarget({ _tag: "room", roomId: input.roomId });
          yield* sql`DELETE FROM rooms WHERE id = ${input.roomId}`.pipe(Effect.orDie);
          yield* attachments.purge(carried);
          yield* changes.touch({ _tag: "room", roomId: input.roomId });
        }),
      });
    });

    const stop = Effect.fn("Rooms.stop")(function* (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "room.stop",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const room = yield* require(input.roomId);
          // An archived room's work was stopped when it was archived.
          if (room.status === "archived") return yield* new Conflict({ reason: "room-archived" });
          yield* work.stop(room.id);
          // The roster shows the room's work stopping, or already ended.
          yield* changes.touch({ _tag: "room", roomId: room.id });
        }),
      });
    });

    const releaseBot = Effect.fn("Rooms.releaseBot")(function* (botId: BotId) {
      const now = yield* DateTime.now;
      for (const room of yield* select({ id: null, botId })) {
        const rest = room.members.filter((member) => member !== botId);
        const archives = room.status === "active" && rest.length < 2;
        // A room that stays active passes to the member who joined first; one
        // archived here keeps no host.
        const nextHost = room.hostId !== botId ? room.hostId : archives ? null : (rest[0] ?? null);
        yield* writeMembers(room.id, rest);
        // Archived first: the database refuses an active room without a host.
        if (archives) yield* archive(room.id, now);
        yield* sql`
          UPDATE rooms SET host_bot_id = ${nextHost}, updated_at = ${timeText(now)}
          WHERE id = ${room.id}
        `.pipe(Effect.orDie);
        yield* changes.touch({ _tag: "room", roomId: room.id });
      }
    }, transaction);

    const ofBot = Effect.fn("Rooms.ofBot")(function* (botId: BotId) {
      return yield* select({ id: null, botId });
    });

    return Rooms.of({
      find,
      list: select({ id: null, botId: null }),
      ofBot,
      create,
      update,
      remove,
      stop,
      releaseBot,
    });
  }),
);
