// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Session rotation (`docs/architecture/server.md`, Rotation).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The provider a session runs on, chosen with the bot's settings in the
  // transaction that writes the row. It never changes: a bot that moves to
  // another provider gets a new main session. SQLite adds a NOT NULL column
  // only with a default; the update gives the sessions from before their
  // bot's provider, and every later row names its own.
  yield* sql`ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''`;
  yield* sql`
    UPDATE sessions SET provider_id = (SELECT provider_id FROM bots WHERE bots.id = sessions.bot_id)
  `;

  // Why a live main session is to be replaced, and how the rotator replaces
  // it (`turns/Rotations.ts`).
  yield* sql`
    ALTER TABLE sessions ADD COLUMN rotation_reason TEXT
      CHECK (rotation_reason IN ('runs', 'context-recovered', 'provider-changed', 'fresh-start'))
  `;
  // When the engine took a retired session out of use. A rotation retires the
  // row first and the engine thread after, retried until the engine answers.
  yield* sql`ALTER TABLE sessions ADD COLUMN engine_retired_at TEXT`;

  // Turn usage is read newest first, from a time on.
  yield* sql`CREATE INDEX turns_started ON turns (started_at)`;

  // A session's runs are its turns, counted where they are recorded.
  yield* sql`ALTER TABLE sessions DROP COLUMN run_count`;
});
