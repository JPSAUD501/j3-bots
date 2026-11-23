// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- HTTP over the pipe the server inherited, which needs Node's own HTTP client and an agent that owns that one socket.
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { DeviceId, DeviceToken, Label } from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The server's admin protocol, as the desktop app speaks it to the server it
// runs: over the pipe that server inherited on fd 3, which only this process
// holds, or over `<home>/admin.sock` to a server another run of the app left
// behind (Unix only). The routes are the server's (`apps/server/src/admin`).
// Only the fields the app reads are decoded, and anything more is ignored,
// so the app reads a server one release older than itself, as after a
// rollback, or newer.

export const ADMIN_ROUTES = {
  status: "/status",
  localDevice: "/local-device",
  shutdown: "/shutdown",
} as const;

/** What the app reads of the server's status. */
export const StatusReply = Schema.Struct({
  /** The J3 Bots release that runs. */
  version: Schema.String,
  /** Its process, which tells it from another on the same channel. */
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  listener: Schema.Struct({
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  /** Its engine's state, by name only, so a newer release's states read too. */
  engine: Schema.Struct({ state: Schema.Struct({ _tag: Schema.String }) }),
});
export type StatusReply = typeof StatusReply.Type;

export const LocalDeviceRequest = Schema.Struct({ name: Label, replaces: Schema.NullOr(DeviceId) });
export type LocalDeviceRequest = typeof LocalDeviceRequest.Type;

const LocalDeviceReply = Schema.Struct({ deviceId: DeviceId, token: DeviceToken });
type LocalDeviceReply = typeof LocalDeviceReply.Type;

/**
 * Nothing answered on the channel: the server is not there, or the channel
 * closed, or a request took longer than `ADMIN_DEADLINE`. A pipe cannot be
 * opened again, so a channel that failed once stays failed.
 */
class AdminUnreachable extends Schema.TaggedError<AdminUnreachable>()("AdminUnreachable", {
  cause: Schema.Defect(),
}) {}

/** The server answered, but not with what the route promises. */
export class AdminRefused extends Schema.TaggedError<AdminRefused>()("AdminRefused", {
  route: Schema.String,
  status: Schema.Number,
}) {}

type AdminError = AdminUnreachable | AdminRefused;

/** How long a request may take before the channel counts as lost. */
const ADMIN_DEADLINE = Duration.seconds(30);

/** The server's admin routes, over one channel. */
export interface AdminChannel {
  /**
   * The server's status, waiting up to `deadline` (`ADMIN_DEADLINE` by
   * default). A server just started reads its pipe only once it is ready,
   * so the first request waits there, unanswered, until then: polling
   * would abandon requests, and with them the pipe.
   */
  readonly status: (deadline?: Duration.Input) => Effect.Effect<StatusReply, AdminError>;
  /** Signs a device in, revoking `replaces` in the same step. */
  readonly localDevice: (
    request: LocalDeviceRequest,
  ) => Effect.Effect<LocalDeviceReply, AdminError>;
  /** Asks the server to stop as it does on SIGTERM. It answers before it stops. */
  readonly shutdown: Effect.Effect<void, AdminError>;
}

interface Reply {
  readonly status: number;
  readonly body: string;
}

/** Where requests go: an agent that owns the one inherited socket, or a socket path. */
type Target = { readonly agent: NodeHttp.Agent } | { readonly socketPath: string };

/**
 * An agent with one connection, the socket it is given, kept open between
 * requests. A pipe cannot be dialed again: once the server closes it, or a
 * request is abandoned (Node destroys its socket), every request fails.
 */
class InheritedSocketAgent extends NodeHttp.Agent {
  readonly #socket: NodeStream.Duplex;
  #handedOut = false;

  constructor(socket: NodeStream.Duplex) {
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    this.#socket = socket;
  }

  // The agent asks for a connection only when it has none: the first time,
  // and after the one it had closed, which cannot be opened again.
  override createConnection(
    _options: NodeHttp.ClientRequestArgs,
    callback?: (error: Error | null, socket: NodeStream.Duplex) => void,
  ): NodeStream.Duplex | null | undefined {
    if (this.#handedOut || this.#socket.destroyed) {
      callback?.(new Error("The admin channel closed."), this.#socket);
      return undefined;
    }
    this.#handedOut = true;
    return this.#socket;
  }
}

const send = (
  target: Target,
  method: "GET" | "POST",
  route: string,
  body: string | null,
  deadline: Duration.Input = ADMIN_DEADLINE,
) =>
  Effect.callback<Reply, AdminUnreachable>((resume) => {
    const request = NodeHttp.request(
      {
        ...target,
        method,
        path: route,
        headers: {
          host: "localhost",
          ...(body === null
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (cause) => resume(Effect.fail(new AdminUnreachable({ cause }))));
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    request.on("error", (cause) => resume(Effect.fail(new AdminUnreachable({ cause }))));
    request.end(body ?? undefined);
    return Effect.sync(() => request.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () => Effect.fail(new AdminUnreachable({ cause: "no answer in time" })),
    }),
  );

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusReply));
const decodeLocalDevice = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalDeviceReply));
const encodeLocalDevice = Schema.encodeSync(Schema.fromJsonString(LocalDeviceRequest));

const channelOver = (target: Target): AdminChannel => {
  const answer = <A>(
    route: string,
    reply: Reply,
    decode: (body: string) => Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A, AdminRefused> =>
    reply.status >= 200 && reply.status < 300
      ? decode(reply.body).pipe(
          Effect.mapError(() => new AdminRefused({ route, status: reply.status })),
        )
      : Effect.fail(new AdminRefused({ route, status: reply.status }));
  return {
    status: (deadline) =>
      send(target, "GET", ADMIN_ROUTES.status, null, deadline).pipe(
        Effect.flatMap((reply) => answer(ADMIN_ROUTES.status, reply, decodeStatus)),
      ),
    localDevice: (request) =>
      send(target, "POST", ADMIN_ROUTES.localDevice, encodeLocalDevice(request)).pipe(
        Effect.flatMap((reply) => answer(ADMIN_ROUTES.localDevice, reply, decodeLocalDevice)),
      ),
    shutdown: send(target, "POST", ADMIN_ROUTES.shutdown, null).pipe(
      Effect.flatMap((reply) => answer(ADMIN_ROUTES.shutdown, reply, () => Effect.void)),
    ),
  };
};

/** The admin routes over the pipe a server inherited, as its parent holds it. */
export const overInheritedPipe = (socket: NodeStream.Duplex): AdminChannel =>
  channelOver({ agent: new InheritedSocketAgent(socket) });

/** The admin routes over `<home>/admin.sock` (Unix). */
export const overSocket = (socketPath: string): AdminChannel => channelOver({ socketPath });
