// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The AI accounts the operator sets up (decision 0108): each a Claude Code or
// Codex provider of its own, with its home under `<J3_HOME>/providers/<id>`.
// The first of each harness is the one every install had, under the harness's
// own id, so the bots on it stay where they are; the operator can add more of
// a harness, and remove only those. A bot's fast mode, off as every bot was,
// and the models the operator starred, none at first.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_accounts (
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'codex')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      binary_path TEXT,
      launch_arguments TEXT NOT NULL DEFAULT '',
      added INTEGER NOT NULL CHECK (added IN (0, 1)),
      position INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO provider_accounts (id, harness, name, added, position) VALUES
      ('claude-code', 'claude-code', 'Claude Code', 0, 0),
      ('codex', 'codex', 'Codex', 0, 1)
  `;
  yield* sql`ALTER TABLE bots ADD COLUMN fast INTEGER NOT NULL DEFAULT 0 CHECK (fast IN (0, 1))`;
  yield* sql`ALTER TABLE settings ADD COLUMN favorite_models_json TEXT NOT NULL DEFAULT '[]'`;
});
