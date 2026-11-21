// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Push deliveries (`docs/architecture/server.md`, Notifications).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One notification to push to one device, written with the entry it is
  // about. `pending` waits to be sent, with its words as they were rendered
  // then: `body` as the previews setting allowed, `plain_body` the fixed
  // sentence without a preview, for a send made after previews were turned
  // off. Once the push service took it, it is `accepted`, its words are
  // dropped and the service's receipt is kept until it is read. A delivery is
  // deleted once it settles. `due_at` is when the worker next acts on it: its
  // next send, or the next look at its receipt. `deadline_at` ends the stage it
  // is in. `attempts` counts the sends begun, each recorded before it is made;
  // `token` is the one the last send went to, and `sent_at` when it began.
  yield* sql`
    CREATE TABLE push_deliveries (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
      title TEXT,
      body TEXT,
      plain_body TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      token TEXT,
      sent_at TEXT,
      receipt_id TEXT,
      due_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (entry_id, device_id),
      CHECK (
        (status = 'pending') = (title IS NOT NULL AND body IS NOT NULL AND plain_body IS NOT NULL)
      ),
      CHECK ((status = 'accepted') = (receipt_id IS NOT NULL AND token IS NOT NULL)),
      CHECK ((token IS NULL) = (sent_at IS NULL))
    )
  `;
  yield* sql`CREATE INDEX push_deliveries_due ON push_deliveries (due_at)`;
  yield* sql`CREATE INDEX push_deliveries_deadline ON push_deliveries (deadline_at)`;
});
