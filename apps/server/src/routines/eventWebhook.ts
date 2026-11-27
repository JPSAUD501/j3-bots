// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_WEBHOOK_BODY_BYTES } from "@j3-bots/connectors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readBody } from "../body.ts";
import { EVENT_HOOK_PATH, RoutineEvents } from "./RoutineEvents.ts";

const Params = Schema.Struct({ token: Schema.String });

/** The echo of a verification's challenge, as Standard Webhooks' receivers answer it. */
const Challenge = Schema.Struct({ challenge: Schema.String });

const empty = (status: number) => HttpServerResponse.empty({ status });

/**
 * Where a connector's server posts an event routine's events, when J3 Bots
 * subscribed by webhook (MCP's Events extension, Standard Webhooks). The
 * token in the path names the listener; the signature, with the secret J3
 * Bots gave the server, is the credential, checked before the body is read
 * for anything. Answers 200 with the challenge echoed to the server's
 * verification, 204 to a delivery taken, 401 to one whose signature does not
 * hold or that is more than five minutes off, 400 to a body that is not the
 * extension's, 413 past its 256 KiB, and 410 at an address no routine
 * listens at, which refuses the delivery for good.
 */
export const route = HttpRouter.add(
  "POST",
  `${EVENT_HOOK_PATH}/:token`,
  Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(Params).pipe(Effect.option);
    if (Option.isNone(params)) return empty(410);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const bytes = yield* readBody(request, MAX_WEBHOOK_BODY_BYTES).pipe(Effect.result);
    if (bytes._tag === "Failure") {
      return empty(bytes.failure._tag === "BodyTooLarge" ? 413 : 400);
    }
    const header = (name: string) => request.headers[name] ?? null;
    const answer = yield* (yield* RoutineEvents).delivered({
      token: params.value.token,
      id: header("webhook-id"),
      timestamp: header("webhook-timestamp"),
      signature: header("webhook-signature"),
      body: bytes.success,
    });
    switch (answer._tag) {
      case "gone":
        return empty(410);
      case "refused":
        return empty(401);
      case "unreadable":
        return empty(400);
      case "taken":
        return empty(204);
      case "challenge":
        return yield* HttpServerResponse.schemaJson(Challenge)({ challenge: answer.challenge });
    }
  }).pipe(
    Effect.orDie,
    // As a routine's webhook: the request log leaves out what went wrong
    // under `WEBHOOK_PATH`, where the token is.
    Effect.catchDefect((defect) =>
      Effect.logError("An event delivery failed", Cause.die(defect)).pipe(Effect.as(empty(500))),
    ),
  ),
);
