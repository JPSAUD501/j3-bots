// SPDX-License-Identifier: AGPL-3.0-or-later
import { type RateLimited, RoutineRun } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readBody } from "../body.ts";
import { RoutineRuns } from "./RoutineRuns.ts";

/** Where a routine's webhook is called: `<WEBHOOK_PATH>/<routine id>/<secret>`. */
export const WEBHOOK_PATH = "/hooks";

/**
 * `path` with each run of percent-escapes decoded on its own, so a malformed
 * escape elsewhere in the path, such as in a `;` parameter the router leaves
 * out, changes nothing before it. Of a run that is not UTF-8, the escapes of
 * ASCII characters are still decoded.
 */
const decodeEscapes = (path: string): string =>
  path.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
    Result.getOrElse(
      Result.try(() => decodeURIComponent(run)),
      () => run.replace(/%[0-7][0-9a-f]/gi, decodeURIComponent),
    ),
  );

/**
 * What the request log shows of a path that may hold a webhook's secret, or
 * `None` for one that holds none. Under `WEBHOOK_PATH` everything after it is
 * left out: the routine's id and the secret, and a secret in any other
 * place, whatever the path's shape. Every path the router could take for a webhook's is
 * covered, whatever it answers: one written with percent-escapes, doubled
 * slashes or other letter case too. Only the prefix decides, so whatever
 * follows it, however malformed, never lets a path through unredacted.
 */
export const redactPath = (path: string): Option.Option<string> => {
  const prefix = `${WEBHOOK_PATH}/`;
  const under = decodeEscapes(path)
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
    .startsWith(prefix);
  return under ? Option.some(`${prefix}…`) : Option.none();
};

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
  status: RoutineRun.fields.status,
});

const decoder = new TextDecoder("utf-8", { fatal: true });

const empty = (status: number) => HttpServerResponse.empty({ status });

/** `Retry-After` for a call refused until `retryAt`: whole seconds, at least one. */
const retryAfter = (limited: RateLimited) =>
  Effect.map(DateTime.now, (now) =>
    String(Math.max(1, Math.ceil(Duration.toSeconds(DateTime.distance(now, limited.retryAt))))),
  );

/**
 * A refusal answered before the body is read. The connection is closed with
 * it, so Node does not go on to read the rest of the body to keep it open:
 * what the caller already sent is discarded as it closes.
 */
const refusedUnread = HttpServerResponse.empty({ status: 404, headers: { connection: "close" } });

/**
 * A routine's webhook (`docs/architecture/server.md`, Routines): `POST` with
 * any body of UTF-8 text, which reaches the bot as data. The secret in the
 * path is the credential, checked before the body or a header it acts on
 * is read. Answers 202 with the run it recorded, `running` or `skipped`; 200
 * with the earlier run for a repeated `Idempotency-Key`; 404 for an address
 * that names no webhook, a wrong secret included; 409 while the routine is
 * paused; 413 past `WEBHOOK_BODY_LIMIT`; 400 for a body that is not UTF-8 or
 * a key that is blank or too long; 429 with `Retry-After` past the routine's
 * runs per minute.
 */
export const route = HttpRouter.add(
  "POST",
  `${WEBHOOK_PATH}/:routineId/:secret`,
  Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(Params).pipe(Effect.option);
    if (Option.isNone(params)) return refusedUnread;
    const runs = yield* RoutineRuns;
    const admitted = yield* runs.admitWebhook(params.value).pipe(Effect.result);
    if (admitted._tag === "Failure") return refusedUnread;
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
          Effect.map(retryAfter(limited), (seconds) =>
            HttpServerResponse.empty({ status: 429, headers: { "retry-after": seconds } }),
          ),
      }),
    );
  }).pipe(
    Effect.orDie,
    // The request log leaves out what went wrong with a request under
    // `WEBHOOK_PATH`, since it can carry the request. Nothing here does: the
    // secret is compared in memory, never bound into a query.
    Effect.catchDefect((defect) =>
      Effect.logError("A webhook call failed", Cause.die(defect)).pipe(Effect.as(empty(500))),
    ),
  ),
);
