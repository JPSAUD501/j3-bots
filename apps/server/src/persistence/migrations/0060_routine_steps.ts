// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A routine can have several steps, each done by one bot, with conditions
// and stops for the operator's yes between them (decision 0080).
//
// `routines.steps_json` is a routine's steps, in order, for a routine with
// several; null for a one-step routine, which `instruction` is all of, as
// every routine saved before this migration is. For one with several,
// `instruction` is its first step's, kept with the steps by the one writer.
//
// A run of such a routine copies its steps when it starts
// (`routine_runs.steps_json`) and follows that copy; `step` is the position
// it has reached, `stopped` whether a Stop ended it, which is never tried
// again, and `entry_id` the `routine-run` entry that shows it in its owner's
// conversation. A one-step routine's run keeps all three null or 0.
//
// `routine_run_steps` holds where each step of such a run stands: what its
// bot reported (`report_json`, by the attempt whose wake made it), the yes it
// asked and its deadline, the operator's answer, why it failed, and whether
// its bot said something to the operator (`spoke`), which makes the run
// delivered.
//
// The run card is a new kind of entry, `routine-run`, which the check on
// `entries.kind` refuses: the column is replaced in place, as migration 0052
// replaced it, with every kind 0052 allows and the new one, and what names
// `kind` goes first and comes back as it was.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE routines ADD COLUMN steps_json TEXT`;

  yield* sql`ALTER TABLE routine_runs ADD COLUMN steps_json TEXT`;
  yield* sql`ALTER TABLE routine_runs ADD COLUMN step INTEGER CHECK (step IS NULL OR step >= 0)`;
  yield* sql`
    ALTER TABLE routine_runs ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0
      CHECK (stopped IN (0, 1))
  `;
  yield* sql`ALTER TABLE routine_runs ADD COLUMN entry_id TEXT`;

  yield* sql`
    CREATE TABLE routine_run_steps (
      run_id TEXT NOT NULL REFERENCES routine_runs (id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'todo', 'doing', 'done', 'failed', 'skipped', 'not-needed', 'passed', 'stopped',
        'waiting', 'yes', 'no', 'timed-out'
      )),
      result TEXT,
      report_json TEXT,
      report_wake_id TEXT,
      ask_json TEXT,
      deadline TEXT,
      answer_json TEXT,
      failure TEXT CHECK (
        failure IS NULL OR failure IN ('blocked', 'unreported', 'turn-failed', 'bot-gone', 'stopped')
      ),
      partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
      spoke INTEGER NOT NULL DEFAULT 0 CHECK (spoke IN (0, 1)),
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (run_id, position),
      CHECK ((state = 'waiting') = (deadline IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE INDEX routine_run_steps_waiting ON routine_run_steps (deadline)
    WHERE state = 'waiting'
  `;

  yield* sql`
    CREATE TEMP TABLE kept_room_rounds AS
    SELECT id, room_round FROM entries WHERE room_round IS NOT NULL
  `;
  yield* sql`DROP TRIGGER entries_fixed_place`;
  yield* sql`DROP TRIGGER entries_fixed_round`;
  yield* sql`DROP TRIGGER pair_messages_gone`;
  yield* sql`DROP INDEX entries_room_word`;
  yield* sql`ALTER TABLE entries DROP COLUMN room_round`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'message' CHECK (
      entry_kind IN (
        'message', 'question', 'approval', 'secret-request', 'browser-help', 'secret-ask',
        'work-fold', 'notice', 'handoff', 'routine-change', 'connector-suggestion',
        'connector-auth', 'connector-input', 'connector-ask', 'routine-run'
      )
    )
  `;
  yield* sql`UPDATE entries SET entry_kind = kind`;
  yield* sql`ALTER TABLE entries DROP COLUMN kind`;
  yield* sql`ALTER TABLE entries RENAME COLUMN entry_kind TO kind`;
  yield* sql`
    ALTER TABLE entries ADD COLUMN room_round INTEGER
      CHECK (room_round IS NULL OR (room_round >= 0 AND room_id IS NOT NULL AND kind = 'message'))
  `;
  yield* sql`
    UPDATE entries
    SET room_round = (SELECT k.room_round FROM kept_room_rounds k WHERE k.id = entries.id)
    WHERE id IN (SELECT id FROM kept_room_rounds)
  `;
  yield* sql`DROP TABLE kept_room_rounds`;
  yield* sql`
    CREATE TRIGGER entries_fixed_round
    BEFORE UPDATE OF room_round ON entries
    WHEN OLD.room_round IS NOT NULL AND NEW.room_round IS NOT OLD.room_round
    BEGIN
      SELECT RAISE(ABORT, 'a room message keeps its round');
    END
  `;
  yield* sql`CREATE INDEX entries_room_word ON entries (room_id, position) WHERE room_round = 0`;
  yield* sql`
    CREATE TRIGGER pair_messages_gone
    BEFORE DELETE ON entries
    WHEN OLD.kind = 'handoff'
    BEGIN
      DELETE FROM pair_messages
      WHERE (sent_entry_id = OLD.id AND received_entry_id IS NULL)
        OR (received_entry_id = OLD.id AND sent_entry_id IS NULL);
    END
  `;
  yield* sql`
    CREATE TRIGGER entries_fixed_place
    BEFORE UPDATE OF conversation_bot_id, room_id, position, kind ON entries
    BEGIN
      SELECT RAISE(ABORT, 'an entry keeps its target, its place and its kind');
    END
  `;
});
