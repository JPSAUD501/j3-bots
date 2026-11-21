// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AttachmentId, BotId, type RoomId } from "@j3-bots/contracts";
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

const RoomTurn = Schema.Struct({ bot_id: BotId });

const Hops = Schema.Struct({ hops: Schema.Number });

const SharedFile = Schema.Struct({ id: AttachmentId, name: Schema.String });

export interface Score {
  /** The members who ran a turn for the room, in the order the turns started. */
  readonly sequence: ReadonlyArray<string>;
  readonly botTurns: number;
  /** Room wakes of the member the task gives no part. */
  readonly bystanderWakes: number;
  readonly chainStopped: number;
  /** The furthest hop count a room wake reached. */
  readonly maxHops: number;
  /** The files bots shared in the room, in the order they were shared. */
  readonly files: ReadonlyArray<typeof SharedFile.Type>;
}

export const score = Effect.fn("score")(function* (
  database: string,
  roomId: RoomId,
  names: ReadonlyMap<BotId, string>,
  bystander: BotId,
) {
  const turns = yield* query(
    database,
    RoomTurn,
    `SELECT s.bot_id FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.audience_room_id = ? ORDER BY t.started_at, t.rowid`,
    roomId,
  );
  const hops = yield* query(
    database,
    Hops,
    `SELECT hops FROM wakes WHERE audience_room_id = ?`,
    roomId,
  );
  const bystanderWakes = yield* query(
    database,
    Count,
    `SELECT COUNT(*) AS n FROM wakes WHERE audience_room_id = ? AND bot_id = ?`,
    roomId,
    bystander,
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
    SharedFile,
    `SELECT a.id, a.name FROM attachments a JOIN entries e ON e.id = a.entry_id
       WHERE e.room_id = ? AND a.source = 'bot' ORDER BY e.position`,
    roomId,
  );

  return {
    sequence: turns.map((turn) => names.get(turn.bot_id) ?? turn.bot_id),
    botTurns: turns.length,
    bystanderWakes: bystanderWakes[0]?.n ?? 0,
    chainStopped: chainStopped[0]?.n ?? 0,
    maxHops: Math.max(0, ...hops.map((wake) => wake.hops)),
    files,
  } satisfies Score;
});
