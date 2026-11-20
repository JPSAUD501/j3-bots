// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps, whose sockets a stop must end.
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Whether the server could listen on an address and port: `in-use` by another
 * program, `not-local` when the address is not one of this machine's, `denied`
 * when the user may not bind it, or another error, by its code.
 */
export type PortState =
  | { readonly _tag: "free" }
  | { readonly _tag: "in-use" }
  | { readonly _tag: "not-local" }
  | { readonly _tag: "denied" }
  | { readonly _tag: "failed"; readonly code: string };

/** The state a failed listen's error code means. */
export const portStateOf = (code: string): Exclude<PortState, { _tag: "free" }> => {
  switch (code) {
    case "EADDRINUSE":
      return { _tag: "in-use" };
    case "EADDRNOTAVAIL":
      return { _tag: "not-local" };
    case "EACCES":
      return { _tag: "denied" };
    default:
      return { _tag: "failed", code };
  }
};

/** One port the server listens on, and the setting that names it. */
export interface PortUse {
  /** What listens there, for reading: "the server", "the bot tools". */
  readonly label: string;
  readonly setting: "port" | "toolPort" | "enginePort";
  readonly host: string;
  readonly port: number;
}

/** What to tell the operator when `use` cannot be listened on, and how to fix it. */
export const portAdvice = (
  state: Exclude<PortState, { _tag: "free" }>,
  use: PortUse,
  configFile: string,
) => {
  const { label, setting, host, port } = use;
  const where = `in ${configFile}`;
  switch (state._tag) {
    case "in-use":
      return {
        summary: `Port ${port}, for ${label}, is in use by another program.`,
        fix: `Stop that program (\`ss -ltnp 'sport = :${port}'\` names it), or set "${setting}" ${where} to a free port.`,
      };
    case "not-local":
      return {
        summary: `${host} is not an address of this machine, so the server cannot listen on it.`,
        fix: `Set "host" ${where} to "lan" or to one of this machine's addresses (\`ip -4 addr\`).`,
      };
    case "denied":
      return {
        summary: `This user may not listen on ${host}:${port}.`,
        fix: `Set "${setting}" ${where} to a port above 1023.`,
      };
    case "failed":
      return {
        summary: `Listening on ${host}:${port}, for ${label}, failed with ${state.code}.`,
        fix: `Check "${setting}" and "host" ${where}.`,
      };
  }
};

/** The server could not listen where its configuration says. */
class ListenFailed extends Schema.TaggedError<ListenFailed>()("ListenFailed", {
  label: Schema.String,
  setting: Schema.Literals(["port", "toolPort", "enginePort"]),
  host: Schema.String,
  port: Schema.Number,
  /** The system's error code, such as `EADDRINUSE`. */
  code: Schema.String,
  configFile: Schema.String,
}) {
  override get message(): string {
    const { summary, fix } = portAdvice(portStateOf(this.code), this, this.configFile);
    return `${summary} ${fix}`;
  }
}

/** What Node reports of a failed listen. */
const ListenError = Schema.Struct({ code: Schema.String });
const decodeListenError = Schema.decodeUnknownOption(ListenError);

/**
 * `NodeHttpServer.make`, with a stop that has an upper bound.
 *
 * `NodeHttpServer` waits for open requests only up to
 * `gracefulShutdownTimeout`, and then waits again, without a bound, for every
 * connection to end: one whose request never finished arriving, or a TLS
 * connection still in its handshake, would hold the stop until the service
 * manager kills the whole service, the engine included. So every connection
 * is tracked from its `connection` event (which a TLS server emits for the
 * raw socket too), and those still open once the grace period has passed are
 * destroyed.
 */
export const makeServer = Effect.fn("Ports.makeServer")(function* (
  createServer: () => NodeHttp.Server,
  options: NodeHttpServer.Options,
) {
  const server = createServer();
  const sockets = new Set<NodeNet.Socket>();
  server.on("connection", (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const http = yield* NodeHttpServer.make(() => server, options);
  // Finalizers run in reverse: this one before `NodeHttpServer`'s own
  // unbounded wait. The routes served on the server are a later layer,
  // released first, and their release is the graceful close, bounded by
  // `gracefulShutdownTimeout`. Whatever is still open here has had it.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
    }),
  );
  return http;
});

/**
 * The HTTP server for `use`, whose failure to listen names the port and the
 * setting to change instead of a bare `ServeError`, and whose stop has an
 * upper bound (`makeServer`).
 */
export const listen = (
  createServer: () => NodeHttp.Server,
  options: NodeHttpServer.Options,
  use: PortUse,
  configFile: string,
) =>
  Layer.mergeAll(
    Layer.effect(HttpServer.HttpServer)(
      makeServer(createServer, options).pipe(
        Effect.mapError(
          (error) =>
            new ListenFailed({
              ...use,
              code: Option.match(decodeListenError(error.cause), {
                onNone: () => "unknown",
                onSome: ({ code }) => code,
              }),
              configFile,
            }),
        ),
      ),
    ),
    NodeHttpServer.layerHttpServices,
  );

/** A request URL's path: what the request log records of it. */
const pathOf = (url: string) => url.replace(/[?#].*$/s, "");

/**
 * `HttpMiddleware.logger`, unless `redactPath` changes the request's path:
 * then that path holds a credential, and so may what went wrong (a
 * `RouteNotFound` carries the request), so the request is logged in one line
 * of its method, the path `redactPath` makes and the status, and nothing else.
 */
const requestLog =
  (redactPath: (path: string) => string) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = pathOf(request.url);
      const shown = redactPath(path);
      if (shown === path) return yield* HttpMiddleware.logger(app);
      const exit = yield* Effect.exit(app);
      const response = Exit.isSuccess(exit)
        ? exit.value
        : HttpServerError.causeResponseStripped(exit.cause)[0];
      yield* Effect.log("Sent HTTP response").pipe(
        Effect.annotateLogs({
          "http.method": request.method,
          "http.url": shown,
          "http.status": response.status,
        }),
      );
      return yield* exit;
    });

/**
 * `app`'s routes, served on the HTTP server `server` provides.
 *
 * The routes are built first and the server second. `NodeHttpServer` listens
 * as soon as it is made and answers a request only once something is served
 * on it, so a server bound before its routes are built drops whatever arrives
 * in between: a client that connects the moment the port opens would wait
 * forever. Built in this order, the port opens with the routes ready. For the
 * same reason, a step of the listener's own that waits, such as setting a
 * socket's mode, goes on the layer this returns, never on `server`.
 * `logAddress` logs where it listens once it serves.
 *
 * Each request is logged with its path as `redactPath` makes it. A request
 * whose path that changes holds a credential there: it is logged with the
 * path changed, and no trace span is made of it, since a span records the
 * whole URL.
 */
export const serve = <A, E, R, S, SE, SR>(
  app: Layer.Layer<A, E, R>,
  server: Layer.Layer<S, SE, SR>,
  {
    logAddress,
    redactPath = (path) => path,
  }: {
    readonly logAddress: boolean;
    readonly redactPath?: (path: string) => string;
  },
) => {
  const holdsCredential = (request: HttpServerRequest.HttpServerRequest) => {
    const path = pathOf(request.url);
    return redactPath(path) !== path;
  };
  const served = Layer.unwrap(
    Effect.map(HttpRouter.toHttpEffect(app), (handler) =>
      HttpServer.serve(handler, requestLog(redactPath)).pipe(
        Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(holdsCredential)),
        Layer.provideMerge(server),
      ),
    ),
  );
  return logAddress ? HttpServer.withLogAddress(served) : served;
};
