// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Themes (decision 0104). The themes the operator and the bots saved, each
// its definition as JSON (`ThemeDefinition`) and who made it; the image one
// shows behind the conversation, kept apart so listing themes never reads
// it; and the theme a device shows until its person picks one, a built-in's
// id or a saved theme's, `palco` until the operator chooses.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE themes (
      id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      made_by_bot TEXT REFERENCES bots (id) ON DELETE SET NULL,
      made_by TEXT NOT NULL CHECK (made_by IN ('operator', 'bot')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE theme_backgrounds (
      theme_id TEXT PRIMARY KEY REFERENCES themes (id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
      bytes BLOB NOT NULL
    )
  `;
  yield* sql`ALTER TABLE settings ADD COLUMN default_theme TEXT NOT NULL DEFAULT 'palco'`;
});
