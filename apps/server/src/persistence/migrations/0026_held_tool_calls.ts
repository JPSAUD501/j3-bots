// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The `j3` tool call an engine request holds back: a connector's call waiting
// on its approval (`engine_tool_calls.engine_call_id`). Once the operator
// declines that approval, no bot tool request can claim the call. Null for
// every other request, and for every request recorded before this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE engine_requests ADD COLUMN engine_call_id TEXT`;
});
