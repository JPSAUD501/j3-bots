// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Reactions on messages (decision 0084).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One reaction per reactor per message: the operator, or a bot, whose id
  // outlives it as an author's does, so it has no foreign key. Picking another
  // emoji replaces the row; taking it off deletes it. Ordered by when the
  // reactor first reacted there.
  yield* sql`
    CREATE TABLE reactions (
      entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
      reactor_kind TEXT NOT NULL CHECK (reactor_kind IN ('operator', 'bot')),
      reactor_bot_id TEXT,
      emoji TEXT NOT NULL,
      reacted_at TEXT NOT NULL,
      CHECK ((reactor_kind = 'bot') = (reactor_bot_id IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX reactions_one_each
    ON reactions (entry_id, reactor_kind, IFNULL(reactor_bot_id, ''))
  `;

  // The operator's reaction on a bot's message, waiting out a few seconds of
  // changes before it reaches that bot (`ReactionSignals`). One per bot and
  // message: a change meanwhile moves it later.
  yield* sql`
    CREATE TABLE reaction_signals (
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
      due_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, entry_id)
    )
  `;

  // A turn started by a reaction alone, until it says or reacts: it shows no
  // work and tells nothing of how it ended.
  yield* sql`
    ALTER TABLE turns ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1))
  `;
});
