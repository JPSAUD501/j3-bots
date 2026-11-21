// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { BotId, type RoomId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The run's database could not be read. */
class DatabaseUnreadable extends Schema.TaggedError<DatabaseUnreadable>()("DatabaseUnreadable", {
  reason: Schema.String,
}) {}

// What a run did, read from the server's database once the room is quiet.
// No model judges anything: every number is a count of rows.

/** Rows of a read-only query, each decoded with `row`. */
const query = <A, I>(
  database: string,
  row: Schema.Codec<A, I>,
  sql: string,
  ...params: ReadonlyArray<SQLInputValue>
) =>
  Effect.try({
    try: () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db.prepare(sql).all(...params);
      } finally {
        db.close();
      }
    },
    catch: (cause) => new DatabaseUnreadable({ reason: String(cause) }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))), Effect.orDie);

const Count = Schema.Struct({ n: Schema.Number });

/**
 * Whether anything is still under way anywhere: a wake not yet dealt with, a
 * turn not finished, or background work a turn left that may still report.
 */
export const busy = (database: string) =>
  query(
    database,
    Count,
    `SELECT
       (SELECT COUNT(*) FROM wakes WHERE status IN ('pending', 'dispatched'))
       + (SELECT COUNT(*) FROM turns WHERE finished_at IS NULL OR background_pending = 1)
       AS n`,
  ).pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));

const RoomTurn = Schema.Struct({
  session_id: Schema.String,
  engine_turn_id: Schema.String,
  origin_turn_id: Schema.NullOr(Schema.String),
  bot_id: BotId,
});

const RoomWake = Schema.Struct({
  bot_id: BotId,
  hops: Schema.Number,
  reason: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  engine_turn_id: Schema.NullOr(Schema.String),
});

const TurnRef = Schema.Struct({ session_id: Schema.String, engine_turn_id: Schema.String });

const Name = Schema.Struct({ name: Schema.String });

/** A wake that addresses its bot: it was mentioned, or it hosts a message addressed to nobody. */
const ADDRESSING = new Set(["mentioned", "host"]);

export interface Score {
  /** The members who ran a turn for the room, in the order the turns started. */
  readonly sequence: ReadonlyArray<string>;
  readonly botTurns: number;
  /** Turns by a bot that no room wake ever addressed. */
  readonly unaddressedTurns: number;
  readonly chainStopped: number;
  /** `say` calls in a room turn that no wake addressing its bot began. */
  readonly offAddressSays: number;
  /** The furthest hop count a room wake reached. */
  readonly maxHops: number;
  /** The files bots shared in the room. */
  readonly files: ReadonlyArray<string>;
}

export const score = Effect.fn("score")(function* (
  database: string,
  roomId: RoomId,
  names: ReadonlyMap<BotId, string>,
) {
  const turns = yield* query(
    database,
    RoomTurn,
    `SELECT t.session_id, t.engine_turn_id, t.origin_turn_id, s.bot_id
       FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.audience_room_id = ? ORDER BY t.started_at, t.rowid`,
    roomId,
  );
  const wakes = yield* query(
    database,
    RoomWake,
    `SELECT w.bot_id, w.hops, json_extract(w.payload_json, '$.reason') AS reason,
         d.session_id, d.engine_turn_id
       FROM wakes w LEFT JOIN dispatches d ON d.id = w.dispatch_id
       WHERE w.audience_room_id = ?`,
    roomId,
  );
  const says = yield* query(
    database,
    TurnRef,
    `SELECT session_id, engine_turn_id FROM tool_calls
       WHERE tool = 'say' AND audience_room_id = ?`,
    roomId,
  );
  const chainStopped = yield* query(
    database,
    Count,
    `SELECT COUNT(*) AS n FROM entries
       WHERE room_id = ? AND kind = 'notice'
         AND json_extract(body_json, '$.notice._tag') = 'chain-stopped'`,
    roomId,
  );
  const files = yield* query(
    database,
    Name,
    `SELECT a.name FROM attachments a JOIN entries e ON e.id = a.entry_id
       WHERE e.room_id = ? AND a.source = 'bot' ORDER BY e.position`,
    roomId,
  );

  const key = (sessionId: string, turnId: string) => `${sessionId}/${turnId}`;
  const addressing = wakes.filter((wake) => wake.reason !== null && ADDRESSING.has(wake.reason));
  const addressed = new Set(addressing.map((wake) => wake.bot_id));
  const turnByKey = new Map(turns.map((turn) => [key(turn.session_id, turn.engine_turn_id), turn]));
  const begunByAddress = new Set(
    addressing.flatMap((wake) =>
      wake.session_id === null || wake.engine_turn_id === null
        ? []
        : [key(wake.session_id, wake.engine_turn_id)],
    ),
  );
  // A turn that continues another (background work reporting back) counts as the turn it continues.
  const begun = (sessionId: string, turnId: string): boolean => {
    if (begunByAddress.has(key(sessionId, turnId))) return true;
    const origin = turnByKey.get(key(sessionId, turnId))?.origin_turn_id ?? null;
    return origin !== null && origin !== turnId && begun(sessionId, origin);
  };

  return {
    sequence: turns.map((turn) => names.get(turn.bot_id) ?? turn.bot_id),
    botTurns: turns.length,
    unaddressedTurns: turns.filter((turn) => !addressed.has(turn.bot_id)).length,
    chainStopped: chainStopped[0]?.n ?? 0,
    offAddressSays: says.filter((say) => !begun(say.session_id, say.engine_turn_id)).length,
    maxHops: Math.max(0, ...wakes.map((wake) => wake.hops)),
    files: files.map((file) => file.name),
  } satisfies Score;
});
