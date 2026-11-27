// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  AttachmentId,
  Conflict,
  DESKTOP_APP_ORIGINS,
  DIAGNOSTICS_API_VERSION,
  DIAGNOSTICS_HTTP_PATH,
  DIAGNOSTICS_MEDIA_TYPE,
  DiagnosticsRequest,
  diagnosticsFileName,
  HTTP_PATHS,
  Invalid,
  J3Rpcs,
  MAX_ATTACHMENT_SIZE,
  NotAuthenticated,
  PairRequest,
  PairResult,
  PROTOCOL_VERSION,
  RateLimited,
  ServerInfo,
  type ServerOrigin,
  SocketTicketGrant,
  UPDATE_API_VERSION,
  WorkImageId,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import packageJson from "../package.json" with { type: "json" };
import { REFUSED_NAME } from "./logs/annotations.ts";
import { Attachments } from "./attachments/Attachments.ts";
import { WorkImages } from "./attachments/WorkImages.ts";
import { DeviceAuth } from "./auth/DeviceAuth.ts";
import { Diagnostics } from "./diagnostics/Diagnostics.ts";
import { readBody, readText } from "./body.ts";
import { ServerConfig } from "./config.ts";
import { Devices } from "./devices/Devices.ts";
import * as MediaSocket from "./browser/MediaSocket.ts";
import * as VoiceSocket from "./voice/VoiceSocket.ts";
import * as OAuthCallback from "./connectors/oauth/callback.ts";
import * as OAuthClientMetadata from "./connectors/oauth/clientMetadata.ts";
import * as EventWebhook from "./routines/eventWebhook.ts";
import * as Webhook from "./routines/webhook.ts";
import * as Rpc from "./rpc/handlers.ts";
import * as RpcSocket from "./RpcSocket.ts";
import * as UpdateRoutes from "./update/routes.ts";
import { isServedHost } from "./system/Network.ts";
import * as Ports from "./system/Ports.ts";
import { RefusedNames } from "./web/RefusedNames.ts";
import * as WebClient from "./web/WebClient.ts";

/** 200 once the server is serving, which is after the database is migrated. */
const health = HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok" }));

const serverInfo = Layer.unwrap(
  Effect.gen(function* () {
    const info: ServerInfo = {
      protocolVersion: PROTOCOL_VERSION,
      version: packageJson.version,
      startedAt: yield* DateTime.now,
      updateApi: UPDATE_API_VERSION,
      diagnostics: DIAGNOSTICS_API_VERSION,
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
const badRequest = HttpServerResponse.empty({ status: 400 });
const unsupportedMediaType = HttpServerResponse.empty({ status: 415 });

/**
 * A pairing request is a code and a device name of at most 200 characters,
 * JSON-escaped: well under this. Anyone on the network may send one.
 */
const PAIR_BODY_LIMIT = 4 * 1024;

const decodePairRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PairRequest));

/** Whether a `Content-Type` header names JSON, with or without parameters. */
const isJson = (contentType: string | undefined) =>
  contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";

const pair = HttpRouter.add(
  "POST",
  HTTP_PATHS.pair,
  Effect.gen(function* () {
    const devices = yield* Devices;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A web page may POST `text/plain` to any address without a preflight,
    // and its wrong codes would lock pairing for everyone. JSON to another
    // origin needs a preflight the server never grants, so only JSON counts.
    if (!isJson(request.headers["content-type"])) return unsupportedMediaType;
    const invalid = respond(Invalid, new Invalid({ reason: "pairing-code" }), 400);
    // The size is settled before the rate limit counts the attempt.
    const body = yield* readText(request, PAIR_BODY_LIMIT).pipe(Effect.result);
    if (body._tag === "Failure") {
      return body.failure._tag === "BodyTooLarge" ? tooLarge : yield* invalid;
    }
    const pairing = yield* decodePairRequest(body.success).pipe(Effect.option);
    if (Option.isNone(pairing)) return yield* invalid;
    return yield* devices.pair(pairing.value).pipe(
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

/** A diagnostics request is the client's surface, release and system: well under this. */
const DIAGNOSTICS_BODY_LIMIT = 4 * 1024;

const decodeDiagnosticsRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DiagnosticsRequest),
);

/**
 * The server's diagnostics zip (`DIAGNOSTICS_HTTP_PATH`), for any paired
 * device: each is the operator's. JSON only, so a page elsewhere cannot ask
 * for one without a preflight the server never grants.
 */
const diagnostics = HttpRouter.add(
  "POST",
  DIAGNOSTICS_HTTP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!isJson(request.headers["content-type"])) return unsupportedMediaType;
    if (Option.isNone(yield* requestDevice)) return unauthorized;
    const body = yield* readText(request, DIAGNOSTICS_BODY_LIMIT).pipe(Effect.result);
    if (body._tag === "Failure") {
      return body.failure._tag === "BodyTooLarge" ? tooLarge : badRequest;
    }
    const asked = yield* decodeDiagnosticsRequest(body.success).pipe(Effect.option);
    if (Option.isNone(asked)) return badRequest;
    const zip = yield* (yield* Diagnostics).zip(asked.value.client);
    return HttpServerResponse.stream(zip, {
      contentType: DIAGNOSTICS_MEDIA_TYPE,
      headers: {
        "content-disposition": `attachment; filename="${diagnosticsFileName(yield* DateTime.now)}"`,
        "cache-control": "no-store",
      },
    });
  }),
);

/**
 * An image a step of a bot's work looked at, read from the bot's workspace as
 * it is now, typed by what its bytes hold. A page that opens its address on
 * its own is told it holds nothing to run.
 */
const workImage = HttpRouter.add(
  "GET",
  `${HTTP_PATHS.workImages}/:id`,
  Effect.gen(function* () {
    if (Option.isNone(yield* requestDevice)) return unauthorized;
    const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ id: WorkImageId })).pipe(
      Effect.option,
    );
    const images = yield* WorkImages;
    const image = Option.isSome(params) ? yield* images.open(params.value.id) : Option.none();
    if (Option.isNone(image)) return HttpServerResponse.empty({ status: 404 });
    return HttpServerResponse.uint8Array(image.value.bytes, {
      contentType: image.value.mediaType,
      headers: {
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  }),
);

const desktopOrigins: ReadonlySet<string> = new Set(Object.values(DESKTOP_APP_ORIGINS));
const isDesktopOrigin = (origin: string | undefined) =>
  origin !== undefined && desktopOrigins.has(origin);

const cors = HttpMiddleware.cors({
  allowedOrigins: isDesktopOrigin,
  allowedMethods: ["GET", "POST"],
  // Effect's HTTP client, which clients use, adds the trace context headers.
  allowedHeaders: ["authorization", "content-type", "traceparent", "b3"],
  maxAge: 600,
});

/**
 * The answer to a plain-HTTP request for a name the server does not answer
 * (`isServedHost`), in words a person who typed that name reads in the
 * browser. A page on the refused name can read it too, so it names no address
 * of the server's own; the log does (`logRefusedName`).
 */
const hostRefused = HttpServerResponse.text(
  "This server answers plain HTTP only at localhost, at an IP address, or at the name in its publicOrigin setting. Open it at one of those addresses. The server's log names the address that was refused.\n",
  { status: 403, headers: { "x-content-type-options": "nosniff" } },
);

/** The longest DNS name. Anything longer in a `Host` names nothing. */
const MAX_HOST_NAME = 253;

/** The name a `Host` header asks for, as the log shows it. */
const requestedName = (host: string | undefined) => {
  if (host === undefined) return "(no Host header)";
  const name = URL.parse(`http://${host}`)?.hostname;
  return name === undefined || name.length > MAX_HOST_NAME ? "(not a host name)" : name;
};

/**
 * Keeps each refused name (`RefusedNames`) and logs the first refusal of
 * each one kept, with what would make the server answer it: a proxy or
 * tunnel that serves it under that name needs `publicOrigin`, and anyone else
 * opens it at an address.
 */
const refusedNameLogger = (
  publicOrigin: Option.Option<ServerOrigin>,
  refused: RefusedNames["Service"],
) => {
  const answered = Option.match(publicOrigin, {
    onNone: () => "localhost and IP addresses; publicOrigin is not set",
    onSome: (origin) => `localhost, IP addresses and ${URL.parse(origin)?.hostname ?? origin}`,
  });
  return (host: string | undefined) =>
    Effect.gen(function* () {
      const name = requestedName(host);
      if (!(yield* refused.record(name))) return;
      // The name is the operator's network's: in an annotation, which a diagnostics zip leaves out.
      yield* Effect.logWarning(
        `Refused a plain-HTTP request for the name in ${REFUSED_NAME} (403). Over plain HTTP this server answers ${answered}. If a proxy or tunnel serves it at that name, set publicOrigin to that address; otherwise open it at localhost or at the address \`j3-bots pair\` prints. Further refusals of this name are not logged.`,
      ).pipe(Effect.annotateLogs(REFUSED_NAME, name));
    });
};

/**
 * What every request on the client listener passes before it is routed, the
 * RPC socket's upgrade included.
 *
 * Over plain HTTP, its `Host` must be one no web page can rebind to this
 * machine (`isServedHost`), or it is answered 403, with a line that says why
 * (`hostRefused`), and the name is logged (`refusedNameLogger`). Over HTTPS the browser
 * already refuses a name the certificate does not cover, and a proxy in front
 * may put any name there, so `Host` is not checked.
 *
 * Then CORS for the desktop app, whose pages call the server from their own
 * origin (`DESKTOP_APP_ORIGINS`), and only for requests from those origins:
 * any other request, a preflight included, is answered as if there were no
 * CORS, so a web page elsewhere still cannot read an answer. The credential is
 * a bearer header, never a cookie, so credentialed CORS is never allowed.
 *
 * Both are one middleware, so the `Host` check always comes first.
 */
const clientGate = HttpRouter.middleware(
  Effect.gen(function* () {
    const { tls, publicOrigin } = yield* ServerConfig;
    const checksHost = Option.isNone(tls);
    const logRefusedName = refusedNameLogger(publicOrigin, yield* RefusedNames);
    return (httpApp) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers["host"];
        if (checksHost && !isServedHost(host, publicOrigin)) {
          yield* logRefusedName(host);
          return hostRefused;
        }
        return yield* isDesktopOrigin(request.headers["origin"]) ? cors(httpApp) : httpApp;
      });
  }),
  { global: true },
);

/** The routes outside the RPC socket. */
export const routes = Layer.mergeAll(
  clientGate,
  health,
  serverInfo,
  socketTicket,
  pair,
  upload,
  download,
  workImage,
  diagnostics,
  Webhook.route,
  EventWebhook.route,
  UpdateRoutes.routes,
  OAuthCallback.route,
  OAuthClientMetadata.route,
);

/** Every route, the RPC, media and voice sockets and the web client: what clients are served. */
export const app = Layer.mergeAll(
  routes,
  RpcSocket.layer(J3Rpcs, Rpc.handlers),
  MediaSocket.route,
  VoiceSocket.route,
  WebClient.layer,
);

/**
 * The paths that hold a credential, as the request log shows them: a
 * webhook's secret and a sign-in's code and `state` are left out.
 */
const redactPath = (path: string) =>
  Option.orElse(Webhook.redactPath(path), () => OAuthCallback.redactPath(path));

/**
 * `app` on `server`, with every credential a path holds left out of the
 * request log and of any trace (`Ports.serve`).
 */
export const serve = <S, SE, SR>(
  server: Layer.Layer<S, SE, SR>,
  options: { readonly logAddress: boolean },
) => Ports.serve(app, server, { ...options, redactPath });
