// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A request over a pipe goes through a node:http agent that hands out that one connection.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  PairResult,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  ADMIN_PATHS,
  AdminStatus,
  LocalDeviceRequest,
  PairingOffer,
  RunningWorkReply,
  ServerReadiness,
} from "./protocol.ts";
import * as Socket from "./socket.ts";

/** The admin socket answered, but not as the server should. */
export class AdminRequestFailed extends Schema.TaggedError<AdminRequestFailed>()(
  "AdminRequestFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The running server did not answer ${this.path} as expected. If \`j3-bots\` was just updated, restart the service with \`systemctl --user restart j3-bots\`; otherwise check its log with \`journalctl --user -u j3-bots\`.`;
  }
}

/** The server answered, with a status that is not a success. */
class UnexpectedStatus extends Schema.TaggedError<UnexpectedStatus>()("UnexpectedStatus", {
  status: Schema.Int,
}) {}

/** How long a request waits for its answer, unless its method says otherwise. */
const TIMEOUT = Duration.seconds(10);

/** Reads an answer that is `schema` in JSON. */
const json = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(schema)));

/** Reads an answer with no body. */
const empty = () => Effect.void;
/** A provider connection waits for the engine's restart, up to a minute on the server's side. */
const CONNECT_TIMEOUT = Duration.seconds(90);

/**
 * Hands out one connection, the parent's end of a pipe, and keeps it between
 * requests. Once that connection has closed it has nothing to give: a pipe
 * cannot be opened again.
 */
class PipeAgent extends NodeHttp.Agent {
  readonly #pipe: NodeNet.Socket;
  #handedOut = false;
  constructor(pipe: NodeNet.Socket) {
    // One request at a time, kept alive between them; the server never closes
    // an idle pipe either (`pipe.ts`).
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    this.#pipe = pipe;
  }
  override createConnection(
    _options: NodeHttp.ClientRequestArgs,
    callback?: (error: Error | null, stream: NodeStream.Duplex) => void,
  ): NodeStream.Duplex | null | undefined {
    if (!this.#handedOut && !this.#pipe.destroyed) {
      this.#handedOut = true;
      return this.#pipe;
    }
    // The stream is ignored next to an error.
    callback?.(new Error("The admin pipe is closed."), this.#pipe);
    return undefined;
  }
}

/**
 * The parent's end of the pipe a server it started inherited for its admin
 * channel (`j3-bots serve --admin-fd`), made by `openPipe`.
 */
export interface AdminPipe {
  readonly _tag: "AdminPipe";
  readonly pipe: NodeNet.Socket;
  readonly agents: NodeHttpClient.HttpAgent["Service"];
}

/**
 * Where a command asks the running server: the admin socket, by its path, or
 * a pipe to a server this process started (`AdminPipe`).
 */
export type AdminChannel = string | AdminPipe;

/**
 * The admin channel over `pipe`, the parent's end of the descriptor a server
 * this process started inherited, such as `child.stdio[3]` (spawn it as
 * `"overlapped"`, which is `"pipe"` everywhere but Windows, where the server's
 * end must allow a write while a read waits). Requests on it go one at a
 * time over that one connection, for as long as the scope lives; closing the
 * scope closes the pipe.
 *
 * A request waits for its answer as long as on the socket, and no longer, so
 * a parent never hangs on a server that stopped answering or a descriptor
 * that is not the admin channel. One that gets no answer in time, or is
 * abandoned by an interruption, closes the pipe, since the connection could
 * no longer tell where the next answer starts: the channel is then gone, and
 * every answer is none. A parent treats that as a lost server. The desktop
 * app, which starts the server, then kills it, as it does when `/shutdown`
 * gets no answer. The first request may wait while the server starts, before
 * it serves the pipe: give that one `status` with a longer `within`.
 */
export const openPipe = (pipe: NodeNet.Socket) =>
  Effect.acquireRelease(
    Effect.sync((): AdminPipe => ({
      _tag: "AdminPipe",
      pipe,
      // The channel is plain HTTP: the HTTPS agent is never used.
      agents: { http: new PipeAgent(pipe), https: new NodeHttps.Agent() },
    })),
    ({ agents }) =>
      Effect.sync(() => {
        agents.http.destroy();
        agents.https.destroy();
        pipe.destroy();
      }),
  );

/**
 * The HTTP client that reaches the server on `channel`, or none when no
 * server answers there: nothing listens on the socket, or the pipe is closed.
 */
const clientOn = (channel: AdminChannel) =>
  typeof channel === "string"
    ? Socket.probe(channel).pipe(
        Effect.map((state) =>
          state === "live"
            ? Option.some(
                NodeHttpClient.layerNodeHttpNoAgent.pipe(
                  Layer.provide(NodeHttpClient.layerAgentOptions({ socketPath: channel })),
                ),
              )
            : Option.none(),
        ),
      )
    : Effect.succeed(
        channel.pipe.destroyed
          ? Option.none()
          : Option.some(
              NodeHttpClient.layerNodeHttpNoAgent.pipe(
                Layer.provide(Layer.succeed(NodeHttpClient.HttpAgent)(channel.agents)),
              ),
            ),
      );

/**
 * The running server, as `j3-bots` commands and the desktop app see it over
 * an admin channel. Each answer is none when no server answers on that channel.
 */
export class AdminClient extends Context.Service<
  AdminClient,
  {
    /**
     * `within` bounds the wait for the answer (10 seconds unless given), which
     * on a pipe includes the server's start, if it does not serve it yet.
     */
    readonly status: (
      channel: AdminChannel,
      options?: { readonly within?: Duration.Duration },
    ) => Effect.Effect<Option.Option<AdminStatus>, AdminRequestFailed>;
    /** The status reply, read only as far as `j3-bots update` needs it. */
    readonly readiness: (
      channel: AdminChannel,
    ) => Effect.Effect<Option.Option<ServerReadiness>, AdminRequestFailed>;
    readonly runningWork: (
      channel: AdminChannel,
    ) => Effect.Effect<Option.Option<RunningWorkReply>, AdminRequestFailed>;
    /**
     * A code for a new device, or until when pairing is locked. With `unlock`,
     * the lock is lifted first, so the answer is always a code.
     */
    readonly startPairing: (
      channel: AdminChannel,
      options: { readonly unlock: boolean },
    ) => Effect.Effect<Option.Option<PairingOffer>, AdminRequestFailed>;
    readonly connectProviders: (
      channel: AdminChannel,
      request: ProviderConnectionRequest,
    ) => Effect.Effect<Option.Option<ProviderConnectionOutcome>, AdminRequestFailed>;
    /**
     * A device paired without a code, revoking the one the request replaces in
     * the same transaction: the desktop app's own device.
     */
    readonly localDevice: (
      channel: AdminChannel,
      request: LocalDeviceRequest,
    ) => Effect.Effect<Option.Option<PairResult>, AdminRequestFailed>;
    /** Asks the server to stop as SIGTERM stops it, and returns once it accepted. */
    readonly shutdown: (
      channel: AdminChannel,
    ) => Effect.Effect<Option.Option<void>, AdminRequestFailed>;
  }
>()("@j3-bots/server/admin/AdminClient") {}

export const layer = Layer.effect(
  AdminClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ask =
      <A>(
        path: string,
        method: "GET" | "POST",
        /** Reads the answer's body. */
        read: (body: string) => Effect.Effect<A, Schema.SchemaError>,
        /** Whether the answer carries a secret, such as a pairing code. */
        secretAnswer: boolean,
        body: Option.Option<
          (
            request: HttpClientRequest.HttpClientRequest,
          ) => Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>
        > = Option.none(),
        timeout: Duration.Duration = TIMEOUT,
      ) =>
      (channel: AdminChannel) =>
        Effect.gen(function* () {
          const reached = yield* clientOn(channel);
          if (Option.isNone(reached)) return Option.none();
          return yield* Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            // The host is never resolved: the agent dials the socket or hands out the pipe.
            const request = HttpClientRequest.make(method)(`http://localhost${path}`);
            return yield* Option.match(body, {
              onNone: () => Effect.succeed(request),
              onSome: (write) => write(request),
            }).pipe(
              Effect.flatMap((request) => client.execute(request)),
              // Read whole before the status is looked at: on a pipe, the next
              // request waits for this answer to end.
              Effect.flatMap((response) =>
                Effect.flatMap(
                  response.text,
                  (text): Effect.Effect<A, Schema.SchemaError | UnexpectedStatus> =>
                    response.status >= 200 && response.status < 300
                      ? read(text)
                      : Effect.fail(new UnexpectedStatus({ status: response.status })),
                ),
              ),
              // An answer abandoned on a pipe would be read as the next one's.
              typeof channel === "string"
                ? identity
                : Effect.onInterrupt(() => Effect.sync(() => channel.pipe.destroy())),
              Effect.timeout(timeout),
              Effect.asSome,
              // A failure may hold the request or the answer: a request's body
              // may hold a key, and an answer that did not decode may hold a
              // code or a token.
              Effect.mapError(
                (cause) =>
                  new AdminRequestFailed({
                    path,
                    cause: Option.isSome(body)
                      ? "Left out: the request carried a body."
                      : secretAnswer
                        ? "Left out: the answer carries a secret."
                        : cause,
                  }),
              ),
            );
          }).pipe(Effect.provide(reached.value));
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    return AdminClient.of({
      status: Effect.fn("AdminClient.status")(function* (
        channel: AdminChannel,
        options?: { readonly within?: Duration.Duration },
      ) {
        return yield* ask(
          ADMIN_PATHS.status,
          "GET",
          json(AdminStatus),
          false,
          Option.none(),
          options?.within,
        )(channel);
      }),
      readiness: ask(ADMIN_PATHS.status, "GET", json(ServerReadiness), false),
      runningWork: ask(ADMIN_PATHS.runningWork, "GET", json(RunningWorkReply), false),
      startPairing: Effect.fn("AdminClient.startPairing")(function* (
        channel: AdminChannel,
        options: { readonly unlock: boolean },
      ) {
        const path = options.unlock ? ADMIN_PATHS.unlockPairing : ADMIN_PATHS.pairing;
        return yield* ask(path, "POST", json(PairingOffer), true)(channel);
      }),
      connectProviders: Effect.fn("AdminClient.connectProviders")(function* (
        channel: AdminChannel,
        request: ProviderConnectionRequest,
      ) {
        return yield* ask(
          ADMIN_PATHS.providerConnection,
          "POST",
          json(ProviderConnectionOutcome),
          false,
          Option.some(HttpClientRequest.schemaBodyJson(ProviderConnectionRequest)(request)),
          CONNECT_TIMEOUT,
        )(channel);
      }),
      localDevice: Effect.fn("AdminClient.localDevice")(function* (
        channel: AdminChannel,
        request: LocalDeviceRequest,
      ) {
        return yield* ask(
          ADMIN_PATHS.localDevice,
          "POST",
          json(PairResult),
          true,
          Option.some(HttpClientRequest.schemaBodyJson(LocalDeviceRequest)(request)),
        )(channel);
      }),
      shutdown: Effect.fn("AdminClient.shutdown")(function* (channel: AdminChannel) {
        return yield* ask(ADMIN_PATHS.shutdown, "POST", empty, false)(channel);
      }),
    });
  }),
);
