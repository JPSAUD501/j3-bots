// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The connectors' apps a turn's tool calls opened (decision 0048,
// docs/architecture/server.md, "Connector apps"). A view is one call's app:
// the work fold it is shown under, the bot and connector whose call it was,
// the tool, its input, its answer as the connector gave it (null when too
// large to keep for the app), and the app's policy. Its document
// is kept once per content (`connector_app_documents`, by SHA-256), since a
// tool opens the same document at each call, and goes when no view uses it.
// A view goes with its fold; the bot and the connector may go first, and the
// app's own requests are then refused.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE connector_app_documents (
      digest TEXT PRIMARY KEY,
      html TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE connector_app_views (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      connector_name TEXT NOT NULL,
      tool_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      document_digest TEXT NOT NULL REFERENCES connector_app_documents (digest),
      csp_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX connector_app_views_entry ON connector_app_views (entry_id)`;
  yield* sql`CREATE INDEX connector_app_views_document ON connector_app_views (document_digest)`;
  yield* sql`
    CREATE TRIGGER connector_app_documents_unused AFTER DELETE ON connector_app_views
    BEGIN
      DELETE FROM connector_app_documents
      WHERE digest = OLD.document_digest
        AND NOT EXISTS (
          SELECT 1 FROM connector_app_views WHERE document_digest = OLD.document_digest
        );
    END
  `;
});
