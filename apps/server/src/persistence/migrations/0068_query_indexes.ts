// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Indexes for reads that scanned a whole table on every call, and for the
// cascades of deleting a bot, an entry or a wake, which scanned a table once
// for each row they removed. The server keeps no planner statistics, so a
// partial index serves a query only when the query's filter implies the
// index's filter as written: a `json_extract` here matches the queries'
// expression word for word.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A session's dispatches, in any state: most reads of a session's
  // dispatches name a state the open ones' index left out (`failed`,
  // `finished`), or none, and deleting a session found its dispatches with no
  // index at all. It serves every read the open ones' index did.
  yield* sql`DROP INDEX dispatches_open`;
  yield* sql`CREATE INDEX dispatches_session ON dispatches (session_id, status)`;
  // The dispatches not sent yet and those whose send is unanswered, in order.
  yield* sql`CREATE INDEX dispatches_intended ON dispatches (seq) WHERE status = 'intended'`;
  // A bot's dispatches waiting for a continuation, soonest first.
  yield* sql`
    CREATE INDEX dispatches_continuing ON dispatches (bot_id, continuation_resumes_at)
    WHERE continuation_resumes_at IS NOT NULL
  `;

  // Each bot's opening.
  yield* sql`
    CREATE INDEX wakes_opening ON wakes (bot_id)
    WHERE json_extract(payload_json, '$._tag') = 'first-run'
  `;

  // The cards still waiting on the operator, and the requests for input of
  // a connector, by conversation.
  yield* sql`CREATE INDEX ask_cards_open ON ask_cards (entry_id) WHERE closed_at IS NULL`;
  yield* sql`
    CREATE INDEX entries_connector_input ON entries (conversation_bot_id)
    WHERE kind = 'connector-input'
  `;

  // The turns whose little ones still work after the turn ended.
  yield* sql`
    CREATE INDEX turns_little_ones ON turns (session_id)
    WHERE json_extract(work_json, '$.littleOnes.working') > 0
  `;
  // A room's turns whose work may still run there: not finished, or with
  // background work pending. It also serves the reads of the running ones
  // alone, which the index it replaces served.
  yield* sql`DROP INDEX turns_room_running`;
  yield* sql`
    CREATE INDEX turns_room_running ON turns (audience_room_id)
    WHERE audience_room_id IS NOT NULL AND (finished_at IS NULL OR background_pending = 1)
  `;

  // What points at an entry, a dispatch or a wake, for the cascade that
  // clears it when that row is deleted. The unique index on a session's side
  // wake covers live sessions only.
  yield* sql`
    CREATE INDEX turns_work_fold ON turns (work_fold_entry_id)
    WHERE work_fold_entry_id IS NOT NULL
  `;
  yield* sql`CREATE INDEX turns_said ON turns (said_entry_id) WHERE said_entry_id IS NOT NULL`;
  yield* sql`CREATE INDEX host_speech_entry ON host_speech (entry_id) WHERE entry_id IS NOT NULL`;
  yield* sql`
    CREATE INDEX catch_up_notes_dispatch ON catch_up_notes (consumed_dispatch_id)
    WHERE consumed_dispatch_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX ask_cards_origin ON ask_cards (origin_wake_id) WHERE origin_wake_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX sessions_side_wake_any ON sessions (side_wake_id) WHERE side_wake_id IS NOT NULL
  `;
});
