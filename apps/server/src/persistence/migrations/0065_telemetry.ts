// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Anonymous usage data (decision 0099). The operator's switch, on unless they
// turn it off (`Settings.telemetry`). The install's random id, made the first
// time the server needs it, which leaves the server only as its SHA-256
// hash, the day it last said it was in use, the release it last ran and the
// update run it last told the outcome of. And the events that left,
// newest kept, exactly as they were sent, for "See what is sent".
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN telemetry INTEGER NOT NULL DEFAULT 1
      CHECK (telemetry IN (0, 1))
  `;
  yield* sql`
    CREATE TABLE telemetry_install (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      install_id TEXT NOT NULL,
      active_day TEXT,
      last_version TEXT,
      told_update_run TEXT
    )
  `;
  yield* sql`
    CREATE TABLE telemetry_sent (
      uuid TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL,
      body TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX telemetry_sent_by_time ON telemetry_sent (sent_at)`;
});
