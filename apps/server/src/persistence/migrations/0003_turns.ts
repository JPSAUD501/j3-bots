// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What the turn machinery needs beyond the initial schema: the entry a wake
// came from and the wake it retries, the recovery bound of a dispatch, its
// staging retries and how its delivery closed, when a Stop round was sent and
// observed, a session the engine no longer has, the turns a session's events
// showed, their work steps and `j3` tool calls, host speech already
// delivered, open cards, an operator's answer still to reach the engine, and
// a submitted secret whose answer was lost. See `docs/architecture/server.md`.

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `source_entry_id` is the operator's message or the answered card that
  // caused the wake. `retry_of` is the failed wake an operator's retry sent
  // again: a message's delivery is read from the wakes nothing retried.
  yield* sql`ALTER TABLE wakes ADD COLUMN source_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL`;
  yield* sql`ALTER TABLE wakes ADD COLUMN retry_of TEXT REFERENCES wakes (id) ON DELETE SET NULL`;
  yield* sql`CREATE INDEX wakes_source ON wakes (source_entry_id) WHERE source_entry_id IS NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX wakes_retried ON wakes (retry_of) WHERE retry_of IS NOT NULL`;

  // A recovery's bound: how many answers left the dispatch undecided, and when
  // it is tried next. `closed_by` says how the turn's delivery closed: `done`
  // (a `say` with `done: true`), `ask` (the bot asked the operator) or
  // `handoff` (the turn left background work running). A `user` dispatch that
  // finishes with none wakes the bot once more (`undelivered`).
  yield* sql`ALTER TABLE dispatches ADD COLUMN indeterminate_answers INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE dispatches ADD COLUMN next_attempt_at TEXT`;
  // How many times staging its files failed before its first send. Nothing was
  // sent then, so the dispatch fails as `rejected` once the bound is reached.
  yield* sql`
    ALTER TABLE dispatches ADD COLUMN staging_failures INTEGER NOT NULL DEFAULT 0
      CHECK (staging_failures >= 0)
  `;
  yield* sql`
    ALTER TABLE dispatches ADD COLUMN closed_by TEXT
      CHECK (closed_by IN ('done', 'ask', 'handoff'))
  `;

  // When a Stop round was acknowledged (`sent_at`), and when the session's
  // events were caught up past that acknowledgment (`observed_at`, from a
  // `synchronized` marker requested after it). A target is confirmed only from
  // events applied once its latest round is observed. A restart sends the
  // latest round again, with the same key, and observes it anew.
  yield* sql`ALTER TABLE stop_targets ADD COLUMN sent_at TEXT`;
  yield* sql`
    ALTER TABLE stop_targets ADD COLUMN observed_at TEXT
      CHECK (observed_at IS NULL OR sent_at IS NOT NULL)
  `;

  // When the engine answered that it has no such session. Nothing is planned
  // into it or watched there again; part 2b gives the bot a new one.
  yield* sql`ALTER TABLE sessions ADD COLUMN lost_at TEXT`;

  // Every turn the session's events showed starting, with the audience it was
  // admitted with, applied once by its engine id: a replacement that repeats
  // a turn changes nothing. `work_fold_entry_id` is the fold in the bot's
  // conversation, written with the turn's first step.
  yield* sql`
    CREATE TABLE turns (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_turn_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT REFERENCES rooms (id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      finished_at TEXT,
      outcome_json TEXT,
      work_fold_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      PRIMARY KEY (session_id, engine_turn_id),
      CHECK (audience = 'room' OR audience_room_id IS NULL),
      CHECK ((finished_at IS NULL) = (outcome_json IS NULL))
    )
  `;
  yield* sql`CREATE INDEX turns_running ON turns (session_id) WHERE finished_at IS NULL`;

  // A work fold's steps, replaced by id, in the order they started.
  yield* sql`
    CREATE TABLE work_steps (
      entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      step_json TEXT NOT NULL,
      PRIMARY KEY (entry_id, step_id)
    )
  `;

  // The engine's record of each `j3` tool call, which a bot tool request is
  // matched against (`tool_calls.engine_call_id` claims one).
  yield* sql`
    CREATE TABLE engine_tool_calls (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_call_id TEXT NOT NULL,
      engine_turn_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      open INTEGER NOT NULL CHECK (open IN (0, 1)),
      seen_at TEXT NOT NULL,
      PRIMARY KEY (session_id, engine_call_id)
    )
  `;

  // Host speech already delivered, by its stable id.
  yield* sql`
    CREATE TABLE host_speech (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      speech_id TEXT NOT NULL,
      entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      PRIMARY KEY (session_id, speech_id)
    )
  `;

  // When a card stopped waiting on the operator. An `ask` card also keeps the
  // value each option returns (null when the bot gave none), by option id.
  yield* sql`ALTER TABLE ask_cards ADD COLUMN option_values_json TEXT NOT NULL DEFAULT '{}'`;
  yield* sql`ALTER TABLE ask_cards ADD COLUMN closed_at TEXT`;
  yield* sql`ALTER TABLE engine_requests ADD COLUMN closed_at TEXT`;
  // The operator's answer to an approval or an engine question, written before
  // it is sent, so it reaches the engine after a lost reply or a restart. It is
  // sent under a key derived from the card, so one card takes one answer.
  yield* sql`ALTER TABLE engine_requests ADD COLUMN response_json TEXT`;

  // A `secret.provide` whose answer did not come back. It holds no value: only
  // that a submission may have reached the engine, so a later call learns the
  // card's state from the engine before it sends anything, also after a restart.
  // `submission_id` is opaque and new for every submission: a marker is
  // cleared only by the submission, or the check, that read that id.
  yield* sql`
    CREATE TABLE secret_submissions (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL
    )
  `;

  // What a catch-up note reports, as its envelope renders it (`CatchUpNote` in
  // `turns/model.ts`); `text` stays the plain account of it.
  yield* sql`ALTER TABLE catch_up_notes ADD COLUMN note_json TEXT`;

  // A retryable notice and the dispatch whose wakes its retry sends again.
  yield* sql`
    CREATE TABLE notice_retries (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      dispatch_id TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE
    )
  `;
});
