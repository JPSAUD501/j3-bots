// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  AttachmentId,
  Conflict,
  HTTP_PATHS,
  Invalid,
  MAX_ATTACHMENT_SIZE,
  NotAuthenticated,
  PairRequest,
  PairResult,
  PROTOCOL_VERSION,
  RateLimited,
  ServerInfo,
  SocketTicketGrant,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../package.json" with { type: "json" };
import { Attachments } from "./attachments/Attachments.ts";
import { DeviceAuth } from "./auth/DeviceAuth.ts";
import { readBody, readText } from "./body.ts";
import { Devices } from "./devices/Devices.ts";
import * as Webhook from "./routines/webhook.ts";
import * as Rpc from "./rpc/handlers.ts";
import * as RpcSocket from "./RpcSocket.ts";
import * as Ports from "./system/Ports.ts";
import * as WebClient from "./web/WebClient.ts";

/** 200 once the server is serving, which is after the database is migrated. */
const health = HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok" }));

const serverInfo = Layer.unwrap(
  Effect.gen(function* () {
    const info: ServerInfo = {
      protocolVersion: PROTOCOL_VERSION,
      version: packageJson.version,
      startedAt: yield* DateTime.now,
    };
    const response = yield* HttpServerResponse.schemaJson(ServerInfo)(info).pipe(Effect.orDie);
    return HttpRouter.add("GET", HTTP_PATHS.server, Effect.succeed(response));
  }),
);

const bearerToken = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers["authorization"];
  return authorization?.startsWith("Bearer ")
    ? Option.some(authorization.slice("Bearer ".length))
    : Option.none();
};

const unauthorized = HttpServerResponse.jsonUnsafe(new NotAuthenticated(), { status: 401 });

const socketTicket = HttpRouter.add(
  "POST",
  HTTP_PATHS.socketTicket,
  Effect.gen(function* () {
    const auth = yield* DeviceAuth;
    const token = bearerToken(yield* HttpServerRequest.HttpServerRequest);
    if (Option.isNone(token)) return unauthorized;
    const device = yield* auth
      .authenticate({ _tag: "bearer", token: token.value })
      .pipe(Effect.option);
    if (Option.isNone(device)) return unauthorized;
    const grant = yield* auth.issueTicket(device.value);
    return yield* HttpServerResponse.schemaJson(SocketTicketGrant)(grant).pipe(Effect.orDie);
  }),
);

/** The paired device a request's bearer belongs to. */
const requestDevice = Effect.gen(function* () {
  const token = bearerToken(yield* HttpServerRequest.HttpServerRequest);
  if (Option.isNone(token)) return Option.none();
  const auth = yield* DeviceAuth;
  return yield* auth.authenticate({ _tag: "bearer", token: token.value }).pipe(Effect.option);
});

const tooLarge = HttpServerResponse.empty({ status: 413 });

/**
 * A pairing request is a code and a device name of at most 200 characters,
 * JSON-escaped: well under this. Anyone on the network may send one.
 */
const PAIR_BODY_LIMIT = 4 * 1024;

const decodePairRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PairRequest));

const pair = HttpRouter.add(
  "POST",
  HTTP_PATHS.pair,
  Effect.gen(function* () {
    const devices = yield* Devices;
    const invalid = respond(Invalid, new Invalid({ reason: "pairing-code" }), 400);
    // The size is settled before the rate limit counts the attempt.
    const body = yield* readText(yield* HttpServerRequest.HttpServerRequest, PAIR_BODY_LIMIT).pipe(
      Effect.result,
    );
    if (body._tag === "Failure") {
      return body.failure._tag === "BodyTooLarge" ? tooLarge : yield* invalid;
    }
    const request = yield* decodePairRequest(body.success).pipe(Effect.option);
    if (Option.isNone(request)) return yield* invalid;
    return yield* devices.pair(request.value).pipe(
      Effect.flatMap((result) => respond(PairResult, result, 200)),
      Effect.catchTags({
        Invalid: (error) => respond(Invalid, error, 400),
        RateLimited: (error) => respond(RateLimited, error, 429),
      }),
    );
  }),
);

/** `body` as JSON with `schema`, answered with `status`. */
const respond = <A>(schema: Schema.Codec<A, unknown>, body: A, status: number) =>
  HttpServerResponse.schemaJson(schema)(body, { status }).pipe(Effect.orDie);

const upload = HttpRouter.add(
  "POST",
  HTTP_PATHS.attachments,
  Effect.gen(function* () {
    if (Option.isNone(yield* requestDevice)) return unauthorized;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const invalid = respond(Invalid, new Invalid({ reason: "attachment" }), 400);
    const name = new URL(request.url, "http://localhost").searchParams.get("name");
    const mediaType = request.headers["content-type"];
    if (name === null || mediaType === undefined) return yield* invalid;
    const bytes = yield* readBody(request, MAX_ATTACHMENT_SIZE).pipe(Effect.result);
    if (bytes._tag === "Failure") {
      return bytes.failure._tag === "BodyTooLarge" ? tooLarge : yield* invalid;
    }
    const attachments = yield* Attachments;
    return yield* attachments.store({ name, mediaType, bytes: bytes.success }).pipe(
      Effect.flatMap((attachment) => respond(Attachment, attachment, 200)),
      Effect.catchTags({
        Invalid: () => invalid,
        Conflict: (error) => respond(Conflict, error, 409),
      }),
    );
  }),
);

const download = HttpRouter.add(
  "GET",
  `${HTTP_PATHS.attachments}/:id`,
  Effect.gen(function* () {
    if (Option.isNone(yield* requestDevice)) return unauthorized;
    const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ id: AttachmentId })).pipe(
      Effect.option,
    );
    const attachments = yield* Attachments;
    const stored = Option.isSome(params) ? yield* attachments.open(params.value.id) : Option.none();
    if (Option.isNone(stored)) return HttpServerResponse.empty({ status: 404 });
    const { attachment, path } = stored.value;
    return yield* HttpServerResponse.file(path, {
      contentType: attachment.mediaType,
      headers: {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      },
    }).pipe(Effect.orDie);
  }),
);

/** The routes outside the RPC socket. */
export const routes = Layer.mergeAll(
  health,
  serverInfo,
  socketTicket,
  pair,
  upload,
  download,
  Webhook.route,
);

/** Every route, the RPC socket and the web client: what clients are served. */
export const app = Layer.mergeAll(
  routes,
  RpcSocket.layer(Rpc.ServedRpcs, Rpc.handlers),
  WebClient.layer,
);

/**
 * `app` on `server`, with a webhook's secret left out of the request log and
 * of any trace (`Ports.serve`).
 */
export const serve = <S, SE, SR>(
  server: Layer.Layer<S, SE, SR>,
  options: { readonly logAddress: boolean },
) => Ports.serve(app, server, { ...options, redactPath: Webhook.redactPath });
