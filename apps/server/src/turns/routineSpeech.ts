// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryId } from "@j3-bots/contracts";
import { TurnId } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Ids } from "../Ids.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { CatchUpNote, SessionRowId } from "./model.ts";

const RunOfTurn = Schema.Struct({
  wake_id: Schema.String,
  routine_name: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Time),
});

const encodeNote = Schema.encodeEffect(json(CatchUpNote));

/**
 * What a routine run says (`docs/architecture/server.md`, Routines), in the
 * caller's transaction, the one that publishes it: the message is tagged
 * with the wake of the run's attempt, which is how the run settles as
 * `delivered`, and the bot's main session is told of it by a catch-up note
 * at the top of its next envelope there, since it did not see the side
 * session. Speech of any other turn is left as it is.
 */
export const routineSpeech = (sql: SqlClient.SqlClient, ids: Ids["Service"]) => {
  const runOfTurn = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: SessionRowId, turnId: TurnId }),
    Result: RunOfTurn,
    execute: ({ sessionId, turnId }) => sql`
      SELECT w.id AS wake_id, ro.name AS routine_name, r.started_at
      FROM dispatches d
      JOIN wakes w ON w.dispatch_id = d.id AND w.kind = 'routine'
      LEFT JOIN routine_runs r ON r.wake_id = w.id
      LEFT JOIN routines ro ON ro.id = w.routine_id
      WHERE d.session_id = ${sessionId} AND d.engine_turn_id = ${turnId}
      LIMIT 1
    `,
  });

  const said = Effect.fn("routineSpeech.said")(function* (input: {
    readonly sessionId: SessionRowId;
    readonly turnId: TurnId;
    readonly botId: BotId;
    readonly entryId: EntryId;
    readonly text: string;
  }) {
    const run = yield* runOfTurn({ sessionId: input.sessionId, turnId: input.turnId });
    if (Option.isNone(run)) return;
    const { wake_id: wakeId, routine_name: routine, started_at: startedAt } = run.value;
    yield* sql`UPDATE entries SET wake_id = ${wakeId} WHERE id = ${input.entryId}`;
    // A routine deleted while its run went on has no name left to report it by.
    if (routine === null) return;
    const now = yield* DateTime.now;
    const note = {
      _tag: "routine-delivered",
      routine,
      at: startedAt ?? now,
      text: input.text,
    } as const;
    yield* sql`
      INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json)
      VALUES (
        ${yield* ids.make("note")}, ${input.botId}, ${input.text}, ${timeText(now)},
        ${yield* encodeNote(note)}
      )
    `;
  }, Effect.orDie);

  return { said };
};
