// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoomId, RoomWorkState, type TurnWork } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import { modeRefusedSql } from "./modeRefusals.ts";
import { joinedWork, WorkJson } from "./turnWork.ts";

const WorkRow = Schema.Struct({
  room_id: RoomId,
  work: RoomWorkState,
  force_stop: Schema.BooleanFromBit,
});
const AnsweringRow = Schema.Struct({ room_id: RoomId, bot_id: BotId });
const MemberWorkRow = Schema.Struct({
  room_id: RoomId,
  bot_id: BotId,
  work_json: WorkJson,
});

/** A member's plan and little ones in a room, as the roster sends them with it. */
interface MemberWork {
  readonly botId: BotId;
  readonly work: TurnWork;
}

/** What an active room's members are doing there, as the roster sends it with the room. */
export interface RoomActivity {
  readonly work: RoomWorkState;
  /** The members answering now, in member order; empty unless `work` is `running`. */
  readonly answering: ReadonlyArray<BotId>;
  /**
   * The plan and little ones of members at work there, in member order;
   * empty unless `work` is `running`.
   */
  readonly memberWork: ReadonlyArray<MemberWork>;
  /**
   * Whether a member's AI ignores the stop of a turn of the room, or the
   * room's own Stop of its session (`Room.forceStop`, `roomsIgnoredStopSql`).
   */
  readonly forceStop: boolean;
}

/**
 * Whether work addressed to each active room is under way, and which of its
 * members answer, for the roster (`docs/architecture/server.md`, Rooms), read
 * from what the turn machinery recorded.
 *
 * `work` is `stopping` while a room Stop has a target not settled; else
 * `running` while a wake for the room waits, a dispatch for it is not
 * settled, a session has a turn for it admitted, or one of its turns runs or
 * may still have background work running, in a session the engine still
 * has; else `none`. A member's work for anyone else never counts.
 *
 * `answering`, while the work is `running`, is every member at work on the
 * room, in member order: each one whose turn of the room has not finished, in
 * a session the engine still has, or whose dispatch for the room is live
 * (`intended`, `accepted`, or `delivered` with no continuation pending), and
 * each one with a room wake waiting to start, for a turn slot or for a turn of
 * its own to end. Members run in parallel, so several are named at once. Member order holds while
 * a member goes from waiting to working, so the list changes only when a
 * member starts or ends. A member whose permission mode the engine refuses
 * waits out of the room, so it is not counted, nor is one that left the
 * room.
 *
 * `memberWork`, while the work is `running`, is the plan and little ones of
 * each member's turns for the room whose work may still run there: not
 * finished, or finished with background work, such as a little one it handed
 * off, pending, in a session the engine still has (decision 0070). They show
 * as one: the latest plan, and every little one of them. A member still
 * `answering` is in a turn; one that is not left work behind it.
 *
 * `forceStop` is whether the engine's stop of a turn of the room, or of the
 * background work it left, goes unconfirmed by its AI, in a session the engine
 * still has: the turn a session records as ignoring its stop is the room's,
 * or the room's own Stop went to that session and is not settled
 * (`roomsIgnoredStopSql`), and no Force stop of it waits for the engine yet.
 *
 * All four are read in one transaction, so they agree.
 */
export class RoomStates extends Context.Service<
  RoomStates,
  {
    /** The activity of each of these rooms, by id; a room that is not active is left out. */
    readonly activityOf: (
      roomIds: ReadonlyArray<RoomId>,
    ) => Effect.Effect<ReadonlyMap<RoomId, RoomActivity>>;
    /** The activity of each active room the bot is a member of, by id. */
    readonly activityOfBot: (botId: BotId) => Effect.Effect<ReadonlyMap<RoomId, RoomActivity>>;
  }
>()("@j3-bots/server/turns/RoomStates") {}

/**
 * Whether the stop a session ignores is room `roomId`'s to force: the turn it
 * ignores, `ignoredTurnId`, answers in the room, or the room's own Stop went
 * to the session, `sessionId`, and is not settled. An idle session's stop
 * reaches the engine's latest turn, which can be another audience's while
 * work the room's turn left goes on (**Read** at `59651c1`, `Orchestrator.ts`,
 * `dispatchRunInterrupt`). A room's Stop that still waits for another
 * audience's turn to end has asked the engine nothing, so a stop the session
 * ignores meanwhile is not the room's. Each is a column or a value.
 */
export const roomsIgnoredStopSql = (
  sql: SqlClient.SqlClient,
  ids: {
    readonly sessionId: Statement.Fragment;
    readonly ignoredTurnId: Statement.Fragment;
    readonly roomId: RoomId | Statement.Fragment;
  },
) => sql`(
  EXISTS (
    SELECT 1 FROM turns ri_turn
    WHERE ri_turn.session_id = ${ids.sessionId} AND ri_turn.engine_turn_id = ${ids.ignoredTurnId}
      AND ri_turn.audience = 'room' AND ri_turn.audience_room_id = ${ids.roomId}
  )
  OR EXISTS (
    SELECT 1 FROM stops ri_stop JOIN stop_targets ri_target ON ri_target.stop_id = ri_stop.id
    WHERE ri_stop.scope = 'room' AND ri_stop.room_id = ${ids.roomId}
      AND ri_stop.engine_turn_id IS NULL
      AND ri_target.session_id = ${ids.sessionId} AND ri_target.stopped_at IS NULL
      AND ri_target.issued_at IS NOT NULL
  )
)`;

export const layer = Layer.effect(
  RoomStates,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /** The work of the rooms `rooms` selects, as `rs_room`. */
    const selectWork = (rooms: Statement.Fragment) => sql`
      SELECT rs_room.id AS room_id, CASE
        WHEN EXISTS (
          SELECT 1 FROM stops rs_stop JOIN stop_targets rs_target ON rs_target.stop_id = rs_stop.id
          WHERE rs_stop.scope = 'room' AND rs_stop.room_id = rs_room.id
            AND rs_stop.engine_turn_id IS NULL
            AND rs_target.stopped_at IS NULL
        ) THEN 'stopping'
        WHEN EXISTS (
          SELECT 1 FROM wakes rs_wake
          WHERE rs_wake.status = 'pending' AND rs_wake.audience = 'room'
            AND rs_wake.audience_room_id = rs_room.id
        )
        OR EXISTS (
          SELECT 1 FROM dispatches rs_dispatch
          WHERE rs_dispatch.audience_room_id = rs_room.id
            AND rs_dispatch.status IN ('intended', 'accepted', 'delivered')
        )
        OR EXISTS (
          SELECT 1 FROM sessions rs_admitting
          WHERE rs_admitting.admitted_room_id = rs_room.id AND rs_admitting.lost_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM turns rs_turn JOIN sessions rs_session ON rs_session.id = rs_turn.session_id
          WHERE rs_turn.audience = 'room' AND rs_turn.audience_room_id = rs_room.id
            AND rs_session.lost_at IS NULL AND rs_session.engine_retired_at IS NULL
            AND (rs_turn.finished_at IS NULL OR rs_turn.background_pending = 1)
        ) THEN 'running'
        ELSE 'none'
      END AS work,
      EXISTS (
        SELECT 1 FROM sessions rs_ignoring
        WHERE rs_ignoring.stop_ignored_turn_id IS NOT NULL
          AND rs_ignoring.force_stop_turn_id IS NOT rs_ignoring.stop_ignored_turn_id
          AND rs_ignoring.lost_at IS NULL AND rs_ignoring.engine_retired_at IS NULL
          AND ${roomsIgnoredStopSql(sql, {
            sessionId: sql`rs_ignoring.id`,
            ignoredTurnId: sql`rs_ignoring.stop_ignored_turn_id`,
            roomId: sql`rs_room.id`,
          })}
      ) AS force_stop
      FROM rooms rs_room
      WHERE rs_room.status = 'active' AND ${rooms}
    `;

    /**
     * The members of the rooms `rooms` selects, as `ra_room`, that answer
     * there (`RoomStates`), in member order, each as often as it has a turn,
     * dispatch or wake for the room.
     */
    const selectAnswering = (rooms: Statement.Fragment) => sql`
      SELECT ra_queue.room_id AS room_id, ra_queue.bot_id AS bot_id FROM (
        SELECT ra_turn.audience_room_id AS room_id, ra_session.bot_id AS bot_id
        FROM turns ra_turn JOIN sessions ra_session ON ra_session.id = ra_turn.session_id
        WHERE ra_turn.audience = 'room' AND ra_turn.finished_at IS NULL
          AND ra_session.lost_at IS NULL AND ra_session.engine_retired_at IS NULL
        UNION ALL
        SELECT ra_dispatch.audience_room_id, ra_dispatch.bot_id
        FROM dispatches ra_dispatch
        WHERE ra_dispatch.audience = 'room'
          AND (
            ra_dispatch.status IN ('intended', 'accepted')
            OR (ra_dispatch.status = 'delivered' AND ra_dispatch.continuation_resumes_at IS NULL)
          )
        UNION ALL
        SELECT ra_wake.audience_room_id, ra_wake.bot_id
        FROM wakes ra_wake
        WHERE ra_wake.audience = 'room' AND ra_wake.status = 'pending'
          AND ra_wake.kind <> 'routine'
          AND NOT ${modeRefusedSql(sql, sql`ra_wake.bot_id`)}
      ) ra_queue
      JOIN room_members ra_member
        ON ra_member.room_id = ra_queue.room_id AND ra_member.bot_id = ra_queue.bot_id
      WHERE ra_queue.room_id IN (
        SELECT ra_room.id FROM rooms ra_room WHERE ra_room.status = 'active' AND ${rooms}
      )
      ORDER BY ra_queue.room_id, ra_member.position
    `;

    /**
     * The plan and little ones of each member's turns for the rooms `rooms`
     * selects, as `rw_room`, whose work may still run there, as `work`
     * counts them: not finished, or with background work pending, in a
     * session the engine still has. In member order, a member's turns in the
     * order they started.
     */
    const selectMemberWork = (rooms: Statement.Fragment) => sql`
      SELECT rw_turn.audience_room_id AS room_id, rw_session.bot_id AS bot_id, rw_turn.work_json
      FROM turns rw_turn
      JOIN sessions rw_session ON rw_session.id = rw_turn.session_id
      JOIN room_members rw_member
        ON rw_member.room_id = rw_turn.audience_room_id AND rw_member.bot_id = rw_session.bot_id
      WHERE rw_turn.audience = 'room' AND rw_turn.work_json IS NOT NULL
        AND rw_session.lost_at IS NULL AND rw_session.engine_retired_at IS NULL
        AND (rw_turn.finished_at IS NULL OR rw_turn.background_pending = 1)
        AND rw_turn.audience_room_id IN (
          SELECT rw_room.id FROM rooms rw_room WHERE rw_room.status = 'active' AND ${rooms}
        )
      ORDER BY rw_turn.audience_room_id, rw_member.position, rw_turn.started_at
    `;

    /** The rooms with these ids, or those the bot is a member of, by the alias `room` has. */
    const roomsIn = (roomIds: ReadonlyArray<string>, room: "rs_room" | "ra_room" | "rw_room") =>
      sql.in(`${room}.id`, roomIds);
    const roomsOf = (botId: string, room: "rs_room" | "ra_room" | "rw_room") =>
      sql`${sql.literal(room)}.id IN (SELECT room_id FROM room_members WHERE bot_id = ${botId})`;

    const workByRooms = SqlSchema.findAll({
      Request: Schema.Array(RoomId),
      Result: WorkRow,
      execute: (roomIds) => selectWork(roomsIn(roomIds, "rs_room")),
    });
    const answeringByRooms = SqlSchema.findAll({
      Request: Schema.Array(RoomId),
      Result: AnsweringRow,
      execute: (roomIds) => selectAnswering(roomsIn(roomIds, "ra_room")),
    });
    const workByBot = SqlSchema.findAll({
      Request: Schema.String,
      Result: WorkRow,
      execute: (botId) => selectWork(roomsOf(botId, "rs_room")),
    });
    const answeringByBot = SqlSchema.findAll({
      Request: Schema.String,
      Result: AnsweringRow,
      execute: (botId) => selectAnswering(roomsOf(botId, "ra_room")),
    });
    const memberWorkByRooms = SqlSchema.findAll({
      Request: Schema.Array(RoomId),
      Result: MemberWorkRow,
      execute: (roomIds) => selectMemberWork(roomsIn(roomIds, "rw_room")),
    });
    const memberWorkByBot = SqlSchema.findAll({
      Request: Schema.String,
      Result: MemberWorkRow,
      execute: (botId) => selectMemberWork(roomsOf(botId, "rw_room")),
    });

    const toMap = (
      work: ReadonlyArray<typeof WorkRow.Type>,
      answering: ReadonlyArray<typeof AnsweringRow.Type>,
      memberWork: ReadonlyArray<typeof MemberWorkRow.Type>,
    ): ReadonlyMap<RoomId, RoomActivity> => {
      const queues = new Map<RoomId, Array<BotId>>();
      for (const row of answering) {
        const queue = queues.get(row.room_id) ?? [];
        if (!queue.includes(row.bot_id)) queue.push(row.bot_id);
        queues.set(row.room_id, queue);
      }
      // A member's turns come in the order they started, and show as one.
      const byMember = new Map<RoomId, Map<BotId, TurnWork>>();
      for (const row of memberWork) {
        const members = byMember.get(row.room_id) ?? new Map<BotId, TurnWork>();
        const earlier = members.get(row.bot_id);
        members.set(
          row.bot_id,
          earlier === undefined ? row.work_json : joinedWork(earlier, row.work_json),
        );
        byMember.set(row.room_id, members);
      }
      return new Map(
        work.map((row) => {
          const running = row.work === "running";
          return [
            row.room_id,
            {
              work: row.work,
              answering: running ? (queues.get(row.room_id) ?? []) : [],
              memberWork: running
                ? [...(byMember.get(row.room_id) ?? [])].map(([botId, turnWork]) => ({
                    botId,
                    work: turnWork,
                  }))
                : [],
              forceStop: row.force_stop,
            },
          ];
        }),
      );
    };

    const activityOf = Effect.fn("RoomStates.activityOf")(function* (
      roomIds: ReadonlyArray<RoomId>,
    ) {
      if (roomIds.length === 0) return new Map<RoomId, RoomActivity>();
      const [work, answering, memberWork] = yield* Effect.all([
        workByRooms(roomIds),
        answeringByRooms(roomIds),
        memberWorkByRooms(roomIds),
      ]).pipe(sql.withTransaction);
      return toMap(work, answering, memberWork);
    }, Effect.orDie);

    const activityOfBot = Effect.fn("RoomStates.activityOfBot")(function* (botId: BotId) {
      const [work, answering, memberWork] = yield* Effect.all([
        workByBot(botId),
        answeringByBot(botId),
        memberWorkByBot(botId),
      ]).pipe(sql.withTransaction);
      return toMap(work, answering, memberWork);
    }, Effect.orDie);

    return RoomStates.of({ activityOf, activityOfBot });
  }),
);
