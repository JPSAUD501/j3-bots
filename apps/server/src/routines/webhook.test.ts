// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { RoutineId, RoutineTrigger } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Http from "../http.ts";
import * as Listener from "../listener.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, createNewBot } from "../testing/turns.ts";
import * as WebClient from "../web/WebClient.ts";
import { WEBHOOK_RUNS_PER_MINUTE } from "./RoutineRuns.ts";
import { Routines } from "./Routines.ts";
import { WEBHOOK_BODY_LIMIT } from "./webhook.ts";

const Answer = Schema.Struct({ run: Schema.String, status: Schema.String });

/**
 * A routine of a new bot. What a webhook records needs no turn of the bot's,
 * so its opening waits: the routine turns earlier tests left running may hold
 * every slot.
 */
const routineWith = (trigger: RoutineTrigger) =>
  Effect.gen(function* () {
    const bot = yield* createNewBot("Ana");
    return yield* (yield* Routines).create({
      commandId: command(),
      botId: bot.id,
      draft: { name: "Deploys", instruction: "Tell me when a deploy fails.", trigger },
      author: { _tag: "operator" },
    });
  });

/**
 * A webhook routine, with the address it gives (`url`), the server's origin
 * there, and the routine's id and secret from its path.
 */
const webhookRoutine = Effect.gen(function* () {
  const routine = yield* routineWith({ _tag: "webhook" });
  if (routine.webhookUrl === null) return yield* Effect.die("A webhook routine has an address");
  const { origin, pathname } = new URL(routine.webhookUrl);
  const [, , routineId = "", secret = ""] = pathname.split("/");
  return { routine, url: routine.webhookUrl, origin, routineId, secret };
});

const call = (
  url: string,
  body: string | Uint8Array,
  headers: Readonly<Record<string, string>> = {},
) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      typeof body === "string"
        ? HttpClientRequest.bodyText(body)
        : HttpClientRequest.bodyUint8Array(body),
    ),
  );

const answer = (url: string, body: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const response = yield* call(url, body, headers);
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

// The client listener as the server runs it, on a port the system chooses.
it.layer(
  Http.serve(Listener.layer, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(WebClient.statusLayer),
    Layer.provideMerge(TestDomain.servedLayer),
    Layer.merge(FetchHttpClient.layer),
  ),
)("routine webhooks", (it) => {
  it.effect("runs the routine with the request's body as the run's data", () =>
    Effect.gen(function* () {
      // At the address the routine gives, the port chosen included.
      const { routine, url } = yield* webhookRoutine;
      const first = yield* answer(url, '{"deploy":"failed"}');
      assert.deepStrictEqual([first.code, first.runStatus], [202, "running"]);
      assert.deepStrictEqual(yield* runsOf(routine.id), [
        { status: "running", trigger_data: '{"deploy":"failed"}' },
      ]);

      // A call while that run is going is recorded as skipped.
      const second = yield* answer(url, '{"deploy":"failed again"}');
      assert.deepStrictEqual([second.code, second.runStatus], [202, "skipped"]);
      assert.notStrictEqual(second.run, first.run);
      assert.strictEqual((yield* runsOf(routine.id))[1]?.status, "skipped");
    }),
  );

  it.effect(
    "answers alike for a wrong secret, an unknown routine and a routine with no webhook",
    () =>
      Effect.gen(function* () {
        const { routine, origin, routineId, secret } = yield* webhookRoutine;
        const wrong = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
        const scheduled = yield* routineWith({
          _tag: "schedule",
          cron: "0 9 * * *",
          timeZone: "UTC",
        });

        for (const other of [
          `/hooks/${routineId}/${wrong}`,
          `/hooks/routine_nothere/${secret}`,
          `/hooks/${scheduled.id}/${secret}`,
          `/hooks/${routineId}`,
        ]) {
          assert.strictEqual((yield* call(`${origin}${other}`, "{}")).status, 404, other);
        }
        assert.deepStrictEqual(yield* runsOf(routine.id), []);
        assert.deepStrictEqual(yield* runsOf(scheduled.id), []);
      }),
  );

  it.effect("records a request repeated with its Idempotency-Key once", () =>
    Effect.gen(function* () {
      const { routine, url } = yield* webhookRoutine;
      const key = { "idempotency-key": "delivery-1" };
      const first = yield* answer(url, "deploy 1", key);
      const again = yield* answer(url, "deploy 1", key);
      assert.strictEqual(first.code, 202);
      assert.strictEqual(again.code, 200);
      assert.strictEqual(again.run, first.run);
      assert.strictEqual((yield* runsOf(routine.id)).length, 1);

      // Another delivery is another call.
      const other = yield* answer(url, "deploy 2", { "idempotency-key": "delivery-2" });
      assert.strictEqual(other.code, 202);
      assert.strictEqual((yield* runsOf(routine.id)).length, 2);
    }),
  );

  it.effect("refuses a paused routine, a body past the limit and a body that is not text", () =>
    Effect.gen(function* () {
      const { routine, url } = yield* webhookRoutine;
      assert.strictEqual((yield* call(url, "x".repeat(WEBHOOK_BODY_LIMIT + 1))).status, 413);
      assert.strictEqual((yield* call(url, new Uint8Array([0xff, 0xfe, 0x00]))).status, 400);
      assert.strictEqual((yield* call(url, "{}", { "idempotency-key": " " })).status, 400);

      yield* (yield* Routines).update({
        commandId: command(),
        routineId: routine.id,
        changes: { enabled: false },
        author: { _tag: "operator" },
      });
      assert.strictEqual((yield* call(url, "{}")).status, 409);
      assert.deepStrictEqual(yield* runsOf(routine.id), []);
    }),
  );

  it.effect("limits how many runs a routine's webhook records in a minute", () =>
    Effect.gen(function* () {
      const { routine, url } = yield* webhookRoutine;
      assert.strictEqual((yield* call(url, "event 0")).status, 202);
      yield* TestClock.adjust("10 seconds");
      for (let n = 1; n < WEBHOOK_RUNS_PER_MINUTE; n++) {
        assert.strictEqual((yield* call(url, `event ${n}`)).status, 202);
      }
      assert.strictEqual((yield* call(url, "one too many")).status, 429);

      // A run asked for in the app is not limited, and takes the count past
      // the limit: when the first run leaves the minute, ten remain.
      yield* (yield* Routines).run({ commandId: command(), routineId: routine.id });
      const limited = yield* call(url, "still too many");
      assert.strictEqual(limited.status, 429);
      assert.strictEqual(limited.headers["retry-after"], "60");
      assert.strictEqual((yield* runsOf(routine.id)).length, WEBHOOK_RUNS_PER_MINUTE + 1);
    }),
  );

  it.effect("answers 500 to a call that fails, and logs why, without the secret", () =>
    Effect.gen(function* () {
      const { routine, url, secret } = yield* webhookRoutine;
      const sql = yield* SqlClient.SqlClient;
      // A trigger the server cannot read: recording the call's run fails.
      yield* sql`UPDATE routines SET trigger_json = '{"_tag":"unknown"}' WHERE id = ${routine.id}`;
      assert.strictEqual((yield* call(url, "{}")).status, 500);
      assert.isTrue(logged.some((line) => line.includes("A webhook call failed")));
      assert.isFalse(logged.some((line) => line.includes(secret)));
    }),
  );

  it.effect("leaves a webhook's secret out of the request log, also where no webhook answers", () =>
    Effect.gen(function* () {
      const { url, origin, routineId, secret } = yield* webhookRoutine;
      assert.strictEqual((yield* call(url, "{}")).status, 202);
      // Paths the router may or may not take for the webhook's, and the
      // address webhooks had before it named the routine.
      for (const other of [
        `/hooks/${routineId}/${secret}/more`,
        `/HOOKS/${routineId}/${secret}`,
        `/%68ooks/${routineId}/${secret}`,
        // The router leaves out what follows `;`, where an escape is malformed.
        `/%68ooks/${routineId}/${secret};%zz`,
        `//hooks/${routineId}/${secret}`,
        `/hooks/${secret}`,
      ]) {
        yield* call(`${origin}${other}`, "{}");
      }
      const requests = logged.filter((line) => line.includes("Sent HTTP response"));
      assert.isTrue(
        requests.some((line) => line.includes("/hooks/…") && line.includes('"http.status":202')),
      );
      assert.isFalse(logged.some((line) => line.includes(secret)));
    }),
  );
});
