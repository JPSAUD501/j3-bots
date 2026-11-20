// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import type { RoutineId, RoutineTrigger } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Http from "../http.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, createBot } from "../testing/turns.ts";
import * as WebClient from "../web/WebClient.ts";
import { WEBHOOK_RUNS_PER_MINUTE } from "./RoutineRuns.ts";
import { Routines } from "./Routines.ts";
import { WEBHOOK_BODY_LIMIT } from "./webhook.ts";

const Answer = Schema.Struct({ run: Schema.String, status: Schema.String });

/** A routine of a new bot, and the path of its webhook when it has one. */
const routineWith = (trigger: RoutineTrigger) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const routine = yield* (yield* Routines).create({
      commandId: command(),
      botId: bot.id,
      draft: { name: "Deploys", instruction: "Tell me when a deploy fails.", trigger },
      author: { _tag: "operator" },
    });
    const path = routine.webhookUrl === null ? null : new URL(routine.webhookUrl).pathname;
    return { routine, path };
  });

const webhookRoutine = Effect.gen(function* () {
  const { routine, path } = yield* routineWith({ _tag: "webhook" });
  if (path === null) return yield* Effect.die("A webhook routine has an address");
  return { routine, path };
});

const call = (
  path: string,
  body: string | Uint8Array,
  headers: Readonly<Record<string, string>> = {},
) =>
  HttpClient.execute(
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.setHeaders(headers),
      typeof body === "string"
        ? HttpClientRequest.bodyText(body)
        : HttpClientRequest.bodyUint8Array(body),
    ),
  );

const answer = (path: string, body: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const response = yield* call(path, body, headers);
    const json = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Answer)));
    return { code: response.status, run: json.run, runStatus: json.status };
  });

const runsOf = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly status: string; readonly trigger_data: string | null }>`
      SELECT status, trigger_data FROM routine_runs WHERE routine_id = ${routineId} ORDER BY rowid
    `;
  });

/** Every line the server logs while these tests run, as JSON. */
const logged: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.map(Logger.formatJson, (line) => {
    logged.push(line);
  }),
]);

it.layer(
  Http.serve(NodeHttpServer.layerTest, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(WebClient.statusLayer),
    Layer.provideMerge(TestDomain.layer),
  ),
)("routine webhooks", (it) => {
  it.effect("runs the routine with the request's body as the run's data", () =>
    Effect.gen(function* () {
      const { routine, path } = yield* webhookRoutine;
      const first = yield* answer(path, '{"deploy":"failed"}');
      assert.deepStrictEqual([first.code, first.runStatus], [202, "running"]);
      assert.deepStrictEqual(yield* runsOf(routine.id), [
        { status: "running", trigger_data: '{"deploy":"failed"}' },
      ]);

      // A call while that run is going is recorded as skipped.
      const second = yield* answer(path, '{"deploy":"failed again"}');
      assert.deepStrictEqual([second.code, second.runStatus], [202, "skipped"]);
      assert.notStrictEqual(second.run, first.run);
      assert.strictEqual((yield* runsOf(routine.id))[1]?.status, "skipped");
    }),
  );

  it.effect(
    "answers alike for a wrong secret, an unknown routine and a routine with no webhook",
    () =>
      Effect.gen(function* () {
        const { routine, path } = yield* webhookRoutine;
        const [, , routineId = "", secret = ""] = path.split("/");
        const wrong = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
        const scheduled = yield* routineWith({
          _tag: "schedule",
          cron: "0 9 * * *",
          timeZone: "UTC",
        });

        for (const other of [
          `/hooks/${routineId}/${wrong}`,
          `/hooks/routine_nothere/${secret}`,
          `/hooks/${scheduled.routine.id}/${secret}`,
          `/hooks/${routineId}`,
        ]) {
          assert.strictEqual((yield* call(other, "{}")).status, 404, other);
        }
        assert.deepStrictEqual(yield* runsOf(routine.id), []);
        assert.deepStrictEqual(yield* runsOf(scheduled.routine.id), []);
      }),
  );

  it.effect("records a request repeated with its Idempotency-Key once", () =>
    Effect.gen(function* () {
      const { routine, path } = yield* webhookRoutine;
      const key = { "idempotency-key": "delivery-1" };
      const first = yield* answer(path, "deploy 1", key);
      const again = yield* answer(path, "deploy 1", key);
      assert.strictEqual(first.code, 202);
      assert.strictEqual(again.code, 200);
      assert.strictEqual(again.run, first.run);
      assert.strictEqual((yield* runsOf(routine.id)).length, 1);

      // Another delivery is another call.
      const other = yield* answer(path, "deploy 2", { "idempotency-key": "delivery-2" });
      assert.strictEqual(other.code, 202);
      assert.strictEqual((yield* runsOf(routine.id)).length, 2);
    }),
  );

  it.effect("refuses a paused routine, a body past the limit and a body that is not text", () =>
    Effect.gen(function* () {
      const { routine, path } = yield* webhookRoutine;
      assert.strictEqual((yield* call(path, "x".repeat(WEBHOOK_BODY_LIMIT + 1))).status, 413);
      assert.strictEqual((yield* call(path, new Uint8Array([0xff, 0xfe, 0x00]))).status, 400);
      assert.strictEqual((yield* call(path, "{}", { "idempotency-key": " " })).status, 400);

      yield* (yield* Routines).update({
        commandId: command(),
        routineId: routine.id,
        changes: { enabled: false },
        author: { _tag: "operator" },
      });
      assert.strictEqual((yield* call(path, "{}")).status, 409);
      assert.deepStrictEqual(yield* runsOf(routine.id), []);
    }),
  );

  it.effect("limits how many runs a routine's webhook records in a minute", () =>
    Effect.gen(function* () {
      const { routine, path } = yield* webhookRoutine;
      for (let n = 0; n < WEBHOOK_RUNS_PER_MINUTE; n++) {
        assert.strictEqual((yield* call(path, `event ${n}`)).status, 202);
      }
      const limited = yield* call(path, "one too many");
      assert.strictEqual(limited.status, 429);
      assert.isAbove(Number(limited.headers["retry-after"]), 0);
      assert.strictEqual((yield* runsOf(routine.id)).length, WEBHOOK_RUNS_PER_MINUTE);
    }),
  );

  it.effect("leaves a webhook's secret out of the request log, also where no webhook answers", () =>
    Effect.gen(function* () {
      const { routine, path } = yield* webhookRoutine;
      const [, , routineId = "", secret = ""] = path.split("/");
      assert.strictEqual((yield* call(path, "{}")).status, 202);
      // Paths the router may or may not take for the webhook's.
      for (const other of [
        `${path}/more`,
        `/HOOKS/${routineId}/${secret}`,
        `/%68ooks/${routineId}/${secret}`,
        `//hooks/${routineId}/${secret}`,
      ]) {
        yield* call(other, "{}");
      }
      const requests = logged.filter((line) => line.includes("Sent HTTP response"));
      assert.isTrue(
        requests.some(
          (line) => line.includes(`/hooks/${routine.id}/…`) && line.includes('"http.status":202'),
        ),
      );
      assert.isFalse(logged.some((line) => line.includes(secret)));
    }),
  );
});
