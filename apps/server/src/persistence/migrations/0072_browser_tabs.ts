// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// J3 Bots runs its own browsers (decision 0110). Each tab it knows is kept,
// so a tab keeps its ref, its opener and the bots on it across a restart of
// the server or of the browser it runs in: after a restart every tab is
// parked until a browser holds it again. A private tab is never stored.
//
// A browser help card names its tab by its ref now. A card still open keeps
// the engine's tab id it had, which names no tab: it closes as its tab closed
// once the sweep's grace passes. The engine's browser is off for every bot,
// so nothing is withdrawn from a bot's project any more.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE browser_tabs (
      ref TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      opened_by_json TEXT NOT NULL,
      on_it_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      used_at INTEGER NOT NULL
    )
  `;
  yield* sql`ALTER TABLE browser_help_cards RENAME COLUMN engine_tab_id TO tab_ref`;
  yield* sql`ALTER TABLE bots DROP COLUMN browser_withdrawals`;
});
