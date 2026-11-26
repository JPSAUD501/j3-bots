// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// An image a step of a bot's work looked at (decision 0075). A client knows
// it only by `id`, the `WorkStep.image` of its step; `path` is where it is in
// the bot's workspace, relative to the workspace, as the server found it when
// the step was recorded, and never leaves the server. The bytes are read again
// from there each time a device asks, so nothing is copied, and a file the bot
// changed or removed since shows as it is now, or not at all. A row goes with
// its step, and the step with its work fold. The step's row is written after
// its image's, in the same transaction, which names the image's id in it, so
// that reference is checked as the transaction commits.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE work_images (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      UNIQUE (entry_id, step_id),
      FOREIGN KEY (entry_id, step_id) REFERENCES work_steps (entry_id, step_id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    )
  `;
});
