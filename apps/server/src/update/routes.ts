// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DeviceId,
  NotAuthenticated,
  UPDATE_API_VERSION,
  UPDATE_HTTP_PATHS,
  UpdateChannelRequest,
  UpdateRefused,
  UpdateStartRequest,
  UpdateStatus,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { readText } from "../body.ts";
import { ReleaseFeed } from "../releases/ReleaseFeed.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { UpdateRuns } from "./UpdateRuns.ts";

// The update routes (`UPDATE_HTTP_PATHS`): plain HTTP beside the RPC socket,
// outside `PROTOCOL_VERSION`, so a client on another protocol still reads the
// server's version and brings it forward
// (docs/decisions/0032-updates-are-served-outside-the-protocol.md).
//
// Every route takes a paired device's token as its bearer, and only that:
// every paired device is the operator's. A `POST` with a body takes JSON
// only, so a web page elsewhere cannot send one without a preflight, which
// the server never grants it; the bearer header alone already needs one.
// Progress is read by polling `status`: an update restarts the server, which
// would end any stream in the middle, and a client already polls
// `/api/server` while the server is down.

/** A request body here is a version and a flag, or a channel: well under this. */
const BODY_LIMIT = 1024;

const unauthorized = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });
const unsupportedMediaType = HttpServerResponse.empty({ status: 415 });
const tooLarge = HttpServerResponse.empty({ status: 413 });
const badRequest = HttpServerResponse.empty({ status: 400 });

/** `body` as JSON with `schema`, answered with `status`. */
const respond = <A>(schema: Schema.Codec<A, unknown>, body: A, status: number) =>
  HttpServerResponse.schemaJson(schema)(body, { status }).pipe(Effect.orDie);

/** Whether a `Content-Type` header names JSON, with or without parameters. */
const isJson = (contentType: string | undefined) =>
  contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";

/** The paired device a request's bearer belongs to. */
const requestDevice = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authorization = request.headers["authorization"];
  if (authorization?.startsWith("Bearer ") !== true) return Option.none();
  const auth = yield* DeviceAuth;
  return yield* auth
    .authenticate({ _tag: "bearer", token: authorization.slice("Bearer ".length) })
    .pipe(Effect.option);
});

/** A request's body as a route takes it, or the response that refuses it. */
type Body<A> =
  | { readonly _tag: "body"; readonly value: A }
  | { readonly _tag: "refused"; readonly response: HttpServerResponse.HttpServerResponse };

/** The request's JSON body with `schema`: 415 when it is not JSON, 413 past the limit, 400 when it does not decode. */
const jsonBody = Effect.fn("update.jsonBody")(function* <A>(schema: Schema.Codec<A, unknown>) {
  const refused = (response: HttpServerResponse.HttpServerResponse): Body<A> => ({
    _tag: "refused",
    response,
  });
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!isJson(request.headers["content-type"])) return refused(unsupportedMediaType);
  const text = yield* readText(request, BODY_LIMIT).pipe(Effect.result);
  if (text._tag === "Failure") {
    return refused(text.failure._tag === "BodyTooLarge" ? tooLarge : badRequest);
  }
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text.success).pipe(
    Effect.option,
  );
  return Option.match(decoded, {
    onNone: () => refused(badRequest),
    onSome: (value): Body<A> => ({ _tag: "body", value }),
  });
});

/** The status: the feed's view of the releases and the runs' of updating, as one. */
const status = Effect.gen(function* () {
  const feed = yield* (yield* ReleaseFeed).status;
  const runs = yield* (yield* UpdateRuns).view;
  const { checking, ...releases } = feed;
  return {
    api: UPDATE_API_VERSION,
    ...releases,
    ...runs,
    state: runs.state._tag === "idle" && checking ? { _tag: "checking" } : runs.state,
  } satisfies UpdateStatus;
});

/** Runs `handle` for a paired device, or answers 401. */
const authenticated = Effect.fn("update.authenticated")(function* <E, R>(
  handle: (device: DeviceId) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const device = yield* requestDevice;
  return Option.isNone(device) ? unauthorized : yield* handle(device.value);
});

const statusRoute = HttpRouter.add(
  "GET",
  UPDATE_HTTP_PATHS.status,
  authenticated(() => Effect.flatMap(status, (body) => respond(UpdateStatus, body, 200))),
);

const checkRoute = HttpRouter.add(
  "POST",
  UPDATE_HTTP_PATHS.check,
  authenticated(() =>
    Effect.gen(function* () {
      yield* (yield* ReleaseFeed).check;
      return yield* respond(UpdateStatus, yield* status, 200);
    }),
  ),
);

const channelRoute = HttpRouter.add(
  "POST",
  UPDATE_HTTP_PATHS.channel,
  authenticated(() =>
    Effect.gen(function* () {
      const body = yield* jsonBody(UpdateChannelRequest);
      if (body._tag === "refused") return body.response;
      const settings = yield* SettingsService;
      const sql = yield* SqlClient.SqlClient;
      const changes = { updateChannel: body.value.channel };
      // Only a time zone can be refused.
      yield* sql.withTransaction(settings.save(changes)).pipe(Effect.orDie);
      yield* settings.applied(changes);
      return yield* respond(UpdateStatus, yield* status, 200);
    }),
  ),
);

const startRoute = HttpRouter.add(
  "POST",
  UPDATE_HTTP_PATHS.start,
  authenticated((device) =>
    Effect.gen(function* () {
      const body = yield* jsonBody(UpdateStartRequest);
      if (body._tag === "refused") return body.response;
      const feed = yield* (yield* ReleaseFeed).status;
      // The feed hears of a channel change after it committed: until then, its offer is the old channel's.
      const { updateChannel } = yield* (yield* SettingsService).get;
      const available = Option.filter(
        Option.fromNullishOr(feed.available),
        () => feed.channel === updateChannel,
      );
      return yield* (yield* UpdateRuns)
        .start({
          version: body.value.version,
          stopWork: body.value.stopWork,
          device,
          available: Option.map(available, ({ version }) => version),
        })
        .pipe(
          Effect.andThen(status),
          Effect.flatMap((started) => respond(UpdateStatus, started, 202)),
          Effect.catchTag("UpdateRefused", (refused) => respond(UpdateRefused, refused, 409)),
        );
    }),
  ),
);

/** The update routes. */
export const routes = Layer.mergeAll(statusRoute, checkRoute, channelRoute, startRoute);
