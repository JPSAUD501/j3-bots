// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, type EntryId, Label } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Ids } from "../Ids.ts";
import type { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { CatchUpNote, SessionRowId } from "./model.ts";

const RunOfSession = Schema.Struct({
  wake_id: Schema.String,
  routine_name: Schema.NullOr(Label),
  started_at: Schema.NullOr(Time),
});

const encodeNote = Schema.encodeEffect(json(CatchUpNote));

/**
 * What a routine run says (`docs/architecture/server.md`, Routines), in the
 * caller's transaction, the one that publishes it: the message is tagged
 * with the wake of the run's attempt, which is how the run settles as
 * `delivered`, and the bot's main session is told of it by a catch-up note
 * at the top of its next envelope there, since it did not see the side
 * session. A side session runs one attempt, so everything said there is
 * that attempt's, in a turn the engine started too, as for background work.
 * Speech in a main session is left as it is.
 */
export const routineSpeech = (
  sql: SqlClient.SqlClient,
  ids: Ids["Service"],
  changes: ChangeLog["Service"],
) => {
  const runOfSession = SqlSchema.findOneOption({
    Request: SessionRowId,
    Result: RunOfSession,
    execute: (sessionId) => sql`
      SELECT w.id AS wake_id, ro.name AS routine_name, r.started_at
      FROM sessions s
      JOIN wakes w ON w.id = s.side_wake_id
      LEFT JOIN routine_runs r ON r.wake_id = w.id
      LEFT JOIN routines ro ON ro.id = w.routine_id
      WHERE s.id = ${sessionId} AND s.purpose = 'side'
    `,
  });

  const said = Effect.fn("routineSpeech.said")(function* (input: {
    readonly sessionId: SessionRowId;
    readonly botId: BotId;
    readonly entryId: EntryId;
    readonly text: string;
  }) {
    const run = yield* runOfSession(input.sessionId);
    if (Option.isNone(run)) return;
    const { wake_id: wakeId, routine_name: routine, started_at: startedAt } = run.value;
    yield* sql`UPDATE entries SET wake_id = ${wakeId} WHERE id = ${input.entryId}`;
    // Speech after its first turn completed in silence, once background work
    // it started woke it: the run said something after all.
    const spoke = yield* sql<{ readonly routine_id: string }>`
      UPDATE routine_runs SET status = 'delivered'
      WHERE wake_id = ${wakeId} AND status = 'silent'
      RETURNING routine_id
    `;
    for (const { routine_id: routineId } of spoke) {
      yield* changes.record({ _tag: "routines", botId: input.botId }, routineId);
    }
    // A routine deleted while its run went on has no name left to report it by.
    if (routine === null) return;
    const now = yield* DateTime.now;
    const note = {
      _tag: "routine-delivered",
      routine,
      at: startedAt ?? now,
      text: input.text,
    } as const;
    // Its message's place in the conversation: a fresh start after it leaves it out.
    yield* sql`
      INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json, source_position)
      VALUES (
        ${yield* ids.make("note")}, ${input.botId}, ${input.text}, ${timeText(now)},
        ${yield* encodeNote(note)},
        (SELECT position FROM entries WHERE id = ${input.entryId})
      )
    `;
  }, Effect.orDie);

  return { said };
};
