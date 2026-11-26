// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A bot's main session rotates once its working context nears the point where
// the harness would compact it (decision 0074, `turns/Rotations.ts`): a new
// rotation reason, `context`, which the check on `sessions.rotation_reason`
// refuses. The column is replaced in place, as migration 0052 replaced
// `entries.kind`, with every reason 0005 allows and the new one; nothing else
// in the schema names it.
//
// How full the session's working context was as its latest turn that reported
// it ended: the tokens used, and the limit they were measured against. Null
// until a turn reports it; a session that has them is no longer rotated by
// its run count alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN due_reason TEXT CHECK (
      due_reason IN ('runs', 'context', 'context-recovered', 'provider-changed', 'fresh-start')
    )
  `;
  yield* sql`UPDATE sessions SET due_reason = rotation_reason`;
  yield* sql`ALTER TABLE sessions DROP COLUMN rotation_reason`;
  yield* sql`ALTER TABLE sessions RENAME COLUMN due_reason TO rotation_reason`;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN context_used INTEGER CHECK (context_used >= 0)
  `;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN context_limit INTEGER CHECK (context_limit > 0)
  `;
});
