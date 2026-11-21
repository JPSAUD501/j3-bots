// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Push registrations (`docs/architecture/server.md`, Notifications).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Where to push to a device while it has no socket open: one row per device
  // at most, gone when the device is revoked. A token belongs to one device:
  // an app that pairs again takes it from the device it was before.
  // `failures` counts the sends that failed since the token was registered.
  yield* sql`
    CREATE TABLE push_registrations (
      device_id TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('expo')),
      token TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      language TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
      UNIQUE (provider, token)
    )
  `;

  // Never written: the push token has its own table now.
  yield* sql`ALTER TABLE devices DROP COLUMN push_token`;
});
