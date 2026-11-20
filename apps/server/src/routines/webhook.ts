// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readBody } from "../body.ts";
import { RoutineRuns } from "./RoutineRuns.ts";

/** Where a routine's webhook is called: `<WEBHOOK_PATH>/<routine id>/<secret>`. */
export const WEBHOOK_PATH = "/hooks";

/**
 * The most a webhook request's body may hold. It reaches the bot inside the
 * run's envelope, beside an instruction of up to 10,000 characters and the
 * routine's recent runs, all within the engine's input limit of 120,000.
 */
export const WEBHOOK_BODY_LIMIT = 64 * 1024;

/** The longest `Idempotency-Key` taken: the header's usual values are UUIDs and delivery ids. */
const REQUEST_KEY_LIMIT = 200;

const Params = Schema.Struct({ routineId: Schema.String, secret: Schema.String });

const RunAnswer = Schema.Struct({
  run: Schema.String,
  status: Schema.Literals(["running", "delivered", "silent", "failed", "skipped"]),
});

const decoder = new TextDecoder("utf-8", { fatal: true });

const empty = (status: number) => HttpServerResponse.empty({ status });

/**
 * A routine's webhook (`docs/architecture/server.md`, Routines): `POST` with
 * any body of UTF-8 text, which reaches the bot as data. The secret in the
 * path is the credential. Answers 202 with the run it recorded, `running` or
 * `skipped`; 200 with the earlier run for a repeated `Idempotency-Key`; 404
 * for an address that names no webhook, a wrong secret included; 409 while
 * the routine is paused; 413 past `WEBHOOK_BODY_LIMIT`; 400 for a body that is
 * not UTF-8 or a key that is blank or too long; 429 with `Retry-After` past
 * the routine's runs per minute.
 */
export const route = HttpRouter.add(
  "POST",
  `${WEBHOOK_PATH}/:routineId/:secret`,
  Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(Params).pipe(Effect.option);
    if (Option.isNone(params)) return empty(404);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const key = request.headers["idempotency-key"];
    if (key !== undefined && (key.trim() === "" || key.length > REQUEST_KEY_LIMIT)) {
      return empty(400);
    }
    const bytes = yield* readBody(request, WEBHOOK_BODY_LIMIT).pipe(Effect.result);
    if (bytes._tag === "Failure") {
      return empty(bytes.failure._tag === "BodyTooLarge" ? 413 : 400);
    }
    const body = yield* Effect.option(
      Effect.try({ try: () => decoder.decode(bytes.success), catch: () => "not UTF-8" }),
    );
    if (Option.isNone(body)) return empty(400);
    const runs = yield* RoutineRuns;
    return yield* runs.webhook({ ...params.value, body: body.value, requestKey: key ?? null }).pipe(
      Effect.flatMap((receipt) =>
        HttpServerResponse.schemaJson(RunAnswer)(
          { run: receipt.runId, status: receipt.status },
          { status: receipt.replayed ? 200 : 202 },
        ),
      ),
      Effect.catchTags({
        WebhookRefused: (refused) => Effect.succeed(empty(refused.reason === "paused" ? 409 : 404)),
        RateLimited: (limited) =>
          Effect.map(DateTime.now, (now) =>
            HttpServerResponse.empty({
              status: 429,
              headers: {
                "retry-after": String(
                  Math.max(
                    1,
                    Math.ceil(Duration.toSeconds(DateTime.distance(now, limited.retryAt))),
                  ),
                ),
              },
            }),
          ),
      }),
      Effect.orDie,
    );
  }),
);
