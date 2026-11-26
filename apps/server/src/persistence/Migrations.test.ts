// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { assert, it } from "@effect/vitest";
import {
  Bot,
  FillOutcome,
  Routine,
  SecretId,
  SiteOrigin,
  TimeZone,
  WorkStep,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as SettingsStore from "../settings/SettingsStore.ts";
import * as TestDatabase from "../testing/database.ts";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_operator_name.ts";
import Migration0003 from "./migrations/0003_turns.ts";
import Migration0004 from "./migrations/0004_routines.ts";
import Migration0005 from "./migrations/0005_sessions.ts";
import Migration0006 from "./migrations/0006_notifications.ts";
import Migration0007 from "./migrations/0007_routine_runs.ts";
import Migration0008 from "./migrations/0008_teammate_messages.ts";
import Migration0009 from "./migrations/0009_room_turns.ts";
import Migration0010 from "./migrations/0010_push_registrations.ts";
import Migration0011 from "./migrations/0011_push_deliveries.ts";
import Migration0012 from "./migrations/0012_room_integrity.ts";
import Migration0013 from "./migrations/0013_bot_avatar_colors.ts";
import { updateChannelMigration } from "./migrations/0023_update_channel.ts";
import { json } from "./columns.ts";
import { migrate, migrationsThrough } from "./Migrations.ts";
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
      // A bot given a color the clients' palette does not have, and one the
      // operator made gray.
      yield* sql`
        INSERT INTO bots (
          id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
          permission_mode, workspace_path, created_at, updated_at
        ) VALUES
          ('scribe', 'scribe', '', 'circle', 'amber', '', 'claude', 'haiku', 'auto', '/bots/scribe',
            ${now}, ${now}),
          ('keeper', 'keeper', '', 'square', 'gray', '', 'claude', 'haiku', 'auto', '/bots/keeper',
            ${now}, ${now})
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
      const scout = {
        id: "scout",
        profile: { name: "scout", title: "", avatar: { shape: "circle", color: "blue" }, job: "" },
        model: { providerId: "claude", modelId: "haiku" },
        permissionMode: "auto",
        primary: false,
        pinned: false,
        hidden: false,
        state: { _tag: "idle" },
        createdAt: now,
      };
      const created = JSON.stringify(scout);
      const scribe = JSON.stringify({
        ...scout,
        id: "scribe",
        profile: {
          name: "scribe",
          title: "",
          avatar: { shape: "circle", color: "amber" },
          job: "",
        },
      });
      yield* sql`
        INSERT INTO command_receipts (command_id, method, payload_hash, result_json, created_at)
        VALUES ('command-1', 'bot.create', 'hash', ${created}, ${now}),
          ('command-2', 'bot.create', 'hash', ${scribe}, ${now})
      `;
      yield* sql`
        INSERT INTO devices (id, name, token_hash, paired_at)
        VALUES ('device-1', 'Phone', 'fixture-token-hash', ${now})
      `;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

    // This release opens it.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A color the clients drew stayed, gray too, and one they did not became the
      // first free one for the bot's shape (migration 13). Then each bot took the
      // silhouette and color nearest its own, also in the receipt of its creation.
      const avatars = yield* sql<{
        readonly id: string;
        readonly avatar_shape: string;
        readonly avatar_color: string;
      }>`SELECT id, avatar_shape, avatar_color FROM bots ORDER BY id`;
      assert.deepStrictEqual(avatars, [
        { id: "keeper", avatar_shape: "block", avatar_color: "slate" },
        { id: "scout", avatar_shape: "bean", avatar_color: "sky" },
        { id: "scribe", avatar_shape: "bean", avatar_color: "tomato" },
      ]);
      const [scribeReceipt] = yield* sql<{ readonly result_json: string }>`
        SELECT result_json FROM command_receipts WHERE command_id = 'command-2'
      `;
      const scribe = yield* Schema.decodeUnknownEffect(json(Bot))(scribeReceipt?.result_json);
      assert.deepStrictEqual(scribe.profile.avatar, { shape: "bean", color: "tomato" });
      const sessions = yield* sql<{ readonly bot_id: string; readonly provider_id: string }>`
        SELECT bot_id, provider_id FROM sessions WHERE id = 'session-1'
      `;
      // A session from before runs on its bot's provider.
      assert.deepStrictEqual(sessions, [{ bot_id: "scout", provider_id: "claude" }]);
      const files = yield* sql<{ readonly entry_id: string | null }>`
        SELECT entry_id FROM attachments WHERE id = 'file-1'
      `;
      assert.deepStrictEqual(files, [{ entry_id: "entry-1" }]);
      // The entry kept its kind when the kind's check widened (the browser help migration),
      // and an entry still cannot change it.
      const kinds = yield* sql<{ readonly kind: string }>`SELECT kind FROM entries`;
      assert.deepStrictEqual(kinds, [{ kind: "message" }]);
      const changed = yield* sql`UPDATE entries SET kind = 'notice' WHERE id = 'entry-1'`.pipe(
        Effect.flip,
      );
      assert.include(String(changed.reason.cause), "keeps its target, its place and its kind");
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

it.effect("closes a card whose dismissal was sent, and reopens one never sent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const config = TestDatabase.configFor(path, home);
    const answer = JSON.stringify({
      _tag: "question",
      answers: { "question-1": { optionIds: ["option-1"], text: null } },
    });
    const pending = JSON.stringify({ origin: "engine", status: { _tag: "pending" } });

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
          "7_routine_runs": Migration0007,
          "8_teammate_messages": Migration0008,
          "9_room_turns": Migration0009,
          "10_push_registrations": Migration0010,
          "11_push_deliveries": Migration0011,
          "12_room_integrity": Migration0012,
          "13_bot_avatar_colors": Migration0013,
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
          id, conversation_bot_id, position, kind, author_kind, author_bot_id, body_json,
          created_at, updated_at
        ) VALUES
          ('entry-1', 'scout', 0, 'question', 'bot', 'scout', ${pending}, ${now}, ${now}),
          ('entry-2', 'scout', 1, 'question', 'bot', 'scout', ${pending}, ${now}, ${now}),
          ('entry-3', 'scout', 2, 'question', 'bot', 'scout', ${pending}, ${now}, ${now}),
          ('entry-4', 'scout', 3, 'question', 'bot', 'scout', ${pending}, ${now}, ${now})
      `;
      // A dismissal the engine refused, sent again ever since; an answer
      // still on its way; a dismissal recorded while the engine was away,
      // never sent; and one the engine took, whose request has not closed yet.
      yield* sql`
        INSERT INTO engine_requests (
          entry_id, session_id, engine_request_id, engine_turn_id, response_json,
          response_sent_at, response_failures, response_retry_at
        ) VALUES
          ('entry-1', 'session-1', 'request-1', 'turn-1', '{"_tag":"dismiss"}', NULL, 7, ${now}),
          ('entry-2', 'session-1', 'request-2', 'turn-1', ${answer}, NULL, 1, ${now}),
          ('entry-3', 'session-1', 'request-3', 'turn-1', '{"_tag":"dismiss"}', NULL, 0, NULL),
          ('entry-4', 'session-1', 'request-4', 'turn-1', '{"_tag":"dismiss"}', ${now}, 0, NULL)
      `;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly entry_id: string;
        readonly closed: number;
        readonly response_json: string | null;
        readonly response_failures: number;
        readonly status: string;
      }>`
        SELECT r.entry_id, r.closed_at IS NOT NULL AS closed, r.response_json,
          r.response_failures, json_extract(e.body_json, '$.status._tag') AS status
        FROM engine_requests r JOIN entries e ON e.id = r.entry_id
        ORDER BY r.entry_id
      `;
      assert.deepStrictEqual(rows, [
        {
          entry_id: "entry-1",
          closed: 1,
          response_json: null,
          response_failures: 0,
          status: "refused",
        },
        {
          entry_id: "entry-2",
          closed: 0,
          response_json: answer,
          response_failures: 1,
          status: "pending",
        },
        {
          entry_id: "entry-3",
          closed: 0,
          response_json: null,
          response_failures: 0,
          status: "pending",
        },
        {
          entry_id: "entry-4",
          closed: 1,
          response_json: null,
          response_failures: 0,
          status: "dismissed",
        },
      ]);
      // Clients read the closed cards again.
      const changed = yield* sql<{ readonly scope: string; readonly entity_id: string }>`
        SELECT scope, entity_id FROM changes ORDER BY entity_id
      `;
      assert.deepStrictEqual(changed, [
        { scope: "conversation:scout", entity_id: "entry-1" },
        { scope: "conversation:scout", entity_id: "entry-4" },
      ]);
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

it.effect(
  "refuses a database a newer release migrated, naming the migration it does not know",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const config = TestDatabase.configFor(path, home);
      const fixture = Effect.void;

      const refused = yield* Effect.gen(function* () {
        // A newer release, with a migration 13 this one lacks, opened it.
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({
            "11_fixture": fixture,
            "12_fixture": fixture,
            "13_newer": fixture,
          }),
        });
        return yield* migrate(
          SqliteMigrator.fromRecord({ "11_fixture": fixture, "12_fixture": fixture }),
        ).pipe(Effect.flip);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      assert.strictEqual(refused._tag, "MigrationError");
      assert.include(refused.message, "13_newer");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a time zone set before devices gave theirs, and lets UTC take the device's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** The zone a database the last release wrote at `zone` keeps once a device gives its own. */
    const afterDevice = (zone: string) =>
      Effect.gen(function* () {
        const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* SqliteMigrator.run({
            loader: SqliteMigrator.fromRecord({
              "1_initial": Migration0001,
              "2_operator_name": Migration0002,
            }),
          });
          yield* sql`UPDATE settings SET time_zone = ${zone}`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

        return yield* Effect.gen(function* () {
          const store = yield* SettingsStore.SettingsStore;
          yield* store.adoptTimeZone(TimeZone.make("America/Sao_Paulo"), DateTime.makeUnsafe(now));
          return (yield* store.get).timeZone;
        }).pipe(
          Effect.provide(
            SettingsStore.layer.pipe(
              Layer.provide(Sqlite.layer),
              Layer.provide(Layer.succeed(ServerConfig, config)),
            ),
          ),
        );
      });

    assert.strictEqual(yield* afterDevice("Europe/Lisbon"), "Europe/Lisbon");
    assert.strictEqual(yield* afterDevice("UTC"), "America/Sao_Paulo");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts the update channel as the one of the release that first runs with it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** The channel a home gets when `running` is the first release with the setting. */
    const channelFrom = (running: string) =>
      Effect.gen(function* () {
        const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* SqliteMigrator.run({
            loader: SqliteMigrator.fromRecord({ "1_initial": Migration0001 }),
          });
          yield* updateChannelMigration(running);
          const rows = yield* sql`SELECT update_channel FROM settings`;
          const [row] = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ update_channel: Schema.String })),
          )(rows);
          return row?.update_channel;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));
      });

    assert.strictEqual(yield* channelFrom("0.3.2-nightly.20261124.1"), "nightly");
    assert.strictEqual(yield* channelFrom("0.3.1"), "stable");
    assert.strictEqual(yield* channelFrom("0.3.1-rc.1"), "stable");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "makes a save-login card an ask for a secret, keeping every entry and what links to it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(migrationsThrough(22));
        yield* sql`
        INSERT INTO bots (
          id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
          permission_mode, workspace_path, created_at, updated_at
        ) VALUES (
          'scout', 'scout', '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto', '/bots/scout',
          ${now}, ${now}
        )
      `;
        yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES ('scout', ${now})`;
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
        // The release that had the save-login card wrote one.
        yield* migrate(migrationsThrough(36));
        yield* sql`
        INSERT INTO entries (
          id, conversation_bot_id, position, kind, author_kind, author_bot_id, body_json,
          created_at, updated_at
        ) VALUES (
          'entry-2', 'scout', 1, 'credential-request', 'bot', 'scout', '{}', ${now}, ${now}
        )
      `;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The file still names its entry: the table was never dropped under it.
        const links = yield* sql`SELECT entry_id FROM attachments WHERE id = 'file-1'`;
        assert.deepStrictEqual(links, [{ entry_id: "entry-1" }]);
        const kinds = yield* sql`SELECT id, kind FROM entries ORDER BY position`;
        assert.deepStrictEqual(kinds, [
          { id: "entry-1", kind: "message" },
          { id: "entry-2", kind: "secret-ask" },
        ]);

        yield* sql`
        INSERT INTO entries (
          id, conversation_bot_id, position, kind, author_kind, author_bot_id, body_json,
          created_at, updated_at
        ) VALUES (
          'entry-3', 'scout', 2, 'secret-ask', 'bot', 'scout', '{}', ${now}, ${now}
        )
      `;
        const unknown = yield* sql`
        INSERT INTO entries (
          id, conversation_bot_id, position, kind, author_kind, body_json, created_at, updated_at
        ) VALUES ('entry-4', 'scout', 3, 'postcard', 'operator', '{}', ${now}, ${now})
      `.pipe(Effect.flip);
        assert.strictEqual(unknown.reason._tag, "ConstraintError");
        // An entry still keeps its kind: the check takes `notice`, the trigger does not.
        const moved = yield* sql`UPDATE entries SET kind = 'notice' WHERE id = 'entry-1'`.pipe(
          Effect.flip,
        );
        assert.strictEqual(moved.reason._tag, "ConstraintError");
      }).pipe(
        Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads the login fills an earlier release recorded, and says a locked one could not be used",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
      const fill = (id: string, outcome: Schema.Json) =>
        JSON.stringify({
          id,
          kind: "tool",
          tool: "login",
          label: "Filled a saved login",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          fill: {
            name: "example",
            credentialId: "cred_aaaaaaaaaaaaaaaa",
            field: "password",
            origin: "https://example.com",
            outcome,
          },
        });

      // The release with the vault filled a login once, and found it locked once.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(migrationsThrough(36));
        yield* sql`
        INSERT INTO bots (
          id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
          permission_mode, workspace_path, created_at, updated_at
        ) VALUES (
          'scout', 'scout', '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto', '/bots/scout',
          ${now}, ${now}
        )
      `;
        yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES ('scout', ${now})`;
        yield* sql`
        INSERT INTO entries (
          id, conversation_bot_id, position, kind, author_kind, author_bot_id, body_json,
          created_at, updated_at
        ) VALUES ('fold-1', 'scout', 0, 'work-fold', 'bot', 'scout', '{}', ${now}, ${now})
      `;
        yield* sql`
        INSERT INTO work_steps (entry_id, step_id, position, step_json) VALUES
          ('fold-1', 'step-1', 0, ${fill("step-1", { _tag: "filled", submitted: true })}),
          ('fold-1', 'step-2', 1, ${fill("step-2", { _tag: "locked" })})
      `;
        yield* sql`
        INSERT INTO sessions (id, bot_id, purpose, prompt_version, created_at)
        VALUES ('session-1', 'scout', 'main', 'v1', ${now})
      `;
        yield* sql`
        INSERT INTO tool_calls (
          id, session_id, engine_turn_id, engine_call_id, audience, tool, result_json, created_at
        ) VALUES (
          'call-1', 'session-1', 'turn-1', 'engine-call-1', 'conversation', 'fill_credential',
          '{"_tag":"locked"}', ${now}
        )
      `;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const steps = yield* sql<{ readonly step_json: string }>`
        SELECT step_json FROM work_steps ORDER BY position
      `;
        const decoded = yield* Effect.forEach(steps, (row) =>
          Schema.decodeEffect(json(WorkStep))(row.step_json),
        );
        assert.deepStrictEqual(
          decoded.map((step) => step.fill),
          [
            {
              name: "example",
              secretId: SecretId.make("cred_aaaaaaaaaaaaaaaa"),
              field: "password",
              origin: SiteOrigin.make("https://example.com"),
              outcome: { _tag: "filled", submitted: true },
            },
            {
              name: "example",
              secretId: SecretId.make("cred_aaaaaaaaaaaaaaaa"),
              field: "password",
              origin: SiteOrigin.make("https://example.com"),
              outcome: { _tag: "refused", reason: "unavailable" },
            },
          ],
        );
        // A retry of the locked call is answered as a fill refused now would be.
        const [answer] = yield* sql<{ readonly result_json: string }>`
        SELECT result_json FROM tool_calls WHERE id = 'call-1'
      `;
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(json(FillOutcome))(answer?.result_json),
          { _tag: "refused", reason: "unavailable" },
        );
      }).pipe(
        Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "lists every teammate message an earlier release sent in its pair, in the order sent",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
      const handoff = (recipientId: string, direction: "sent" | "received", text: string) =>
        JSON.stringify({ recipientId, direction, text, urgent: false, state: "sent" });

      // Ana and Bo wrote each other; Ana also wrote Cy, who was deleted since,
      // which took its received card and that message's `handoffs` row; and
      // Dee, deleted since too, wrote Ana, whose row lost its sent card.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(migrationsThrough(30));
        for (const id of ["ana", "bo"]) {
          yield* sql`
          INSERT INTO bots (
            id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
            permission_mode, workspace_path, created_at, updated_at
          ) VALUES (
            ${id}, ${id}, '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto', ${`/bots/${id}`},
            ${now}, ${now}
          )
        `;
          yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES (${id}, ${now})`;
        }
        const card = (id: string, botId: string, position: number, author: string, body: string) =>
          sql`
          INSERT INTO entries (
            id, conversation_bot_id, position, kind, author_kind, author_bot_id, body_json,
            created_at, updated_at
          ) VALUES (${id}, ${botId}, ${position}, 'handoff', 'bot', ${author}, ${body}, ${now}, ${now})
        `;
        yield* card("sent-1", "ana", 0, "ana", handoff("bo", "sent", "Draft the post."));
        yield* card("received-1", "bo", 0, "ana", handoff("bo", "received", "Draft the post."));
        yield* card("sent-2", "ana", 1, "ana", handoff("cy", "sent", "Check the prices."));
        yield* card("sent-3", "bo", 1, "bo", handoff("ana", "sent", "Posted."));
        yield* card("received-3", "ana", 2, "bo", handoff("ana", "received", "Posted."));
        yield* card("received-4", "ana", 3, "dee", handoff("ana", "received", "The brief."));
        yield* sql`
        INSERT INTO handoffs (recipient_bot_id, sent_entry_id, received_entry_id) VALUES
          ('bo', 'sent-1', 'received-1'),
          ('ana', 'sent-3', 'received-3'),
          ('ana', NULL, 'received-4')
      `;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const messages = sql`
        SELECT pair_low, pair_high, sender_bot_id, recipient_bot_id, sent_entry_id,
          received_entry_id
        FROM pair_messages ORDER BY seq
      `;
        assert.deepStrictEqual(yield* messages, [
          {
            pair_low: "ana",
            pair_high: "bo",
            sender_bot_id: "ana",
            recipient_bot_id: "bo",
            sent_entry_id: "sent-1",
            received_entry_id: "received-1",
          },
          {
            pair_low: "ana",
            pair_high: "cy",
            sender_bot_id: "ana",
            recipient_bot_id: "cy",
            sent_entry_id: "sent-2",
            received_entry_id: null,
          },
          {
            pair_low: "ana",
            pair_high: "bo",
            sender_bot_id: "bo",
            recipient_bot_id: "ana",
            sent_entry_id: "sent-3",
            received_entry_id: "received-3",
          },
          {
            pair_low: "ana",
            pair_high: "dee",
            sender_bot_id: "dee",
            recipient_bot_id: "ana",
            sent_entry_id: null,
            received_entry_id: "received-4",
          },
        ]);

        // A deleted bot's cards leave its messages to the other bot's; once
        // neither is left, the messages go.
        yield* sql`DELETE FROM conversations WHERE bot_id = 'bo'`;
        assert.deepStrictEqual(
          yield* sql`SELECT sent_entry_id, received_entry_id FROM pair_messages ORDER BY seq`,
          [
            { sent_entry_id: "sent-1", received_entry_id: null },
            { sent_entry_id: "sent-2", received_entry_id: null },
            { sent_entry_id: null, received_entry_id: "received-3" },
            { sent_entry_id: null, received_entry_id: "received-4" },
          ],
        );
        yield* sql`DELETE FROM conversations WHERE bot_id = 'ana'`;
        assert.deepStrictEqual(yield* messages, []);
      }).pipe(
        Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lists each of a large earlier release's teammate messages once, in the order sent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
    const count = 2000;
    // Message i: every tenth, from Ana to Cy, who was deleted since with its
    // received card and the message's row; every tenth from the fifth, from
    // Dee, deleted since too, to Ana, its row without a sent card; the
    // others, from Ana to Bo when i is odd and from Bo to Ana when it is even.
    const sent = Array.from({ length: count }, (_, index) => {
      const i = index + 1;
      if (i % 10 === 0) return ["ana", "cy"];
      if (i % 10 === 5) return ["dee", "ana"];
      return i % 2 === 1 ? ["ana", "bo"] : ["bo", "ana"];
    });

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* migrate(migrationsThrough(30));
      for (const id of ["ana", "bo"]) {
        yield* sql`
          INSERT INTO bots (
            id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
            permission_mode, workspace_path, created_at, updated_at
          ) VALUES (
            ${id}, ${id}, '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto', ${`/bots/${id}`},
            ${now}, ${now}
          )
        `;
        yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES (${id}, ${now})`;
      }
      yield* sql`
          CREATE TEMP TABLE fixture AS
          WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
          SELECT i,
            CASE WHEN i % 10 = 5 THEN 'dee' WHEN i % 10 = 0 OR i % 2 = 1 THEN 'ana' ELSE 'bo' END
              AS sender,
            CASE WHEN i % 10 = 0 THEN 'cy' WHEN i % 10 = 5 OR i % 2 = 0 THEN 'ana' ELSE 'bo' END
              AS recipient
          FROM n
        `;
      // Each sent card is written before its received card, in send order.
      yield* sql`
          INSERT INTO entries (
            id, conversation_bot_id, position, kind, author_kind, author_bot_id, body_json,
            created_at, updated_at
          )
          SELECT id, owner, position, 'handoff', 'bot', sender,
            json_object(
              'recipientId', recipient, 'direction', direction, 'text', 'Message ' || i,
              'urgent', json('false'), 'state', 'sent'
            ),
            ${now}, ${now}
          FROM (
            SELECT i, 0 AS part, 'sent-' || i AS id, sender AS owner, i * 2 AS position, sender,
              recipient, 'sent' AS direction
            FROM fixture WHERE i % 10 <> 5
            UNION ALL
            SELECT i, 1, 'received-' || i, recipient, i * 2 + 1, sender, recipient, 'received'
            FROM fixture WHERE i % 10 <> 0
          )
          ORDER BY i, part
        `;
      // The rows in the opposite order, so their own order says nothing.
      yield* sql`
          INSERT INTO handoffs (recipient_bot_id, sent_entry_id, received_entry_id)
          SELECT recipient, CASE WHEN i % 10 = 5 THEN NULL ELSE 'sent-' || i END, 'received-' || i
          FROM fixture WHERE i % 10 <> 0
          ORDER BY i DESC
        `;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`
            SELECT sender_bot_id, recipient_bot_id, sent_entry_id, received_entry_id
            FROM pair_messages ORDER BY seq
          `,
        sent.map(([sender, recipient], index) => ({
          sender_bot_id: sender,
          recipient_bot_id: recipient,
          sent_entry_id: sender === "dee" ? null : `sent-${index + 1}`,
          received_entry_id: recipient === "cy" ? null : `received-${index + 1}`,
        })),
      );
    }).pipe(Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps every room and its links without a host or a hop limit, and its wakes in the new words without hops",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
      const message = (text: string, mentions: object) =>
        JSON.stringify({ text, attachments: [], mentions, delivery: "delivered" });
      const wake = (entryId: string, reason: string) =>
        JSON.stringify({ _tag: "room", entryId, reason });

      // An active room Ana hosts, with Bo, and an archived one of Bo and Cy
      // whose host was deleted. The operator wrote to everyone and to nobody,
      // Ana to Bo, Bo's kickoff to Cy, and each wake says why its member woke
      // in 0.5.0's words.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(migrationsThrough(31));
        for (const id of ["ana", "bo", "cy"]) {
          yield* sql`
            INSERT INTO bots (
              id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
              permission_mode, workspace_path, created_at, updated_at
            ) VALUES (
              ${id}, ${id}, '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto', ${`/bots/${id}`},
              ${now}, ${now}
            )
          `;
        }
        yield* sql`
          INSERT INTO rooms (
            id, name, status, host_bot_id, hop_limit, pinned, archived_at, created_at, updated_at
          ) VALUES
            ('launch', 'Launch', 'active', 'ana', 3, 1, NULL, ${now}, ${now}),
            ('old', 'Old', 'archived', NULL, 4, 0, ${now}, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO room_members (room_id, bot_id, position) VALUES
            ('launch', 'ana', 0), ('launch', 'bo', 1), ('old', 'bo', 0), ('old', 'cy', 1)
        `;
        const entry = (
          id: string,
          roomId: string,
          position: number,
          author: string | null,
          body: string,
        ) =>
          sql`
            INSERT INTO entries (
              id, room_id, position, kind, author_kind, author_bot_id, body_json, created_at,
              updated_at
            ) VALUES (
              ${id}, ${roomId}, ${position}, 'message', ${author === null ? "operator" : "bot"},
              ${author}, ${body}, ${now}, ${now}
            )
          `;
        yield* entry("to-all", "launch", 0, null, message("Hello all.", { _tag: "everyone" }));
        yield* entry("to-none", "launch", 1, null, message("Ship it.", { _tag: "bots", ids: [] }));
        yield* entry("to-bo", "launch", 2, "ana", message("Bo?", { _tag: "bots", ids: ["bo"] }));
        yield* entry("kickoff", "old", 0, "bo", message("Begin.", { _tag: "bots", ids: ["cy"] }));
        const wakeOf = (
          id: string,
          roomId: string,
          entryId: string,
          reason: string,
          { botId = "bo", hops = 0 }: { readonly botId?: string; readonly hops?: number } = {},
        ) =>
          sql`
            INSERT INTO wakes (
              id, bot_id, kind, priority, audience, audience_room_id, hops, payload_json, status,
              source_entry_id, created_at, updated_at
            ) VALUES (
              ${id}, ${botId}, 'room', 0, 'room', ${roomId}, ${hops}, ${wake(entryId, reason)}, 'pending',
              ${entryId}, ${now}, ${now}
            )
          `;
        yield* wakeOf("w-all", "launch", "to-all", "everyone");
        yield* wakeOf("w-none", "launch", "to-none", "host");
        // Ana's message to Bo was a hop of a chain the room counted.
        yield* wakeOf("w-bo", "launch", "to-bo", "mentioned", { hops: 2 });
        yield* wakeOf("w-kickoff", "old", "kickoff", "kickoff", { botId: "cy" });
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`
            SELECT id, name, status, pinned, archived_at FROM rooms ORDER BY id
          `,
          [
            {
              id: "launch",
              name: "Launch",
              status: "active",
              pinned: 1,
              archived_at: null,
            },
            {
              id: "old",
              name: "Old",
              status: "archived",
              pinned: 0,
              archived_at: now,
            },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT room_id, bot_id, position FROM room_members ORDER BY room_id, position`,
          [
            { room_id: "launch", bot_id: "ana", position: 0 },
            { room_id: "launch", bot_id: "bo", position: 1 },
            { room_id: "old", bot_id: "bo", position: 0 },
            { room_id: "old", bot_id: "cy", position: 1 },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`
            SELECT id, room_id FROM entries ORDER BY seq
          `,
          [
            { id: "to-all", room_id: "launch" },
            { id: "to-none", room_id: "launch" },
            { id: "to-bo", room_id: "launch" },
            { id: "kickoff", room_id: "old" },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`
            SELECT id, audience_room_id, source_entry_id, hops, payload_json FROM wakes ORDER BY id
          `,
          [
            {
              id: "w-all",
              audience_room_id: "launch",
              source_entry_id: "to-all",
              hops: 0,
              payload_json: wake("to-all", "everyone"),
            },
            {
              id: "w-bo",
              audience_room_id: "launch",
              source_entry_id: "to-bo",
              hops: 0,
              payload_json: wake("to-bo", "addressed"),
            },
            {
              id: "w-kickoff",
              audience_room_id: "old",
              source_entry_id: "kickoff",
              hops: 0,
              payload_json: wake("kickoff", "kickoff"),
            },
            {
              id: "w-none",
              audience_room_id: "launch",
              source_entry_id: "to-none",
              hops: 0,
              payload_json: wake("to-none", "user"),
            },
          ],
        );
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);

        // A room's members go on without the bot that hosted it.
        yield* sql`DELETE FROM bots WHERE id = 'ana'`;
        assert.deepStrictEqual(
          yield* sql`SELECT bot_id FROM room_members WHERE room_id = 'launch'`,
          [{ bot_id: "bo" }],
        );
      }).pipe(
        Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "starts every room at round 0, a room dispatch waiting for its answer at round 1, and keeps each round once given",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());

      // 0.7.0's rows: a room where the operator and Ana wrote, with a notice,
      // Ana's conversation, and a dispatch of each audience to her session.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(migrationsThrough(33));
        yield* sql`
          INSERT INTO bots (
            id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
            permission_mode, workspace_path, created_at, updated_at
          ) VALUES (
            'ana', 'ana', '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto', '/bots/ana',
            ${now}, ${now}
          )
        `;
        yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES ('ana', ${now})`;
        yield* sql`
          INSERT INTO rooms (id, name, bot_streak, created_at, updated_at)
          VALUES ('launch', 'Launch', 7, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO entries (
            id, conversation_bot_id, room_id, position, kind, author_kind, author_bot_id,
            body_json, created_at, updated_at
          ) VALUES
            ('asked', NULL, 'launch', 0, 'message', 'operator', NULL, '{}', ${now}, ${now}),
            ('answered', NULL, 'launch', 1, 'message', 'bot', 'ana', '{}', ${now}, ${now}),
            ('noticed', NULL, 'launch', 2, 'notice', 'system', NULL, '{}', ${now}, ${now}),
            ('private', 'ana', NULL, 0, 'message', 'operator', NULL, '{}', ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO sessions (id, bot_id, purpose, prompt_version, created_at)
          VALUES ('session-1', 'ana', 'main', 'v1', ${now})
        `;
        yield* sql`
          INSERT INTO dispatches (
            id, bot_id, session_id, audience, audience_room_id, delivery, envelope, room_through,
            status, created_at, updated_at
          ) VALUES
            ('to-room', 'ana', 'session-1', 'room', 'launch', 'start', '<j3-wake/>', 2,
              'intended', ${now}, ${now}),
            ('to-ana', 'ana', 'session-1', 'conversation', NULL, 'start', '<j3-wake/>', NULL,
              'intended', ${now}, ${now})
        `;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT id, room_round FROM entries ORDER BY seq`, [
          { id: "asked", room_round: 0 },
          { id: "answered", room_round: 0 },
          { id: "noticed", room_round: null },
          { id: "private", room_round: null },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT id, room_round FROM dispatches ORDER BY seq`, [
          { id: "to-room", room_round: 1 },
          { id: "to-ana", room_round: null },
        ]);
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);

        // A round once given stays; a message without one gets it once.
        const changed = yield* sql`UPDATE entries SET room_round = 2 WHERE id = 'answered'`.pipe(
          Effect.flip,
        );
        assert.include(String(changed.reason.cause), "keeps its round");
        yield* sql`
          INSERT INTO entries (
            id, room_id, position, kind, author_kind, author_bot_id, body_json, created_at,
            updated_at
          ) VALUES ('next', 'launch', 3, 'message', 'bot', 'ana', '{}', ${now}, ${now})
        `;
        yield* sql`UPDATE entries SET room_round = 1 WHERE id = 'next'`;
        const rewritten = yield* sql`
          UPDATE dispatches SET room_round = 2 WHERE id = 'to-room'
        `.pipe(Effect.flip);
        assert.include(String(rewritten.reason.cause), "keeps the session, audience and envelope");
      }).pipe(
        Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "takes the suggestion cards out, and brings a read mark past them back to the last entry left",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = TestDatabase.configFor(path, yield* fs.makeTempDirectoryScoped());
      const entry = (id: string, bot: string, position: number, kind: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO entries (
              id, conversation_bot_id, position, kind, author_kind, body_json, created_at,
              updated_at
            ) VALUES (${id}, ${bot}, ${position}, ${kind}, 'operator', '{}', ${now}, ${now})
          `;
        });

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrate(migrationsThrough(39));
        for (const bot of ["scout", "ranger", "keeper"]) {
          yield* sql`
            INSERT INTO bots (
              id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
              permission_mode, workspace_path, created_at, updated_at
            ) VALUES (
              ${bot}, ${bot}, '', 'dome', 'cobalt', '', 'claude', 'haiku', 'auto',
              ${`/bots/${bot}`}, ${now}, ${now}
            )
          `;
        }
        // Scout read through its card, the last entry; Ranger's card was the only one; Keeper
        // has read up to a message after its card.
        yield* sql`
          INSERT INTO conversations (bot_id, read_through_order, digest_from_position, created_at)
          VALUES ('scout', 1, 2, ${now}), ('ranger', 0, 1, ${now}), ('keeper', 2, 3, ${now})
        `;
        yield* entry("s-0", "scout", 0, "message");
        yield* entry("s-1", "scout", 1, "connector-suggestion");
        yield* entry("r-0", "ranger", 0, "connector-suggestion");
        yield* entry("k-0", "keeper", 0, "message");
        yield* entry("k-1", "keeper", 1, "connector-suggestion");
        yield* entry("k-2", "keeper", 2, "message");
      }).pipe(Effect.provide(SqliteClient.layer({ filename: config.databasePath })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT id FROM entries ORDER BY id`, [
          { id: "k-0" },
          { id: "k-2" },
          { id: "s-0" },
        ]);
        assert.deepStrictEqual(
          yield* sql`
            SELECT bot_id, read_through_order, digest_from_position FROM conversations
            ORDER BY bot_id
          `,
          [
            { bot_id: "keeper", read_through_order: 2, digest_from_position: 3 },
            { bot_id: "ranger", read_through_order: null, digest_from_position: 0 },
            { bot_id: "scout", read_through_order: 0, digest_from_position: 1 },
          ],
        );
      }).pipe(
        Effect.provide(Sqlite.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
