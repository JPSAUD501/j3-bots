// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { SessionRowId } from "./model.ts";

/**
 * A bot's first contact with the operator (`docs/product/experience.md`,
 * The first conversation): the turn that says its hello, or, for a bot made
 * for a room, whose hello was cancelled, its turns there until it first
 * speaks. Its messages arrive as a person's would in a chat, each a moment
 * after the one before.
 */

/** The shortest pause before a message that follows another in a first contact. */
const SHORTEST_PAUSE = Duration.millis(900);
/** The longest: a long message is not typed out at a person's speed. */
const LONGEST_PAUSE = Duration.millis(2600);
/** How long a person takes to start a message, before its first character. */
const START = 500;
/** How long each character adds, faster than a person types. */
const PER_CHARACTER = 14;

/**
 * How long the bot seems to type `text` when it follows another message of
 * the same first contact: longer for a longer message, within bounds that
 * keep a hello of two or three messages within a few seconds.
 */
export const typingPause = (text: string): Duration.Duration =>
  Duration.clamp(Duration.millis(START + PER_CHARACTER * [...text].length), {
    minimum: SHORTEST_PAUSE,
    maximum: LONGEST_PAUSE,
  });

/** A turn of a bot's, in its session. */
export interface BotTurn {
  readonly botId: BotId;
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
}

const Found = Schema.Struct({ found: Schema.BooleanFromBit });

/**
 * Whether the bot is new to the operator, as a member of a room it was made
 * for: its conversation says so (`made-for-room`), and it has said nothing
 * yet, or nothing before `before`, a time its turn started at. What it said
 * in a room is read from the `say`s its own sessions posted, which outlive a
 * change of the room's members and the room itself. Every lookup goes
 * through an index: the bot's conversation, its sessions' calls.
 */
const newcomerSql = (
  sql: SqlClient.SqlClient,
  botId: string,
  before: Statement.Fragment | null,
) => {
  const earlierEntry = before === null ? sql`1` : sql`e.created_at < ${before}`;
  const earlierCall = before === null ? sql`1` : sql`c.created_at < ${before}`;
  return sql`
    EXISTS (
      SELECT 1 FROM entries
      WHERE conversation_bot_id = ${botId} AND kind = 'notice'
        AND json_extract(body_json, '$.notice._tag') = 'made-for-room'
    ) AND NOT EXISTS (
      SELECT 1 FROM entries e
      WHERE e.conversation_bot_id = ${botId} AND e.author_bot_id = ${botId}
        AND e.kind = 'message' AND ${earlierEntry}
    ) AND NOT EXISTS (
      SELECT 1 FROM sessions s JOIN tool_calls c ON c.session_id = s.id
      WHERE s.bot_id = ${botId} AND c.tool = 'say' AND c.result_json IS NOT NULL
        AND ${earlierCall}
    )
  `;
};

/** Whether the bot is a newcomer to the operator in its rooms (`RoomWake.newcomer`). */
export const newcomer = (sql: SqlClient.SqlClient) => {
  const query = SqlSchema.findOne({
    Request: Schema.String,
    Result: Found,
    execute: (botId) => sql`SELECT (${newcomerSql(sql, botId, null)}) AS found`,
  });
  return (botId: BotId) =>
    query(botId).pipe(
      Effect.map((row) => row.found),
      Effect.orDie,
    );
};

/**
 * Whether the turn is part of the bot's first contact: it delivers the
 * bot's `first-run` wake, or the bot was a newcomer to its room when the
 * turn started.
 */
export const inFirstContact = (sql: SqlClient.SqlClient) => {
  const query = SqlSchema.findOne({
    Request: Schema.Struct({
      botId: Schema.String,
      sessionId: Schema.String,
      turnId: Schema.String,
    }),
    Result: Found,
    execute: ({ botId, sessionId, turnId }) => sql`
      SELECT (
        EXISTS (
          SELECT 1 FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
          WHERE d.session_id = ${sessionId} AND d.engine_turn_id = ${turnId}
            AND json_extract(w.payload_json, '$._tag') = 'first-run'
        ) OR (${newcomerSql(
          sql,
          botId,
          sql`(
            SELECT started_at FROM turns
            WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
          )`,
        )})
      ) AS found
    `,
  });
  return (turn: BotTurn) =>
    query(turn).pipe(
      Effect.map((row) => row.found),
      Effect.orDie,
    );
};
