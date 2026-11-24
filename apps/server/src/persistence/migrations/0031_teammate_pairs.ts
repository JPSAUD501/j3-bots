// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each teammate message, as the teammate conversation of its two bots lists
  // it (docs/decisions/0038). Nothing moves: the message stays its two
  // `handoff` cards and its `handoffs` row, which delivery works from. This
  // only says which pair it belongs to and where it sorts among them, `seq`,
  // given in the order messages are sent.
  // A `handoffs` row goes with the received card, so the cards are named
  // here directly, each set to null once its bot is deleted: the other bot
  // still reads the message from its own card. A message with neither card
  // left is gone, and so is its row. Bot ids outlive bots, as on entries.
  yield* sql`
    CREATE TABLE pair_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_low TEXT NOT NULL,
      pair_high TEXT NOT NULL,
      sender_bot_id TEXT NOT NULL,
      recipient_bot_id TEXT NOT NULL,
      sent_entry_id TEXT UNIQUE REFERENCES entries (id) ON DELETE SET NULL,
      received_entry_id TEXT UNIQUE REFERENCES entries (id) ON DELETE SET NULL,
      CHECK (pair_low < pair_high),
      CHECK (
        (sender_bot_id = pair_low AND recipient_bot_id = pair_high)
        OR (sender_bot_id = pair_high AND recipient_bot_id = pair_low)
      ),
      CHECK (sent_entry_id IS NOT NULL OR received_entry_id IS NOT NULL)
    )
  `;
  yield* sql`CREATE INDEX pair_messages_pair ON pair_messages (pair_low, pair_high, seq)`;
  yield* sql`CREATE INDEX pair_messages_high ON pair_messages (pair_high)`;
  // The second card's deletion would leave a row with neither, which the
  // check refuses; the row goes first. The trigger names `entries.kind`, so a
  // later migration that replaces that column (as 0028 did, to widen its
  // check) must drop this trigger first and create it again after, as 0028
  // did `entries_fixed_place`: SQLite refuses to drop a column a trigger names.
  yield* sql`
    CREATE TRIGGER pair_messages_gone
    BEFORE DELETE ON entries
    WHEN OLD.kind = 'handoff'
    BEGIN
      DELETE FROM pair_messages
      WHERE (sent_entry_id = OLD.id AND received_entry_id IS NULL)
        OR (received_entry_id = OLD.id AND sent_entry_id IS NULL);
    END
  `;

  // Which sender's cards have a row is asked of every sent card below, and
  // of every row whenever a sender's card is deleted: without this index,
  // each asks the whole table, and a large database takes longer to upgrade
  // than the service waits for the server to be ready.
  yield* sql`CREATE INDEX handoffs_sent ON handoffs (sent_entry_id)`;

  // Every message sent before this, in the order it was sent: a card's `seq`
  // is the order entries were written, and the sent card is written first.
  // Each `handoffs` row is one message. A recipient's deletion took its
  // received cards and their rows with it: then the sender's card, which has
  // no row, is the message.
  yield* sql`
    INSERT INTO pair_messages (
      pair_low, pair_high, sender_bot_id, recipient_bot_id, sent_entry_id, received_entry_id
    )
    SELECT min(sender, recipient), max(sender, recipient), sender, recipient, sent, received
    FROM (
      SELECT received.author_bot_id AS sender, h.recipient_bot_id AS recipient,
        sent.id AS sent, received.id AS received, COALESCE(sent.seq, received.seq) AS written
      FROM handoffs h
      JOIN entries received ON received.id = h.received_entry_id
      LEFT JOIN entries sent ON sent.id = h.sent_entry_id
      UNION ALL
      SELECT sent.author_bot_id, json_extract(sent.body_json, '$.recipientId'),
        sent.id, NULL, sent.seq
      FROM entries sent
      WHERE sent.kind = 'handoff'
        AND json_extract(sent.body_json, '$.direction') = 'sent'
        AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.sent_entry_id = sent.id)
    )
    ORDER BY written
  `;
});
