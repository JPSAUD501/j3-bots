// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A room counts rounds of its bots answering each other since the operator's
// word last reached it, not their messages (decision 0042,
// docs/architecture/server.md, The room's rounds).
//
// Each room message keeps its round, written by routing in the transaction
// that posts it and never changed after: 0 for the operator's word (their
// message, a bot's kickoff, a request of theirs a bot relayed), and one past
// the newest round a bot's turn was shown for a bot's own. The room's newest
// round-0 message is their latest word there, which an index finds. A room
// dispatch keeps the round its reply takes, fixed with the rest of what it
// was written with: its envelope's closing line says so, and a message of the
// turn it starts or steers takes it.
//
// `rooms.bot_streak`, the count of messages, goes: nothing reads it. Its
// column check names no other column, so SQLite drops it in place.
//
// Rounds were never recorded before, so every existing room starts at round
// 0: each of its messages counts as the operator's word, and a room dispatch
// not yet answered takes round 1, as one written now after that word would.
// A room's bots so get their rounds again once, from the upgrade, as they
// would from a message of the operator's.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE entries ADD COLUMN room_round INTEGER
      CHECK (room_round IS NULL OR (room_round >= 0 AND room_id IS NOT NULL AND kind = 'message'))
  `;
  yield* sql`UPDATE entries SET room_round = 0 WHERE room_id IS NOT NULL AND kind = 'message'`;
  yield* sql`
    CREATE TRIGGER entries_fixed_round
    BEFORE UPDATE OF room_round ON entries
    WHEN OLD.room_round IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'a room message keeps its round');
    END
  `;
  yield* sql`CREATE INDEX entries_room_word ON entries (room_id, position) WHERE room_round = 0`;

  yield* sql`
    ALTER TABLE dispatches ADD COLUMN room_round INTEGER
      CHECK (room_round IS NULL OR (room_round >= 1 AND audience = 'room'))
  `;
  yield* sql`UPDATE dispatches SET room_round = 1 WHERE room_through IS NOT NULL`;
  yield* sql`DROP TRIGGER dispatches_immutable_intent`;
  yield* sql`
    CREATE TRIGGER dispatches_immutable_intent
    BEFORE UPDATE OF session_id, audience, delivery, steer_turn_id, fresh_context, envelope,
      room_through, room_round
    ON dispatches
    BEGIN
      SELECT RAISE(ABORT, 'a dispatch keeps the session, audience and envelope it was written with');
    END
  `;

  yield* sql`ALTER TABLE rooms DROP COLUMN bot_streak`;
});
