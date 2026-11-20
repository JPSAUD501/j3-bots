// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a factory for the Node HTTP server it wraps, whose sockets a stop must end.
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

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
 */
export const serve = <A, E, R, S, SE, SR>(
  app: Layer.Layer<A, E, R>,
  server: Layer.Layer<S, SE, SR>,
  { logAddress }: { readonly logAddress: boolean },
) => {
  const served = Layer.unwrap(
    Effect.map(HttpRouter.toHttpEffect(app), (handler) =>
      HttpServer.serve(handler, HttpMiddleware.logger).pipe(Layer.provideMerge(server)),
    ),
  );
  return logAddress ? HttpServer.withLogAddress(served) : served;
};
