// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_operator_name.ts";
import Migration0003 from "./migrations/0003_turns.ts";
import * as Sqlite from "./Sqlite.ts";

const now = "2026-11-20T09:00:00.000Z";

it.effect("keeps every row that points at a dispatch when an upgrade rebuilds the table", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const databasePath = path.join(home, "j3.sqlite");

    // A database the release before the rebuild wrote, with a dispatch that
    // a wake (set null on delete) and a staged file (deleted with it) point at.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "1_initial": Migration0001,
          "2_operator_name": Migration0002,
          "3_turns": Migration0003,
        }),
      });
      yield* sql`
        INSERT INTO bots (
          id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
          permission_mode, workspace_path, created_at, updated_at
        ) VALUES (
          'scout', 'scout', '', 'circle', 'blue', '', 'claude', 'haiku', 'auto', '/bots/scout',
          ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO sessions (id, bot_id, purpose, engine_session_id, prompt_version, created_at)
        VALUES ('session-1', 'scout', 'main', 'engine-1', 'v1', ${now})
      `;
      yield* sql`
        INSERT INTO dispatches (
          id, bot_id, session_id, audience, delivery, envelope, status, disposition,
          disposition_turn_id, engine_turn_id, attempts, created_at, updated_at
        ) VALUES (
          'dispatch-1', 'scout', 'session-1', 'conversation', 'start', '{}', 'finished',
          'started', 'turn-1', 'turn-1', 1, ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO wakes (
          id, bot_id, kind, priority, audience, payload_json, status, dispatch_id, created_at,
          updated_at
        ) VALUES (
          'wake-1', 'scout', 'user', 0, 'conversation', '{}', 'cancelled', 'dispatch-1', ${now},
          ${now}
        )
      `;
      yield* sql`
        INSERT INTO blobs (sha256, size, storage_path, created_at)
        VALUES ('abc', 1, 'blobs/abc', ${now})
      `;
      yield* sql`
        INSERT INTO attachments (id, sha256, name, media_type, source, created_at)
        VALUES ('file-1', 'abc', 'notes.txt', 'text/plain', 'operator', ${now})
      `;
      yield* sql`
        INSERT INTO dispatch_attachments (dispatch_id, position, attachment_id)
        VALUES ('dispatch-1', 0, 'file-1')
      `;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: databasePath })));

    // This release opens it.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const wakes = yield* sql<{ readonly dispatch_id: string | null }>`
        SELECT dispatch_id FROM wakes WHERE id = 'wake-1'
      `;
      assert.deepStrictEqual(wakes, [{ dispatch_id: "dispatch-1" }]);
      const staged = yield* sql<{ readonly attachment_id: string }>`
        SELECT attachment_id FROM dispatch_attachments WHERE dispatch_id = 'dispatch-1'
      `;
      assert.deepStrictEqual(staged, [{ attachment_id: "file-1" }]);
      const [foreignKeys] = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
      assert.strictEqual(foreignKeys?.foreign_keys, 1);
    }).pipe(
      Effect.provide(
        Sqlite.layer.pipe(
          Layer.provide(
            Layer.succeed(ServerConfig, {
              home,
              databasePath,
              host: "127.0.0.1",
              port: 0,
              tls: Option.none(),
              enginePort: 0,
              engineBinary: Option.none(),
              toolPort: 0,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
