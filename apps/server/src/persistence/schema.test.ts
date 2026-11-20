// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestDatabase from "../testing/database.ts";

const now = "2026-11-20T09:00:00.000Z";

const insertBot = (id: string) =>
  SqlClient.SqlClient.use(
    (sql) => sql`
      INSERT INTO bots (
        id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
        permission_mode, workspace_path, created_at, updated_at
      ) VALUES (
        ${id}, ${id}, '', 'circle', 'blue', '', 'claude', 'haiku', 'auto', ${`/bots/${id}`},
        ${now}, ${now}
      )
    `,
  );

it.layer(TestDatabase.layer)("database", (it) => {
  it.effect("keeps a room's host until the room is handed over, and a deleted bot's words", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot("scout");
      yield* insertBot("quill");
      yield* sql`
        INSERT INTO rooms (id, name, host_bot_id, hop_limit, created_at, updated_at)
        VALUES ('launch', 'Launch', 'scout', 4, ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO entries (
          id, room_id, position, kind, author_kind, author_bot_id, body_json, created_at,
          updated_at
        ) VALUES ('entry-1', 'launch', 0, 'message', 'bot', 'scout', '{}', ${now}, ${now})
      `;

      const refused = yield* sql`DELETE FROM bots WHERE id = 'scout'`.pipe(Effect.flip);
      assert.strictEqual(refused.reason._tag, "ConstraintError");

      yield* sql`UPDATE rooms SET host_bot_id = 'quill' WHERE id = 'launch'`;
      yield* sql`DELETE FROM bots WHERE id = 'scout'`;
      const authors = yield* sql<{ readonly author: string }>`
        SELECT author_bot_id AS author FROM entries WHERE id = 'entry-1'
      `;
      assert.deepStrictEqual(authors, [{ author: "scout" }]);
    }),
  );

  it.effect("never rewrites what a dispatch sends or where", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot("echo");
      yield* sql`
        INSERT INTO sessions (id, bot_id, purpose, prompt_version, created_at)
        VALUES ('session-1', 'echo', 'main', '0.3', ${now})
      `;
      yield* sql`
        INSERT INTO dispatches (
          id, bot_id, session_id, delivery, envelope, status, created_at, updated_at
        ) VALUES ('dispatch-1', 'echo', 'session-1', 'start', '<j3-wake/>', 'intended', ${now}, ${now})
      `;

      const rewritten = yield* sql`
        UPDATE dispatches SET envelope = '<j3-wake>other</j3-wake>' WHERE id = 'dispatch-1'
      `.pipe(Effect.flip);
      assert.include(String(rewritten.reason.cause), "keeps the session and envelope");

      yield* sql`
        UPDATE dispatches
        SET status = 'applied', disposition = 'started', engine_turn_id = 'turn-1'
        WHERE id = 'dispatch-1'
      `;
    }),
  );
});
