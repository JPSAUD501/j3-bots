// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { unzipSync } from "fflate";
import { ServerConfig } from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import * as TestDatabase from "../testing/database.ts";
import { DIAGNOSTICS_FILES, type DiagnosticsSources, diagnosticsZip } from "./build.ts";

const NOW = DateTime.makeUnsafe("2026-11-27T12:00:00.000Z");

// Every value here is made up for the test.
const BOT_NAME = "Marina Travel Planner";
const WEBHOOK_SECRET = "whsec-made-up-for-the-test-31415";
const MEMORY_SECRET = "in-memory-made-up-key";

const sources: DiagnosticsSources = {
  at: NOW,
  client: Option.some({ surface: "web", version: null, os: "linux" }),
  version: "0.14.0",
  startedAt: Option.some(DateTime.makeUnsafe("2026-11-27T11:00:00.000Z")),
  install: "service",
  engine: Option.none(),
  secrets: [Redacted.make(MEMORY_SECRET)],
};

/** A line of the server's log as `Logger.formatJson` writes one. */
const logLine = (at: string, message: string, level = "INFO") =>
  JSON.stringify({
    message,
    level,
    timestamp: at,
    annotations: {},
    spans: {},
    fiberId: "#1",
  });

/** The zip `diagnosticsZip` makes, unzipped: each file's name and text. */
const unzipped = (overrides: Partial<DiagnosticsSources> = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const zip = yield* diagnosticsZip(config, { ...sources, ...overrides });
    const chunks = yield* Stream.runCollect(zip);
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const files = unzipSync(bytes);
    return {
      size: bytes.length,
      names: Object.keys(files),
      text: (name: string) => new TextDecoder().decode(files[name]),
    };
  });

const writeServerLog = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home } = yield* ServerConfig;
    const folder = path.join(home, HOME_ENTRIES.logs);
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(path.join(folder, "server.log"), `${lines.join("\n")}\n`);
  });

const messageOf = (line: string) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ message: Schema.String })))(line).message;

const Manifest = Schema.Struct({
  madeAt: Schema.String,
  j3Bots: Schema.String,
  protocol: Schema.Number,
  requestedFrom: Schema.Struct({ surface: Schema.String }),
  install: Schema.String,
  uptimeSeconds: Schema.Number,
  timeZone: Schema.String,
  logs: Schema.Struct({
    since: Schema.String,
    server: Schema.Struct({ lines: Schema.Number, cut: Schema.Boolean }),
    engine: Schema.Struct({ lines: Schema.Number, cut: Schema.Boolean }),
  }),
});
const decodeManifest = Schema.decodeSync(Schema.fromJsonString(Manifest));

const Failures = Schema.Array(
  Schema.Struct({
    notice: Schema.String,
    failure: Schema.optionalKey(Schema.String),
    conversation: Schema.optionalKey(Schema.String),
  }),
);
const decodeFailures = Schema.decodeSync(Schema.fromJsonString(Failures));

const Counts = Schema.Struct({
  bots: Schema.Number,
  routines: Schema.Struct({ all: Schema.Number, enabled: Schema.Number }),
});
const decodeCounts = Schema.decodeSync(Schema.fromJsonString(Counts));

it.layer(TestDatabase.layer)("a diagnostics zip", (it) => {
  it.effect("holds the files its README names, and nothing of the person", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-26T10:00:00.000Z";
      yield* sql`
        INSERT INTO bots (
          id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
          permission_mode, workspace_path, created_at, updated_at
        ) VALUES (
          'bot_00000000000000000001', ${BOT_NAME}, 'Plans trips', 'dome', 'cobalt',
          'Plan the trip', 'claude-code', 'claude-opus', 'auto', '/made/up/workspace', ${at}, ${at}
        )
      `;
      yield* sql`
        INSERT INTO conversations (bot_id, created_at)
        VALUES ('bot_00000000000000000001', ${at})
      `;
      yield* sql`
        INSERT INTO routines (
          id, bot_id, name, instruction, trigger_json, webhook_secret, created_at, updated_at
        ) VALUES (
          'routine_00000000000000000001', 'bot_00000000000000000001', 'Morning brief',
          'Tell me about flights', '{"_tag":"webhook"}', ${WEBHOOK_SECRET}, ${at}, ${at}
        )
      `;
      const entry = (id: string, position: number, kind: string, body: unknown) => sql`
        INSERT INTO entries (
          id, conversation_bot_id, position, kind, author_kind, body_json, created_at, updated_at
        ) VALUES (
          ${id}, 'bot_00000000000000000001', ${position}, ${kind}, 'system',
          ${JSON.stringify(body)}, ${at}, ${at}
        )
      `;
      yield* entry("entry_00000000000000000001", 0, "message", {
        text: "Book the flight to Lisbon",
      });
      yield* entry("entry_00000000000000000002", 1, "notice", {
        notice: { _tag: "turn-failed", failure: "usage-limit", details: "Lisbon quota" },
      });
      yield* entry("entry_00000000000000000003", 2, "notice", {
        notice: { _tag: "operator-named", botId: "bot_00000000000000000001", name: "Marina" },
      });
      yield* writeServerLog([
        logLine("2026-11-10T09:00:00.000Z", "Too old to keep"),
        logLine("2026-11-26T09:00:00.000Z", `Signed a webhook with ${WEBHOOK_SECRET}`),
        "Book the flight to Lisbon",
        logLine("2026-11-27T09:00:00.000Z", `Bridge key ${MEMORY_SECRET}`, "WARN"),
      ]);

      const zip = yield* unzipped();
      assert.deepStrictEqual(zip.names, [...DIAGNOSTICS_FILES]);
      const everything = zip.names.map(zip.text).join("\n");
      for (const kept of [BOT_NAME, "Marina", "Lisbon", WEBHOOK_SECRET, MEMORY_SECRET]) {
        assert.notInclude(everything, kept);
      }

      const manifest = decodeManifest(zip.text("manifest.json"));
      assert.deepStrictEqual(
        {
          madeAt: manifest.madeAt,
          j3Bots: manifest.j3Bots,
          surface: manifest.requestedFrom.surface,
          install: manifest.install,
          uptimeSeconds: manifest.uptimeSeconds,
          timeZone: manifest.timeZone,
          server: manifest.logs.server,
        },
        {
          madeAt: "2026-11-27T12:00:00.000Z",
          j3Bots: "0.14.0",
          surface: "web",
          install: "service",
          uptimeSeconds: 3600,
          timeZone: "UTC",
          server: { lines: 2, cut: false },
        },
      );

      // The days' lines, oldest first, each secret replaced.
      const serverLog = zip.text("server-log.jsonl").trimEnd().split("\n");
      assert.deepStrictEqual(
        serverLog.map((line) => messageOf(line)),
        ["Signed a webhook with [secret]", "Bridge key [secret]"],
      );
      assert.deepStrictEqual(decodeFailures(zip.text("failures.json")), [
        { notice: "turn-failed", failure: "usage-limit", conversation: "bot_00000000000000000001" },
      ]);
      assert.deepStrictEqual(decodeCounts(zip.text("counts.json")), {
        bots: 1,
        routines: { all: 1, enabled: 1 },
      });
    }),
  );

  it.effect("keeps the newest lines that fit a log's budget", () =>
    Effect.gen(function* () {
      const line = (n: number) =>
        logLine(`2026-11-27T10:${String(n).padStart(2, "0")}:00.000Z`, `line ${n}`);
      yield* writeServerLog(Array.from({ length: 50 }, (_, n) => line(n)));
      // Each line as the zip holds it, without the fiber `formatJson` names.
      const budget = 10 * (line(49).length - `,"fiberId":"#1"`.length + 1);

      const zip = yield* unzipped({ budgets: { server: budget, engine: 1024 } });
      const text = zip.text("server-log.jsonl");
      assert.isAtMost(new TextEncoder().encode(text).length, budget);
      assert.deepStrictEqual(
        text
          .trimEnd()
          .split("\n")
          .map((each) => messageOf(each)),
        Array.from({ length: 10 }, (_, index) => `line ${40 + index}`),
      );
      assert.deepStrictEqual(decodeManifest(zip.text("manifest.json")).logs.server, {
        lines: 10,
        cut: true,
      });
    }),
  );
});
