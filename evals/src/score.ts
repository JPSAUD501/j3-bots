// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AttachmentId, BotId, RoomId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/** How many `chain-stopped` notices the room shows. */
const chainStoppedIn = (database: string, roomId: RoomId) =>
  query(
    database,
    Count,
    `SELECT COUNT(*) AS n FROM entries
       WHERE room_id = ? AND kind = 'notice'
         AND json_extract(body_json, '$.notice._tag') = 'chain-stopped'`,
    roomId,
  );

const RoomTurn = Schema.Struct({ bot_id: BotId });

const SharedFile = Schema.Struct({ id: AttachmentId, name: Schema.String });

export interface Score {
  /** The members who ran a turn for the room, in the order the turns started. */
  readonly sequence: ReadonlyArray<string>;
  readonly botTurns: number;
  /** Messages in the room from the member the task gives no part. */
  readonly bystanderMessages: number;
  readonly chainStopped: number;
  /** The bots' messages in the room, the count its quiet limit (`ROOM_QUIET_AFTER`) is on. */
  readonly botMessages: number;
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
  const botMessages = yield* query(
    database,
    Count,
    `SELECT COUNT(*) AS n FROM entries
       WHERE room_id = ? AND kind = 'message' AND author_bot_id IS NOT NULL`,
    roomId,
  );
  const bystanderMessages = yield* query(
    database,
    Count,
    `SELECT COUNT(*) AS n FROM entries
       WHERE room_id = ? AND kind = 'message' AND author_bot_id = ?`,
    roomId,
    bystander,
  );
  const chainStopped = yield* chainStoppedIn(database, roomId);
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
    bystanderMessages: bystanderMessages[0]?.n ?? 0,
    chainStopped: chainStopped[0]?.n ?? 0,
    botMessages: botMessages[0]?.n ?? 0,
    files,
  } satisfies Score;
});

const RoomMessage = Schema.Struct({ author: Schema.NullOr(BotId), text: Schema.String });

/** What has happened in a room so far, to compare before and after the operator writes. */
interface RoomActivity {
  /** Turns that ran for the room. */
  readonly turns: number;
  /** Its messages, oldest first; `author` is null for the operator's. */
  readonly messages: ReadonlyArray<typeof RoomMessage.Type>;
  readonly chainStopped: number;
}

export const roomActivity = Effect.fn("roomActivity")(function* (database: string, roomId: RoomId) {
  const turns = yield* query(
    database,
    Count,
    `SELECT COUNT(*) AS n FROM turns WHERE audience_room_id = ?`,
    roomId,
  );
  const messages = yield* query(
    database,
    RoomMessage,
    `SELECT author_bot_id AS author, json_extract(body_json, '$.text') AS text FROM entries
       WHERE room_id = ? AND kind = 'message' ORDER BY position`,
    roomId,
  );
  const chainStopped = yield* chainStoppedIn(database, roomId);
  return {
    turns: turns[0]?.n ?? 0,
    messages,
    chainStopped: chainStopped[0]?.n ?? 0,
  } satisfies RoomActivity;
});

const Made = Schema.Struct({ id: BotId });

const Tool = Schema.Struct({ tool: Schema.String });

const StartedRoom = Schema.Struct({ id: RoomId });

const Member = Schema.Struct({ bot_id: BotId });

const Author = Schema.Struct({ author_bot_id: BotId });

const Text = Schema.Struct({ text: Schema.String });

const Provider = Schema.Struct({ provider_id: Schema.String });

const WakeState = Schema.Struct({
  status: Schema.String,
  failure_reason: Schema.NullOr(Schema.String),
});

export interface TeamScore {
  /** The J3 Bots tools the primary bot called, in order, its hello's included. */
  readonly tools: ReadonlyArray<string>;
  /** The bots its `create_bot` calls made. */
  readonly made: ReadonlyArray<BotId>;
  /** The provider each of them runs on, in the order made. */
  readonly madeOn: ReadonlyArray<string>;
  /** The first room it is the first member of, as `start_room` makes it, with its members in order. */
  readonly room: Option.Option<{ readonly id: RoomId; readonly members: ReadonlyArray<BotId> }>;
  /** Its messages in that room: the kickoff, and any after. */
  readonly kickoffs: number;
  /** The other members with a message in that room. */
  readonly answered: ReadonlyArray<BotId>;
  /** How each room wake of the other members ended, oldest first: `finished`, `failed (rejected)`. */
  readonly memberWakes: ReadonlyArray<string>;
  /** The J3 Bots tools the other members called in their room turns, in order. */
  readonly memberTools: ReadonlyArray<string>;
  /** Messages the made bots wrote in their own conversations: a hello is one. */
  readonly hellos: number;
  /** Its last message to the operator. */
  readonly told: Option.Option<string>;
}

/** What the primary bot set up when asked for a group, read from the database. */
export const scoreTeam = Effect.fn("scoreTeam")(function* (database: string, primary: BotId) {
  const tools = yield* query(
    database,
    Tool,
    `SELECT c.tool FROM tool_calls c JOIN sessions s ON s.id = c.session_id
       WHERE s.bot_id = ? ORDER BY c.created_at, c.rowid`,
    primary,
  );
  const made = yield* query(
    database,
    Made,
    `SELECT json_extract(c.result_json, '$.id') AS id
       FROM tool_calls c JOIN sessions s ON s.id = c.session_id
       WHERE s.bot_id = ? AND c.tool = 'create_bot' AND c.result_json IS NOT NULL
       ORDER BY c.created_at, c.rowid`,
    primary,
  );
  const [hosted] = yield* query(
    database,
    StartedRoom,
    `SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id
       WHERE m.bot_id = ? AND m.position = 0 ORDER BY r.created_at, r.rowid LIMIT 1`,
    primary,
  );
  const members =
    hosted === undefined
      ? []
      : yield* query(
          database,
          Member,
          `SELECT bot_id FROM room_members WHERE room_id = ? ORDER BY position`,
          hosted.id,
        );
  const kickoffs =
    hosted === undefined
      ? []
      : yield* query(
          database,
          Count,
          `SELECT COUNT(*) AS n FROM entries
             WHERE room_id = ? AND kind = 'message' AND author_bot_id = ?`,
          hosted.id,
          primary,
        );
  const answered =
    hosted === undefined
      ? []
      : yield* query(
          database,
          Author,
          `SELECT author_bot_id FROM entries
             WHERE room_id = ? AND kind = 'message' AND author_kind = 'bot' AND author_bot_id != ?
             GROUP BY author_bot_id ORDER BY MIN(position)`,
          hosted.id,
          primary,
        );
  const memberWakes =
    hosted === undefined
      ? []
      : yield* query(
          database,
          WakeState,
          `SELECT status, failure_reason FROM wakes
             WHERE audience = 'room' AND audience_room_id = ? AND bot_id != ?
             ORDER BY created_at, rowid`,
          hosted.id,
          primary,
        );
  const memberTools =
    hosted === undefined
      ? []
      : yield* query(
          database,
          Tool,
          `SELECT c.tool FROM tool_calls c JOIN sessions s ON s.id = c.session_id
             WHERE c.audience = 'room' AND c.audience_room_id = ? AND s.bot_id != ?
             ORDER BY c.created_at, c.rowid`,
          hosted.id,
          primary,
        );
  const madeIds = made.map((row) => row.id);
  const madeOn =
    madeIds.length === 0
      ? []
      : yield* query(
          database,
          Provider,
          `SELECT provider_id FROM bots WHERE id IN (${madeIds.map(() => "?").join(", ")})
             ORDER BY rowid`,
          ...madeIds,
        );
  const hellos =
    madeIds.length === 0
      ? []
      : yield* query(
          database,
          Count,
          `SELECT COUNT(*) AS n FROM entries
             WHERE conversation_bot_id IN (${madeIds.map(() => "?").join(", ")})
               AND kind = 'message' AND author_kind = 'bot'`,
          ...madeIds,
        );
  const [told] = yield* query(
    database,
    Text,
    `SELECT json_extract(body_json, '$.text') AS text FROM entries
       WHERE conversation_bot_id = ? AND kind = 'message' AND author_bot_id = ?
       ORDER BY position DESC LIMIT 1`,
    primary,
    primary,
  );
  return {
    tools: tools.map((row) => row.tool),
    made: madeIds,
    madeOn: madeOn.map((row) => row.provider_id),
    room:
      hosted === undefined
        ? Option.none()
        : Option.some({ id: hosted.id, members: members.map((row) => row.bot_id) }),
    kickoffs: kickoffs[0]?.n ?? 0,
    answered: answered.map((row) => row.author_bot_id),
    memberWakes: memberWakes.map((row) =>
      row.failure_reason === null ? row.status : `${row.status} (${row.failure_reason})`,
    ),
    memberTools: memberTools.map((row) => row.tool),
    hellos: hellos[0]?.n ?? 0,
    told: Option.fromNullishOr(told?.text),
  } satisfies TeamScore;
});
