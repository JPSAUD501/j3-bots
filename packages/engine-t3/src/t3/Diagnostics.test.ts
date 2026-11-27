// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { engineLogNewestFirst, engineSecretValues } from "./Diagnostics.ts";

const NOW = DateTime.makeUnsafe("2026-11-27T12:00:00Z");
/** A warning long enough to be cut, with a made-up key across where it is cut. */
const LONG_WARNING = `Provider slow to answer ${"x".repeat(270)} key KEY-0123456789`;
/** What the zip's scrubber does, for this test: takes the key out. */
const clean = (text: string) => text.replaceAll("KEY-0123456789", "[secret]");
const nanos = (iso: string) =>
  (BigInt(DateTime.makeUnsafe(iso).epochMilliseconds) * 1_000_000n).toString();

/** A span as T3 Code's trace file writes one, made up for the test. */
const span = (input: {
  readonly name: string;
  readonly at: string;
  readonly exit?: { readonly _tag: "Success" | "Failure" | "Interrupted"; readonly cause?: string };
  readonly events?: ReadonlyArray<{ readonly name: string; readonly level: string }>;
}) =>
  JSON.stringify({
    type: "effect-span",
    name: input.name,
    kind: "internal",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    sampled: true,
    startTimeUnixNano: nanos(input.at),
    endTimeUnixNano: nanos(input.at),
    durationMs: 12.34,
    attributes: { "thread.title": "Plan the trip to Lisbon" },
    events: (input.events ?? []).map((event) => ({
      name: event.name,
      timeUnixNano: nanos(input.at),
      attributes: { "effect.logLevel": event.level },
    })),
    links: [],
    exit: input.exit ?? { _tag: "Success" },
  });

it.layer(NodeServices.layer)("what of the engine a diagnostics zip holds", (it) => {
  it.effect("keeps what went wrong, newest first, and none of the operator's words", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j3-engine-diag-" });
      const logs = path.join(home, "userdata", "logs");
      yield* fs.makeDirectory(logs, { recursive: true });
      yield* fs.writeFileString(
        path.join(logs, "server.trace.ndjson.1"),
        [
          span({
            name: "provider.start",
            at: "2026-11-19T10:00:00Z",
            exit: { _tag: "Failure", cause: "Old: gone" },
          }),
          span({
            name: "provider.start",
            at: "2026-11-25T10:00:00Z",
            exit: {
              _tag: "Failure",
              cause: "ProviderStartError: Claude said 'book a flight to Lisbon'\n    at x",
            },
          }),
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(logs, "server.trace.ndjson"),
        [
          span({ name: "orchestrator.dispatch", at: "2026-11-26T09:00:00Z" }),
          "not a span at all",
          `{"type":"effect-span","name":"half"}`,
          span({
            name: "orchestrator.dispatch",
            at: "2026-11-26T10:00:00Z",
            events: [
              { name: "Turn started", level: "Info" },
              { name: LONG_WARNING, level: "Warning" },
            ],
          }),
          span({
            name: "thread.stop",
            at: "2026-11-27T11:00:00Z",
            exit: { _tag: "Interrupted", cause: "All fibers interrupted" },
          }),
          "",
        ].join("\n"),
      );

      // Written when their newest span ended, as the engine writes them.
      for (const [file, at] of [
        ["server.trace.ndjson.1", "2026-11-25T10:00:00Z"],
        ["server.trace.ndjson", "2026-11-27T11:00:00Z"],
      ] as const) {
        const time = DateTime.toDateUtc(DateTime.makeUnsafe(at));
        yield* fs.utimes(path.join(logs, file), time, time);
      }
      const lines = yield* Stream.runCollect(
        engineLogNewestFirst(home, DateTime.subtract(NOW, { days: 7 }), clean),
      );
      assert.deepStrictEqual(
        lines.map((line) => JSON.parse(line)),
        [
          {
            at: "2026-11-27T11:00:00.000Z",
            span: "thread.stop",
            ms: 12.3,
            outcome: "interrupted",
            logs: [],
          },
          {
            at: "2026-11-26T10:00:00.000Z",
            span: "orchestrator.dispatch",
            ms: 12.3,
            outcome: "success",
            // Cleaned whole, then cut: no part of the key is left.
            logs: [{ level: "Warning", message: `${clean(LONG_WARNING).slice(0, 300)}…` }],
          },
          {
            at: "2026-11-25T10:00:00.000Z",
            span: "provider.start",
            ms: 12.3,
            outcome: "failure",
            error: "ProviderStartError",
            logs: [],
          },
        ],
      );
      assert.notInclude(lines.join("\n"), "Lisbon");
      assert.notInclude(lines.join("\n"), "KEY-0");
    }),
  );

  it.effect("finds the credential's token and every value of the engine's secret store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j3-engine-diag-" });
      yield* fs.makeDirectory(path.join(home, "j3"), { recursive: true });
      yield* fs.makeDirectory(path.join(home, "userdata", "secrets"), { recursive: true });
      yield* fs.writeFileString(
        path.join(home, "j3", "credential.json"),
        JSON.stringify({
          token: "engine-token-value",
          expiresAt: "2026-12-01T00:00:00Z",
          scopes: ["orchestration:read"],
        }),
      );
      const connection = JSON.stringify({
        baseUrl: "https://ai.example.test",
        key: "provider-key-value",
      });
      yield* fs.writeFileString(
        path.join(home, "userdata", "secrets", "j3-provider-connection.json"),
        connection,
      );
      yield* fs.writeFileString(
        path.join(home, "userdata", "secrets", "OPENAI_API_KEY"),
        "plain-value\n",
      );

      // The token alone of the credential: its scopes are words a log uses.
      const values = (yield* engineSecretValues(home)).map(Redacted.value);
      assert.deepStrictEqual(
        values.toSorted(),
        [connection, "engine-token-value", "plain-value"].toSorted(),
      );
    }),
  );
});
