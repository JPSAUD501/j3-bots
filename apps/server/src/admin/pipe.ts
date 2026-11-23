// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- An inherited descriptor is checked with node:fs, opened with node:net, and node:http parses the requests on it.
// @effect-diagnostics anyUnknownInErrorContext:off -- An HTTP server is handed any app, whatever it fails with: the request handler answers every failure.
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as HttpMiddleware from "effect/http/HttpMiddleware";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";

// The admin channel over a pipe the server inherited from the process that
// started it (`j3-bots serve --admin-fd <n>`): how the desktop app reaches the
// server it runs, and on Windows, where the home has no admin socket, the only
// admin channel. Nothing else holds the other end, and nothing can open it by
// name: a socket pair has none, and the single-instance named pipe libuv makes
// on Windows is opened by the parent before the server starts. So no other
// process, of this user or another, can reach it.
//
// It is one HTTP/1.1 connection for the life of the process, which only the
// parent writes to. A pipe cannot be opened again, so the server never closes
// it for being idle: it ends when the server stops, when the parent closes its
// end, or when a request on it is malformed, which Node's parser answers 400
// before it closes the connection.

/** How long a stop waits for a request on the pipe to be answered, such as `/shutdown`'s 202. */
const GRACE = Duration.seconds(1);

/** `--admin-fd` names something the admin channel cannot be served on. */
class AdminPipeUnusable extends Schema.TaggedError<AdminPipeUnusable>()("AdminPipeUnusable", {
  fd: Schema.Int,
  reason: Schema.String,
}) {
  override get message(): string {
    return `--admin-fd ${this.fd} cannot carry the admin channel: ${this.reason}. It must name a pipe this process inherited, open for reading and writing, from the process that started it.`;
  }
}

/** What Node reports of a descriptor it could not open. */
const OpenError = Schema.Struct({ code: Schema.String });
const decodeOpenError = Schema.decodeUnknownOption(OpenError);

const notOpen = (fd: number) => (cause: unknown) =>
  new AdminPipeUnusable({
    fd,
    reason: Option.match(decodeOpenError(cause), {
      onNone: () => "it is not an open pipe",
      onSome: ({ code }) => `it is not an open pipe (${code})`,
    }),
  });

/**
 * On Linux and macOS, fails unless `fd` is a socket. Node makes a stdio pipe
 * there as a socket pair (libuv's `uv_socketpair`), the one kind that carries
 * both directions, so a FIFO or a one-way pipe, a file or a terminal is
 * refused. Windows has no such file types to tell apart: Node's stream over the
 * descriptor refuses a file or a console there.
 */
const checkKind = (fd: number) =>
  process.platform === "win32"
    ? Effect.void
    : Effect.try({ try: () => NodeFs.fstatSync(fd), catch: notOpen(fd) }).pipe(
        Effect.flatMap((stats) =>
          stats.isSocket()
            ? Effect.void
            : Effect.fail(
                new AdminPipeUnusable({
                  fd,
                  reason: stats.isFIFO()
                    ? "it is a FIFO or a one-way pipe, not a socket pair"
                    : "it is not a socket pair",
                }),
              ),
        ),
      );

/**
 * The inherited descriptor as a stream, ended when the scope closes. A TCP
 * socket, listening or connected, is refused: the admin channel never travels
 * over TCP. Node gives a TCP socket a local address, and never a stream over
 * a socket pair or a pipe.
 */
const openPipe = (fd: number) =>
  Effect.acquireRelease(
    checkKind(fd).pipe(
      Effect.andThen(
        Effect.try({
          try: () => new NodeNet.Socket({ fd, readable: true, writable: true }),
          catch: notOpen(fd),
        }),
      ),
      Effect.flatMap((socket) => {
        if (socket.localAddress === undefined && socket.remoteAddress === undefined) {
          return Effect.succeed(socket);
        }
        socket.destroy();
        return Effect.fail(new AdminPipeUnusable({ fd, reason: "it is a TCP socket" }));
      }),
    ),
    (socket) =>
      Effect.callback<void>((resume) => {
        if (socket.destroyed) return resume(Effect.void);
        socket.end(() => resume(Effect.void));
      }).pipe(Effect.timeoutOption(GRACE), Effect.ensuring(Effect.sync(() => socket.destroy()))),
  );

type Handler = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void;

/**
 * What an `HttpServer` is handed to serve: any app, whatever it fails with,
 * since the request handler answers every failure itself.
 */
type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

/**
 * An HTTP server whose one connection is the pipe at `fd`. It never listens:
 * the connection is handed to Node's HTTP parser as if it had been accepted.
 * Its stop answers the requests in progress first, for up to a second.
 */
export const server = (fd: number) =>
  Layer.mergeAll(
    Layer.effect(HttpServer.HttpServer)(
      Effect.gen(function* () {
        const pipe = yield* openPipe(fd);
        const http = NodeHttp.createServer();
        // Never close the pipe between requests. Node checks how long a request
        // takes to arrive only on a server that listens; off here regardless.
        http.keepAliveTimeout = 0;
        http.requestTimeout = 0;
        http.headersTimeout = 0;
        let inFlight = 0;
        const answered = new Set<() => void>();
        const untilAnswered = Effect.callback<void>((resume) => {
          if (inFlight === 0) return resume(Effect.void);
          const done = () => resume(Effect.void);
          answered.add(done);
          return Effect.sync(() => answered.delete(done));
        });
        // The parent closed its end, or Node's parser closed the pipe on a
        // request it could not read: the server goes on without the channel.
        yield* Effect.forkScoped(
          Effect.callback<void>((resume) => {
            pipe.once("close", () => resume(Effect.void));
          }).pipe(
            Effect.andThen(
              Effect.logWarning("The admin pipe closed; the server goes on without it"),
            ),
          ),
        );
        return HttpServer.make({
          // Not a path to open: the descriptor the channel was inherited on, for reading.
          address: NetAddress.unixPathAddress(`fd:${fd}`),
          serve: Effect.fn("AdminPipe.serve")(function* (
            app: App,
            middleware?: HttpMiddleware.HttpMiddleware,
          ) {
            const serveScope = yield* Effect.scope;
            const requests = yield* Scope.fork(serveScope, "parallel");
            const handler: Handler = yield* NodeHttpServer.makeHandler<
              HttpServerRequest.HttpServerRequest | Scope.Scope,
              unknown,
              App
            >(app, { scope: requests, middleware });
            const counted: Handler = (request, response) => {
              inFlight += 1;
              response.once("close", () => {
                inFlight -= 1;
                if (inFlight > 0) return;
                for (const done of answered) done();
                answered.clear();
              });
              handler(request, response);
            };
            // Added after `requests`, so it runs before that scope interrupts what is left.
            yield* Effect.addFinalizer(() =>
              untilAnswered.pipe(
                Effect.timeoutOption(GRACE),
                Effect.ensuring(Effect.sync(() => http.off("request", counted))),
              ),
            );
            http.on("request", counted);
            http.emit("connection", pipe);
          }),
        });
      }),
    ),
    NodeHttpServer.layerHttpServices,
  );
