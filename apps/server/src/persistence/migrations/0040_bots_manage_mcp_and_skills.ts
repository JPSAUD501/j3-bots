// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The bots manage MCP servers and skills (decision 0049).
//
// - Who last added, changed or granted a connector, and when: the operator
//   (`{"_tag":"operator"}`) or a bot (`{"_tag":"bot","botId":…}`), whose id
//   outlives it as on entries. Null for one last changed before 0.9.0.
// - What J3 Bots knows of each skill it wrote: where it came from (written,
//   or a repository's folder at a commit) and its last change. `scope_key` is
//   the bot's id for a bot's own skill and `''` for a shared one, so a shared
//   skill's key is never null; `bot_id` takes a bot's skill away with the bot.
//   A skill whose folder holds no record (put there by hand, imported with a
//   template before 0.9.0) is listed without one.
// - The connector suggestion card is gone: bots add servers themselves. Its
//   entries go, and the push deliveries that point at them, which foreign keys
//   would have removed with them were they on. Its kind stays allowed by the
//   column's check, which SQLite cannot change in place, and is never written.
//   A new entry takes the position after the last one, so a card that was a
//   conversation's last would leave its read mark, and where its next digest
//   starts, past positions new entries take: both come back to the last entry
//   left, and a new one is unread and digested again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE connectors ADD COLUMN changed_by_json TEXT`;
  yield* sql`ALTER TABLE connectors ADD COLUMN changed_at TEXT`;
  yield* sql`
    CREATE TABLE skill_records (
      scope_key TEXT NOT NULL,
      bot_id TEXT REFERENCES bots (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source_json TEXT NOT NULL,
      changed_by_json TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, name),
      CHECK ((bot_id IS NULL AND scope_key = '') OR scope_key = bot_id)
    )
  `;
  yield* sql`
    DELETE FROM push_deliveries
    WHERE entry_id IN (SELECT id FROM entries WHERE kind = 'connector-suggestion')
  `;
  yield* sql`DELETE FROM entries WHERE kind = 'connector-suggestion'`;
  const last = sql`(SELECT MAX(position) FROM entries WHERE conversation_bot_id = conversations.bot_id)`;
  yield* sql`
    UPDATE conversations SET read_through_order = ${last}
    WHERE read_through_order > COALESCE(${last}, -1)
  `;
  yield* sql`
    UPDATE conversations SET digest_from_position = COALESCE(${last} + 1, 0)
    WHERE digest_from_position > COALESCE(${last} + 1, 0)
  `;
});
