// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Earlier releases recorded a dismissal of an engine question as its answer.
// The engine refuses one for every question that holds a turn, keeps that
// refusal for the answer's key, and the server sent it again for as long as
// the turn waited. An engine question is no longer dismissed, so no recorded
// dismissal is left:
//
// - one never sent (no attempt counted, none taken) is forgotten, and its
//   card takes an answer again;
// - one sent and not taken spent its key: its card closes as `refused`, as a
//   refusal closes it now, and its turn waits for a Stop;
// - one the engine took closes its card as `dismissed`;
// - one whose request closed already only loses the record, since its card
//   shows how it closed.
//
// Every card changed is recorded as a change of its bot's conversation, where
// an engine request's card always is, so clients read it again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const dismissal = sql`json_extract(r.response_json, '$._tag') = 'dismiss'`;

  for (const [status, sent] of [
    ["refused", sql`r.response_sent_at IS NULL AND r.response_failures > 0`],
    ["dismissed", sql`r.response_sent_at IS NOT NULL`],
  ] as const) {
    const closing = sql`
      SELECT r.entry_id FROM engine_requests r
      WHERE ${dismissal} AND r.closed_at IS NULL AND ${sent}
    `;
    yield* sql`
      INSERT INTO changes (scope, entity_id, removed, created_at)
      SELECT 'conversation:' || conversation_bot_id, id, 0, ${now}
      FROM entries WHERE id IN (${closing}) AND conversation_bot_id IS NOT NULL
    `;
    yield* sql`
      UPDATE entries
      SET body_json = json_set(body_json, '$.status', json_object('_tag', ${status})),
        updated_at = ${now}
      WHERE id IN (${closing})
    `;
    yield* sql`
      UPDATE engine_requests SET closed_at = ${now}
      WHERE entry_id IN (${closing})
    `;
  }

  yield* sql`
    UPDATE engine_requests
    SET response_json = NULL, response_sent_at = NULL, response_failures = 0,
      response_retry_at = NULL
    WHERE json_extract(response_json, '$._tag') = 'dismiss'
  `;
});
