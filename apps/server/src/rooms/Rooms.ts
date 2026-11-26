// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandError,
  type CommandId,
  Conflict,
  Invalid,
  NotFound,
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
import { roomRefusals } from "../turns/modeRefusals.ts";
import { RoomStates } from "../turns/RoomStates.ts";
import {
  type Shown,
  visibilityCommand,
  VisibilityRefused,
  visibilityRefusal,
} from "../roster/visibility.ts";
import { RoomWork } from "./RoomWork.ts";

const RoomRow = Schema.Struct({
  id: RoomId,
  name: Schema.String,
  status: Schema.Literals(["active", "archived"]),
  pinned: Flag,
  hidden: Flag,
  archived_at: Schema.NullOr(Time),
  created_at: Time,
});

const MemberRow = Schema.Struct({ room_id: RoomId, bot_id: BotId });

const decodeRoom = Schema.decodeUnknownEffect(Room);

/** The changes `room.update` may ask for. */
export interface RoomChanges {
  readonly name?: string;
  readonly members?: ReadonlyArray<BotId>;
  readonly pinned?: boolean;
  /** Recorded as the operator's choice, which no bot changes afterwards (decision 0050). */
  readonly hidden?: boolean;
  readonly archived?: boolean;
}

/**
 * Rooms: their members and status. An active room has two to six members,
 * all equal; an archived room takes no changes but `pinned`, `hidden` and
 * unarchiving (`docs/architecture/server.md`, Rooms).
 */
export class Rooms extends Context.Service<
  Rooms,
  {
    readonly find: (id: RoomId) => Effect.Effect<Option.Option<Room>>;
    /** Every room, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<Room>>;
    /** The rooms `botId` is a member of. */
    readonly ofBot: (botId: BotId) => Effect.Effect<ReadonlyArray<Room>>;
    /** The operator's room, whose visibility is their choice. */
    readonly create: (input: {
      readonly commandId: CommandId;
      readonly name: string;
      readonly members: ReadonlyArray<BotId>;
      readonly hidden?: boolean;
    }) => Effect.Effect<Room, CommandError>;
    /**
     * Creates a room as `create` does, in the caller's transaction and under no receipt: for a bot's
     * `start_room`, which its turn tool's pin applies once. Its visibility is
     * the choice of `madeBy`, the bot that starts it.
     */
    readonly open: (input: {
      readonly name: string;
      readonly members: ReadonlyArray<BotId>;
      readonly hidden: boolean;
      readonly madeBy: BotId;
    }) => Effect.Effect<Room, Invalid>;
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly roomId: RoomId;
      readonly changes: RoomChanges;
    }) => Effect.Effect<Room, CommandError>;
    /**
     * A bot's `set_visibility` for a room, as `Bots.showOrHide` is for a bot:
     * decided by `visibilityRefusal` in the transaction that saves it.
     * Archived rooms included.
     */
    readonly showOrHide: (input: {
      readonly commandId: CommandId;
      readonly caller: BotId;
      readonly roomId: RoomId;
      readonly hidden: boolean;
    }) => Effect.Effect<Shown, CommandError | VisibilityRefused>;
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
     * transaction: an active room left with fewer than two members is
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
    const work = yield* RoomWork;
    const states = yield* RoomStates;
    const ids = yield* Ids;
    const attachments = yield* Attachments;
    const refusals = roomRefusals(sql, yield* Entries);

    const SELECT = sql.literal(`
      SELECT id, name, status, pinned, hidden, archived_at, created_at
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
      const activity = yield* states.activityOf(roomIds);
      return yield* Effect.forEach(rows, (row) =>
        decodeRoom({
          id: row.id,
          name: row.name,
          pinned: row.pinned,
          hidden: row.hidden,
          createdAt: row.created_at,
          status: row.status,
          members: members.filter((member) => member.room_id === row.id).map((m) => m.bot_id),
          ...(row.archived_at === null
            ? {
                work: activity.get(row.id)?.work ?? "none",
                answering: activity.get(row.id)?.answering ?? [],
              }
            : { archivedAt: row.archived_at }),
        }),
      );
    }, Effect.orDie);

    /**
     * The rooms, their members and what runs in them, read in one transaction,
     * so a frame never pairs members in one order with who is answering read
     * after a reorder.
     */
    const select = Effect.fn("Rooms.select")(function* (filter: {
      readonly id: RoomId | null;
      readonly botId: BotId | null;
    }) {
      return yield* transaction(Effect.flatMap(roomRows(filter), toRooms)).pipe(Effect.orDie);
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

    /** Two to six distinct bots that exist. */
    const checkMembers = Effect.fn("Rooms.checkMembers")(function* (members: ReadonlyArray<BotId>) {
      const distinct = new Set(members);
      const known = yield* sql<{ readonly id: string }>`
        SELECT id FROM bots WHERE ${sql.in("id", [...distinct])}
      `.pipe(Effect.orDie);
      if (
        distinct.size !== members.length ||
        members.length < 2 ||
        members.length > 6 ||
        known.length !== distinct.size
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

    /** A new room, made by the operator when `madeBy` is null, whose choice its visibility then is. */
    const insert = Effect.fn("Rooms.insert")(function* (input: {
      readonly name: string;
      readonly members: ReadonlyArray<BotId>;
      readonly hidden: boolean;
      readonly madeBy: BotId | null;
    }) {
      yield* checkMembers(input.members);
      const id = RoomId.make(yield* ids.make("room"));
      const at = timeText(yield* DateTime.now);
      yield* sql`
        INSERT INTO rooms (
          id, name, hidden, made_by_bot_id, visibility_by_operator, created_at, updated_at
        ) VALUES (
          ${id}, ${input.name}, ${input.hidden ? 1 : 0}, ${input.madeBy},
          ${input.madeBy === null ? 1 : 0}, ${at}, ${at}
        )
      `.pipe(Effect.orDie);
      yield* writeMembers(id, input.members);
      yield* refusals.joined(id, input.members);
      yield* changes.touch({ _tag: "room", roomId: id });
      return yield* require(id).pipe(Effect.orDie);
    });

    const create = Effect.fn("Rooms.create")(function* (input: {
      readonly commandId: CommandId;
      readonly name: string;
      readonly members: ReadonlyArray<BotId>;
      readonly hidden?: boolean;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        method: "room.create",
        payload: input,
        result: Room,
        apply: insert({
          name: input.name,
          members: input.members,
          hidden: input.hidden === true,
          madeBy: null,
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
          const changesMore = change.name !== undefined || change.members !== undefined;
          if (room.status === "archived" && change.archived !== false && changesMore) {
            return yield* new Conflict({ reason: "room-archived" });
          }
          const now = yield* DateTime.now;
          const at = timeText(now);
          const members = change.members ?? room.members;
          const active =
            change.archived === undefined ? room.status === "active" : !change.archived;
          if (active && (changesMore || room.status === "archived")) {
            yield* checkMembers(members);
          }
          yield* sql`
            UPDATE rooms SET ${sql.update({
              name: change.name ?? room.name,
              pinned: (change.pinned ?? room.pinned) ? 1 : 0,
              ...(change.hidden === undefined
                ? {}
                : { hidden: change.hidden ? 1 : 0, visibility_by_operator: 1 }),
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

    const VisibilityRow = Schema.Struct({
      name: Schema.String,
      hidden: Flag,
      made_by_bot_id: Schema.NullOr(BotId),
      visibility_by_operator: Flag,
    });
    const visibilityOf = SqlSchema.findOneOption({
      Request: RoomId,
      Result: VisibilityRow,
      execute: (id) => sql`
        SELECT name, hidden, made_by_bot_id, visibility_by_operator FROM rooms WHERE id = ${id}
      `,
    });
    const CallerRow = Schema.Struct({ is_primary: Flag });
    const callerOf = SqlSchema.findOneOption({
      Request: BotId,
      Result: CallerRow,
      execute: (id) => sql`SELECT is_primary FROM bots WHERE id = ${id}`,
    });

    const showOrHide = Effect.fn("Rooms.showOrHide")(function* (input: {
      readonly commandId: CommandId;
      readonly caller: BotId;
      readonly roomId: RoomId;
      readonly hidden: boolean;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        ...visibilityCommand({ caller: input.caller, id: input.roomId, hidden: input.hidden }),
        apply: Effect.gen(function* () {
          const room = yield* visibilityOf(input.roomId).pipe(Effect.orDie);
          if (Option.isNone(room)) return yield* new NotFound({ resource: "room" });
          const caller = yield* callerOf(input.caller).pipe(Effect.orDie);
          if (Option.isNone(caller)) return yield* new NotFound({ resource: "bot" });
          const refusal = visibilityRefusal(
            { id: input.caller, primary: caller.value.is_primary },
            {
              name: room.value.name,
              primary: false,
              madeBy: room.value.made_by_bot_id,
              byOperator: room.value.visibility_by_operator,
            },
          );
          if (refusal !== undefined) return yield* refusal;
          if (room.value.hidden !== input.hidden) {
            const at = timeText(yield* DateTime.now);
            yield* sql`
              UPDATE rooms SET hidden = ${input.hidden ? 1 : 0}, updated_at = ${at}
              WHERE id = ${input.roomId}
            `.pipe(Effect.orDie);
            yield* changes.touch({ _tag: "room", roomId: input.roomId });
          }
          return { id: input.roomId, hidden: input.hidden };
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
        yield* writeMembers(room.id, rest);
        if (room.status === "active" && rest.length < 2) yield* archive(room.id, now);
        else {
          yield* sql`UPDATE rooms SET updated_at = ${timeText(now)} WHERE id = ${room.id}`.pipe(
            Effect.orDie,
          );
        }
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
      open: insert,
      update,
      showOrHide,
      remove,
      stop,
      releaseBot,
    });
  }),
);
