// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Dictation through a cloud provider only (decision 0107): the provider the
// operator chose, which a device without a recognizer of its own dictates
// with. A place that named a provider names it here too; the server's own
// model is gone, so a place that chose it becomes automatic. The columns of
// the model and the AI's tidy-up stay for a rollback to read.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN voice_provider TEXT
      CHECK (voice_provider IN ('openai', 'xai', 'openrouter'))
  `;
  yield* sql`
    UPDATE settings SET voice_provider = voice_place
    WHERE voice_place IN ('openai', 'xai', 'openrouter')
  `;
  yield* sql`UPDATE settings SET voice_place = 'automatic' WHERE voice_place = 'server'`;
});
