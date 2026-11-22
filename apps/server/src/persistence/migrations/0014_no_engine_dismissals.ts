// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Earlier releases recorded a dismissal of an engine question as its answer.
// The engine refuses one for every question that holds a turn, and the server
// sent it again for as long as the turn waited. An engine question is no
// longer dismissed, so a recorded dismissal is forgotten: its card takes an
// answer again. If the engine already refused it, the answer's key is spent
// and that answer is refused too, once; the turn then waits for a Stop.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE engine_requests
    SET response_json = NULL, response_sent_at = NULL, response_failures = 0,
      response_retry_at = NULL
    WHERE json_extract(response_json, '$._tag') = 'dismiss'
  `;
});
