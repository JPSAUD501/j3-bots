// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine can refuse a bot's permission mode until its settings change or
// it starts again under another policy, as an administrator's policy on its
// machine does: the bot's main session is then neither opened nor aligned
// again until one of them happens (`bots/EngineSessions.ts`), and a routine's
// run says it failed for that (`routines/RoutineRunner.ts`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The bot's `settings_revision` whose permission mode the engine refused.
  // Cleared each time the engine becomes ready, so it is asked once more.
  yield* sql`ALTER TABLE bots ADD COLUMN mode_refused_revision INTEGER`;
  // The refusal the bot's conversation was told of: its revision and the
  // highest mode the engine allowed, if it named one. A refusal at another
  // revision, or naming another mode, is told again. Cleared once the bot's
  // main session opens or is aligned.
  yield* sql`ALTER TABLE bots ADD COLUMN mode_refusal_told_revision INTEGER`;
  yield* sql`
    ALTER TABLE bots ADD COLUMN mode_refusal_told_allowed TEXT
      CHECK (mode_refusal_told_allowed IN ('supervised', 'auto-accept-edits', 'auto', 'full-access'))
  `;
  // Why the run's last attempt failed, when J3 Bots can name it
  // (`RoutineRunFailure`, as JSON). Cleared when the run tries again.
  yield* sql`ALTER TABLE routine_runs ADD COLUMN failure_json TEXT`;
});
