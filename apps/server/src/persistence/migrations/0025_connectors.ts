// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The operator's connectors (docs/architecture/server.md, "Connectors"). A
// row holds none of a connector's secrets, which are in the vault under its
// id, nor an OAuth sign-in's account and time, which are the sign-in's.
// `signed_in_at` is when the operator last gave its form's values. `slug` names its tools for bots and is unique. `tools_json` is the
// catalog the operator accepted, null until its server first listed its
// tools; `kept_revision` is the review the operator answered with "keep".
// Which bots may use it: every bot (`all_bots`), or those in
// `connector_bots`, which a deleted bot leaves. A removed connector's row
// goes at once; `connector_removals` keeps, until it is done, what is left
// to do outside this database: revoking its OAuth sign-in (`revoke`) and
// deleting its vault record (`secrets`), which wait for an unlocked vault.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      glyph TEXT,
      publisher_json TEXT NOT NULL,
      listing_json TEXT,
      transport_json TEXT NOT NULL,
      sign_in TEXT NOT NULL CHECK (sign_in IN ('oauth', 'fields', 'none')),
      fields_json TEXT NOT NULL,
      private_network INTEGER NOT NULL CHECK (private_network IN (0, 1)),
      all_bots INTEGER NOT NULL CHECK (all_bots IN (0, 1)),
      signed_in_at TEXT,
      tools_json TEXT,
      kept_revision TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE connector_bots (
      connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      PRIMARY KEY (connector_id, bot_id)
    )
  `;
  yield* sql`CREATE INDEX connector_bots_bot ON connector_bots (bot_id)`;
  yield* sql`
    CREATE TABLE connector_removals (
      connector_id TEXT PRIMARY KEY,
      revoke INTEGER NOT NULL CHECK (revoke IN (0, 1)),
      secrets INTEGER NOT NULL CHECK (secrets IN (0, 1))
    )
  `;
});
