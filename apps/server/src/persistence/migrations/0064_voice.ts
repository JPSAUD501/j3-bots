// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Dictation's preferences (decision 0096), one set for the server and every
// device (`Settings.voice`): where speech is recognized, the language, the
// words to always spell right (a JSON array), whether to take filler words
// out and to have the AI tidy up, and the chosen local model and OpenRouter
// model, null for J3 Bots' pick. A cloud provider's key is a secret, kept in
// Secrets, not here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE settings ADD COLUMN voice_place TEXT NOT NULL DEFAULT 'automatic'
      CHECK (voice_place IN ('automatic', 'device', 'server', 'openai', 'xai', 'openrouter'))
  `;
  yield* sql`ALTER TABLE settings ADD COLUMN voice_language TEXT NOT NULL DEFAULT 'auto'`;
  yield* sql`ALTER TABLE settings ADD COLUMN voice_words_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`
    ALTER TABLE settings ADD COLUMN voice_remove_fillers INTEGER NOT NULL DEFAULT 1
      CHECK (voice_remove_fillers IN (0, 1))
  `;
  yield* sql`
    ALTER TABLE settings ADD COLUMN voice_clean_up INTEGER NOT NULL DEFAULT 0
      CHECK (voice_clean_up IN (0, 1))
  `;
  yield* sql`ALTER TABLE settings ADD COLUMN voice_model TEXT`;
  yield* sql`ALTER TABLE settings ADD COLUMN voice_openrouter_model TEXT`;
});
