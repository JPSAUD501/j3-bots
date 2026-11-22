// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The operator's time zone comes from their device until they choose one
// (`settings/SettingsService.ts`): the server starts at UTC, and the first
// device that opens a socket sets its own zone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Whether the zone was set, by the operator or by the first device. While
  // it was not, the next device to open a socket sets it.
  yield* sql`
    ALTER TABLE settings ADD COLUMN time_zone_set INTEGER NOT NULL DEFAULT 0
      CHECK (time_zone_set IN (0, 1))
  `;
  // Nothing recorded who set a zone before: one other than the starting UTC
  // was chosen. A UTC the operator chose is not told from the starting one,
  // so it gives way to their device's zone, which Settings then shows.
  yield* sql`UPDATE settings SET time_zone_set = 1 WHERE time_zone <> 'UTC'`;
});
