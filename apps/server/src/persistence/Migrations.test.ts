// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { assert, it } from "@effect/vitest";
import { Bot, Routine } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as TestDatabase from "../testing/database.ts";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_operator_name.ts";
import Migration0003 from "./migrations/0003_turns.ts";
import Migration0004 from "./migrations/0004_routines.ts";
import Migration0005 from "./migrations/0005_sessions.ts";
import Migration0006 from "./migrations/0006_notifications.ts";
import { json } from "./columns.ts";
import { migrate } from "./Migrations.ts";
import * as Sqlite from "./Sqlite.ts";

const now = "2026-11-20T09:00:00.000Z";

it.effect("upgrades a database the last release wrote, keeping its rows and their links", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const config = TestDatabase.configFor(path, home);

    // What the last release wrote: a bot with its session, a message in its
    // conversation and the file the message carries, the receipt of the
    // command that created the bot, and a paired device.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "1_initial": Migration0001,
          "2_operator_name": Migration0002,
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
      yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES ('scout', ${now})`;
      yield* sql`
        INSERT INTO sessions (id, bot_id, purpose, engine_session_id, prompt_version, created_at)
        VALUES ('session-1', 'scout', 'main', 'engine-1', 'v1', ${now})
      `;
      yield* sql`
        INSERT INTO entries (
          id, conversation_bot_id, position, kind, author_kind, body_json, created_at, updated_at
        ) VALUES ('entry-1', 'scout', 0, 'message', 'operator', '{}', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO blobs (sha256, size, storage_path, created_at)
        VALUES ('abc', 1, 'blobs/abc', ${now})
      `;
      yield* sql`
        INSERT INTO attachments (id, sha256, name, media_type, source, entry_id, created_at)
        VALUES ('file-1', 'abc', 'notes.txt', 'text/plain', 'operator', 'entry-1', ${now})
      `;
      const created = JSON.stringify({
        id: "scout",
        profile: { name: "scout", title: "", avatar: { shape: "circle", color: "blue" }, job: "" },
        model: { providerId: "claude", modelId: "haiku" },
        permissionMode: "auto",
        primary: false,
        pinned: false,
        hidden: false,
        state: { _tag: "idle" },
        createdAt: now,
      });
      yield* sql`
        INSERT INTO command_receipts (command_id, method, payload_hash, result_json, created_at)
        VALUES ('command-1', 'bot.create', 'hash', ${created}, ${now})
      `;
      yield* sql`
        INSERT INTO devices (id, name, token_hash, paired_at)
        VALUES ('device-1', 'Phone', 'fixture-token-hash', ${now})
      `;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

    // This release opens it.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* sql<{ readonly bot_id: string; readonly provider_id: string }>`
        SELECT bot_id, provider_id FROM sessions WHERE id = 'session-1'
      `;
      // A session from before runs on its bot's provider.
      assert.deepStrictEqual(sessions, [{ bot_id: "scout", provider_id: "claude" }]);
      const files = yield* sql<{ readonly entry_id: string | null }>`
        SELECT entry_id FROM attachments WHERE id = 'file-1'
      `;
      assert.deepStrictEqual(files, [{ entry_id: "entry-1" }]);
      // The command retried answers as it did, a bot with no settings change held.
      const [receipt] = yield* sql<{ readonly result_json: string }>`
        SELECT result_json FROM command_receipts WHERE command_id = 'command-1'
      `;
      const bot = yield* Schema.decodeUnknownEffect(json(Bot))(receipt?.result_json);
      assert.isFalse(bot.settingsHeld);
      // A paired device stays signed in.
      const devices = yield* sql<{
        readonly id: string;
        readonly token_hash: string;
        readonly revoked_at: string | null;
      }>`SELECT id, token_hash, revoked_at FROM devices`;
      assert.deepStrictEqual(devices, [
        { id: "device-1", token_hash: "fixture-token-hash", revoked_at: null },
      ]);
      const [foreignKeys] = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
      assert.strictEqual(foreignKeys?.foreign_keys, 1);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);

      // A dispatch's `seq` is never reused, also once the highest is deleted:
      // a Stop's mark keeps meaning the dispatches written before it.
      const dispatch = (id: string) => sql<{ readonly seq: number }>`
        INSERT INTO dispatches (
          id, bot_id, session_id, audience, delivery, envelope, status, created_at, updated_at
        ) VALUES (${id}, 'scout', 'session-1', 'conversation', 'start', '{}', 'intended', ${now},
          ${now})
        RETURNING seq
      `;
      const first = yield* dispatch("dispatch-1");
      yield* sql`DELETE FROM dispatches WHERE id = 'dispatch-1'`;
      const second = yield* dispatch("dispatch-2");
      assert.deepStrictEqual([...first, ...second], [{ seq: 1 }, { seq: 2 }]);
    }).pipe(Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replays a routine's receipt written before runs counted their attempts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const config = TestDatabase.configFor(path, home);
    const lastRun = {
      id: "run-1",
      startedAt: now,
      finishedAt: null,
      status: "running",
      delivered: [],
      note: null,
    };
    const routine = {
      id: "routine-1",
      botId: "scout",
      name: "Pull requests",
      instruction: "Check the open pull requests.",
      trigger: { _tag: "webhook" },
      enabled: true,
      webhookUrl: null,
      nextRunAt: null,
      lastRun,
      runCount: 1,
    };

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "1_initial": Migration0001,
          "2_operator_name": Migration0002,
          "3_turns": Migration0003,
          "4_routines": Migration0004,
          "5_sessions": Migration0005,
          "6_notifications": Migration0006,
        }),
      });
      yield* sql`
        INSERT INTO command_receipts (command_id, method, payload_hash, result_json, created_at)
        VALUES ('command-1', 'routine.update', 'hash', ${JSON.stringify(routine)}, ${now})
      `;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly result_json: string }>`
        SELECT result_json FROM command_receipts WHERE command_id = 'command-1'
      `;
      const replayed = yield* Schema.decodeUnknownEffect(json(Routine))(row?.result_json);
      assert.strictEqual(replayed.lastRun?.attempts, 0);
    }).pipe(Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a database that recorded a later migration than one it lacks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const config = TestDatabase.configFor(path, home);
    const fixture = Effect.void;

    const refused = yield* Effect.gen(function* () {
      // A release that had migration 12 but not 11 opened it.
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "10_fixture": fixture, "12_fixture": fixture }),
      });
      return yield* migrate(
        SqliteMigrator.fromRecord({
          "10_fixture": fixture,
          "11_fixture": fixture,
          "12_fixture": fixture,
        }),
      ).pipe(Effect.flip);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

    assert.strictEqual(refused._tag, "MigrationError");
    assert.include(refused.message, "11_fixture");
  }).pipe(Effect.provide(NodeServices.layer)),
);
