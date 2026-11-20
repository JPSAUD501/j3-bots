// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What the turn machinery needs beyond the initial schema: the entry a wake
// came from and the wake it retries, the order dispatches were written in and
// the dispatches a Stop covers, the recovery bound of a dispatch, its staging
// retries and how its delivery closed, when a Stop round was issued,
// acknowledged, observed or refused and its deadlines, a session the engine
// no longer has or refused as busy, a held queue's resume, the turns a
// session's events showed, their work steps and `j3` tool calls, host speech
// already delivered, open cards, an operator's answer still to reach the
// engine, and a submitted secret whose answer was lost. See
// `docs/architecture/server.md`.

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `source_entry_id` is the operator's message or the answered card that
  // caused the wake. `retry_of` is the failed wake an operator's retry sent
  // again: a message's delivery is read from the wakes nothing retried.
  yield* sql`ALTER TABLE wakes ADD COLUMN source_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL`;
  yield* sql`ALTER TABLE wakes ADD COLUMN retry_of TEXT REFERENCES wakes (id) ON DELETE SET NULL`;
  yield* sql`CREATE INDEX wakes_source ON wakes (source_entry_id) WHERE source_entry_id IS NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX wakes_retried ON wakes (retry_of) WHERE retry_of IS NOT NULL`;

  // No release wrote a dispatch or a Stop: the turn machinery arrives with this
  // migration. Both tables are created again in their final shape, which
  // SQLite cannot reach by altering them.
  const written = yield* sql`SELECT 1 FROM dispatches UNION ALL SELECT 1 FROM stops LIMIT 1`;
  if (written.length > 0) {
    return yield* Effect.die(new Error("Found dispatches or Stops that no release wrote"));
  }
  yield* sql`DROP TABLE dispatches`;
  yield* sql`DROP TABLE stops`;

  // A Stop, as the initial schema describes it. `dispatch_mark` is the highest
  // dispatch `seq` when it was recorded: it covers the work of exactly the
  // dispatches at or below it (`stopTargets.covers`).
  //
  // A room's id on a Stop, a dispatch or a turn outlives the room, so it has
  // no foreign key: deleting a room records its Stop and then deletes it, and
  // work for it settles later by `covers`, which must still tell that room's
  // work from another's.
  yield* sql`
    CREATE TABLE stops (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('bot', 'room')),
      room_id TEXT,
      created_at TEXT NOT NULL,
      dispatch_mark INTEGER NOT NULL,
      CHECK ((scope = 'room') = (room_id IS NOT NULL))
    )
  `;

  // A dispatch, as the initial schema describes it, with what the turn
  // machinery adds.
  //
  // `seq` is the order it was written in: `AUTOINCREMENT`, so a number is never
  // reused once its row is gone (deleting a bot deletes its dispatches).
  // SQLite serializes writes, so this order is exact where two times in the
  // same millisecond, or a clock stepped back, are not. `id` stays the key
  // every other table points at. `audience_room_id` outlives its room, as a
  // Stop's does.
  //
  // A dispatch the engine answered for (a disposition, a turn) may still fail
  // as `unresolved`: its session was lost before the turn ran, so the recovery
  // can never learn more. The engine's first answer stays immutable
  // (`dispatches_first_disposition`); a dispatch it refused (`rejected`) never
  // carries one.
  //
  // A recovery's bound: how many answers left the dispatch undecided, and when
  // it is tried next. `staging_failures` is how many times staging its files
  // failed before its first send. Nothing was sent then, so the dispatch fails
  // as `rejected` once the bound is reached. `closed_by` says how the turn's
  // delivery closed: `done` (a `say` with `done: true`), `ask` (the bot asked
  // the operator) or `handoff` (the turn left background work running). A
  // `user` dispatch that finishes with none wakes the bot once more
  // (`undelivered`).
  yield* sql`
    CREATE TABLE dispatches (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT,
      delivery TEXT NOT NULL CHECK (delivery IN ('start', 'steer')),
      steer_turn_id TEXT,
      fresh_context INTEGER NOT NULL DEFAULT 0 CHECK (fresh_context IN (0, 1)),
      envelope TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'intended', 'accepted', 'delivered', 'finished', 'dropped', 'released', 'failed'
        )
      ),
      failure_reason TEXT CHECK (failure_reason IN ('rejected', 'unresolved')),
      disposition TEXT CHECK (disposition IN ('started', 'queued', 'steered', 'new-turn')),
      disposition_turn_id TEXT,
      engine_turn_id TEXT,
      continuation_resumes_at TEXT,
      fenced_by_stop_id TEXT REFERENCES stops (id) ON DELETE SET NULL,
      outcome_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      indeterminate_answers INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      staging_failures INTEGER NOT NULL DEFAULT 0 CHECK (staging_failures >= 0),
      closed_by TEXT CHECK (closed_by IN ('done', 'ask', 'handoff')),
      CHECK ((audience = 'room') = (audience_room_id IS NOT NULL)),
      CHECK ((delivery = 'steer') = (steer_turn_id IS NOT NULL)),
      CHECK (delivery = 'start' OR fresh_context = 0),
      CHECK (
        disposition IS NULL
        OR (delivery = 'start' AND disposition IN ('started', 'queued'))
        OR (delivery = 'steer' AND disposition IN ('steered', 'new-turn'))
      ),
      CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
      CHECK (disposition IS NULL OR status NOT IN ('intended', 'released')),
      CHECK ((disposition IS NULL) = (disposition_turn_id IS NULL)),
      CHECK (engine_turn_id IS NULL OR status NOT IN ('intended', 'released')),
      CHECK (
        failure_reason IS NOT 'rejected' OR (disposition IS NULL AND engine_turn_id IS NULL)
      ),
      CHECK (status NOT IN ('delivered', 'finished', 'dropped') OR engine_turn_id IS NOT NULL),
      CHECK (continuation_resumes_at IS NULL OR status = 'delivered'),
      CHECK (
        continuation_resumes_at IS NULL
        OR NOT (delivery = 'steer' AND engine_turn_id = steer_turn_id)
      )
    )
  `;
  yield* sql`
    CREATE TRIGGER dispatches_immutable_intent
    BEFORE UPDATE OF session_id, audience, delivery, steer_turn_id, fresh_context, envelope
    ON dispatches
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the session, audience and envelope it was written with');
    END
  `;
  yield* sql`
    CREATE TRIGGER dispatches_first_disposition
    BEFORE UPDATE OF disposition, disposition_turn_id ON dispatches
    WHEN OLD.disposition IS NOT NULL
      AND (NEW.disposition IS NOT OLD.disposition
        OR NEW.disposition_turn_id IS NOT OLD.disposition_turn_id)
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the engine''s first answer');
    END
  `;
  yield* sql`
    CREATE INDEX dispatches_open ON dispatches (session_id, status)
    WHERE status IN ('intended', 'accepted', 'delivered')
  `;
  yield* sql`
    CREATE TRIGGER dispatches_rider_keeps_turn
    BEFORE UPDATE OF engine_turn_id ON dispatches
    WHEN OLD.delivery = 'steer' AND OLD.engine_turn_id = OLD.steer_turn_id
      AND OLD.status <> 'accepted'
      AND NEW.engine_turn_id IS NOT OLD.engine_turn_id
    BEGIN
      SELECT RAISE(ABORT, 'a steer finishes with the turn it rode');
    END
  `;
  yield* sql`
    CREATE UNIQUE INDEX dispatches_turn ON dispatches (session_id, engine_turn_id)
    WHERE engine_turn_id IS NOT NULL
      AND NOT (delivery = 'steer' AND engine_turn_id = steer_turn_id)
  `;

  // When a Stop round was issued (`issued_at`, written before its commands
  // are sent: a turn that starts after it may have been missed by them, and
  // opens the next round), when the engine acknowledged it (`sent_at`), and
  // when the session's events were caught up past that acknowledgment
  // (`observed_at`, from a `synchronized` marker requested after it). A target
  // is confirmed only from events applied once its latest round is observed.
  // A target settles with `stopped_at` alone, so each round keeps what the
  // engine answered for it.
  yield* sql`ALTER TABLE stop_targets ADD COLUMN issued_at TEXT`;
  yield* sql`
    ALTER TABLE stop_targets ADD COLUMN sent_at TEXT
      CHECK (sent_at IS NULL OR issued_at IS NOT NULL)
  `;
  yield* sql`
    ALTER TABLE stop_targets ADD COLUMN observed_at TEXT
      CHECK (observed_at IS NULL OR sent_at IS NOT NULL)
  `;
  // When the engine refused the round while its work could still run, which
  // spends the round's key: a fresh round follows, with backoff.
  yield* sql`
    ALTER TABLE stop_targets ADD COLUMN rejected_at TEXT
      CHECK (rejected_at IS NULL OR (issued_at IS NOT NULL AND sent_at IS NULL))
  `;
  // The round's own backoff: it is not sent before `due_at`. Set on a fresh
  // round that follows a refused one or one whose work kept running.
  yield* sql`ALTER TABLE stop_targets ADD COLUMN due_at TEXT`;
  // The grace an acknowledged round gives the engine: if its events still
  // show work the Stop targets past `recheck_at`, a fresh round follows.
  yield* sql`
    ALTER TABLE stop_targets ADD COLUMN recheck_at TEXT
      CHECK (recheck_at IS NULL OR sent_at IS NOT NULL)
  `;
  // When the Stop runner tries the session's Stop work again after it failed
  // unexpectedly: a durable deadline like every other worker's, for the whole
  // session.
  yield* sql`ALTER TABLE stop_targets ADD COLUMN retry_at TEXT`;

  // When the engine answered that it has no such session. Nothing is planned
  // into it or watched there again; part 2b gives the bot a new one.
  yield* sql`ALTER TABLE sessions ADD COLUMN lost_at TEXT`;
  // A first send was refused as busy: the adapter saw a turn the server has
  // not applied yet. Nothing is planned into the session before `busy_until`,
  // which the next applied event clears; `busy_refusals` counts the refusals
  // in a row, for the deadline's backoff.
  yield* sql`
    ALTER TABLE sessions ADD COLUMN busy_refusals INTEGER NOT NULL DEFAULT 0
      CHECK (busy_refusals >= 0)
  `;
  yield* sql`ALTER TABLE sessions ADD COLUMN busy_until TEXT`;
  // A held queue's resume whose reply was lost: how many times in a row, and
  // when it is tried next. Reset when a new hold is reported.
  yield* sql`
    ALTER TABLE sessions ADD COLUMN queue_resume_failures INTEGER NOT NULL DEFAULT 0
      CHECK (queue_resume_failures >= 0)
  `;
  yield* sql`ALTER TABLE sessions ADD COLUMN queue_resume_at TEXT`;

  // Every turn the session's events showed starting, with the audience it was
  // admitted with, applied once by its engine id: a replacement that repeats
  // a turn changes nothing. Its room's id outlives the room, as a dispatch's
  // does. `work_fold_entry_id` is the fold in the bot's
  // conversation, written with the turn's first step.
  yield* sql`
    CREATE TABLE turns (
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      engine_turn_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('conversation', 'room')),
      audience_room_id TEXT,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      finished_at TEXT,
      outcome_json TEXT,
      work_fold_entry_id TEXT REFERENCES entries (id) ON DELETE SET NULL,
      PRIMARY KEY (session_id, engine_turn_id),
      CHECK ((audience = 'room') = (audience_room_id IS NOT NULL)),
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
  // When the engine took that answer, and, while its replies are lost, how
  // many times in a row it was sent and when it is sent next. The request's
  // events close the card.
  yield* sql`
    ALTER TABLE engine_requests ADD COLUMN response_sent_at TEXT
      CHECK (response_sent_at IS NULL OR response_json IS NOT NULL)
  `;
  yield* sql`
    ALTER TABLE engine_requests ADD COLUMN response_failures INTEGER NOT NULL DEFAULT 0
      CHECK (response_failures >= 0)
  `;
  yield* sql`ALTER TABLE engine_requests ADD COLUMN response_retry_at TEXT`;

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
  // `reason` says what failed: the dispatch's delivery (`undelivered`, which a
  // late delivery makes moot) or the turn that ran (`turn`).
  yield* sql`
    CREATE TABLE notice_retries (
      entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
      dispatch_id TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (reason IN ('undelivered', 'turn'))
    )
  `;
});
