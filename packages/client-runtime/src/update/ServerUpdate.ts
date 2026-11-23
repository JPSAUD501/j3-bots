// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DeviceToken,
  PROTOCOL_VERSION,
  ReceivedUpdateRefused,
  type ReceivedUpdateState,
  ReceivedUpdateStatus,
  type ReleaseVersion,
  UPDATE_HTTP_PATHS,
  type UpdateChannel,
  UpdateChannelRequest,
  UpdateStartRequest,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Connection, type NotPaired, ReconnectPolicy } from "../connection/Connection.ts";
import { within } from "../connection/http.ts";
import { ServerAddress } from "../ports.ts";
import { Cell, type Readable } from "../Store.ts";

// Updating the server from a client. The routes sit outside the protocol
// (`UPDATE_HTTP_PATHS`), so a client reads the server's update status and
// starts an update whether or not the RPC socket can open: that is how a
// client newer than its server brings the server forward. Everything here is
// the same on the web, the desktop and the phone; each only draws it.

/** How often a run is read while it is under way. */
const FOLLOW_EVERY = Duration.seconds(2);

/**
 * How long a run may go without the server answering before the client stops
 * saying it is restarting. Five minutes for the new release to become ready,
 * then the rollback's own start, fit in it.
 */
const GIVE_UP_AFTER = Duration.minutes(10);

/**
 * Where the server's updates stand, as this client knows it.
 *
 * - `unread`: not read yet;
 * - `unsupported`: the server has no update routes, as a release before them;
 *   it is updated on its machine (`j3-bots update`);
 * - `unreachable`: the server did not answer, and no update was under way;
 *   `last` is what it said before, if anything;
 * - `status`: what the server said last;
 * - `restarting`: an update is under way and the server does not answer,
 *   which is what restarting on the new release looks like from here;
 * - `lost`: an update was under way and nothing answered for ten minutes. A
 *   later `refresh` that reaches the server leaves it.
 */
export type ServerUpdateView =
  | { readonly _tag: "unread" }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "unreachable"; readonly last: ReceivedUpdateStatus | null }
  | { readonly _tag: "status"; readonly status: ReceivedUpdateStatus }
  | {
      readonly _tag: "restarting";
      readonly to: ReleaseVersion | null;
      readonly last: ReceivedUpdateStatus;
    }
  | { readonly _tag: "lost"; readonly to: ReleaseVersion | null; readonly last: ReceivedUpdateStatus };

/** The last update's result, as the server reports it. */
export type UpdateResult = NonNullable<ReceivedUpdateStatus["lastResult"]>;

/** What starting an update did. */
export type StartResult =
  | { readonly _tag: "started" }
  | {
      readonly _tag: "refused";
      readonly reason: ReceivedUpdateRefused["reason"];
      /** With `work-running`, how many bots have work running. */
      readonly runningBots: number | null;
    }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "unreachable" };

/** What a check or a change of channel did; the view shows what it found. */
export type RequestResult = "done" | "unsupported" | "unreachable";

/**
 * Whether `state` is a step of an update under way. A state a newer server
 * added reads as one: the contract says an unknown state is working.
 */
export const isRunning = (state: ReceivedUpdateState): boolean => {
  switch (state._tag) {
    case "downloading":
    case "verifying":
    case "installing":
    case "restarting":
    case "unknown":
      return true;
    case "idle":
    case "checking":
    case "done":
    case "rolled-back":
    case "failed":
      return false;
  }
};

/**
 * Which side is behind when the server speaks another protocol: the server,
 * which a client can update from here, or this client, which updates itself.
 */
export const behind = (serverProtocol: number): "server" | "client" =>
  serverProtocol < PROTOCOL_VERSION ? "server" : "client";

export class ServerUpdate extends Context.Service<
  ServerUpdate,
  {
    readonly view: Readable<ServerUpdateView>;
    /**
     * The result of an update this client saw under way, once it ended, until
     * `dismissEnded`: what the operator is told once. A result from before
     * this client started stays in the status' `lastResult`.
     */
    readonly ended: Readable<UpdateResult | null>;
    readonly dismissEnded: Effect.Effect<void>;
    /** Reads the status again, as when the screen that shows it opens. */
    readonly refresh: Effect.Effect<void, NotPaired>;
    /** Has the server check its release feed now. */
    readonly check: Effect.Effect<RequestResult, NotPaired>;
    /** Changes the server's channel. */
    readonly setChannel: (channel: UpdateChannel) => Effect.Effect<RequestResult, NotPaired>;
    /**
     * Starts the update to `version`, the status' `available` one. Without
     * `stopWork`, a server with bots at work refuses with `work-running`,
     * and the client asks the operator first.
     */
    readonly start: (
      version: ReleaseVersion,
      stopWork: boolean,
    ) => Effect.Effect<StartResult, NotPaired>;
  }
>()("@j3-bots/client-runtime/update/ServerUpdate") {}

/** What reading or posting to an update route came to. */
type Answer =
  | { readonly _tag: "status"; readonly status: ReceivedUpdateStatus }
  | { readonly _tag: "refused"; readonly refused: ReceivedUpdateRefused }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "unreachable" };

/** What `make` needs: where the server is, how to reach it, and this device's token. */
export interface ServerUpdateDeps {
  readonly origin: URL;
  readonly http: HttpClient.HttpClient;
  readonly requestTimeout: Duration.Duration;
  readonly token: Effect.Effect<Redacted.Redacted<DeviceToken>, NotPaired>;
  /** Called when an update this client followed has ended: the protocol may have changed. */
  readonly reconnect: Effect.Effect<void>;
}

export const make = Effect.fnUntraced(function* (deps: ServerUpdateDeps) {
  const view = new Cell<ServerUpdateView>({ _tag: "unread" });
  const ended = new Cell<UpdateResult | null>(null);
  const url = (path: string) => new URL(path, deps.origin).toString();

  const decode = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ) => HttpClientResponse.schemaBodyJson(schema)(response);

  /**
   * Sends `request` with this device's token. 404 is a server without the
   * routes. Anything else outside the contract, a 401 from a proxy in
   * between included, counts as not reached: the socket's own check is what
   * tells this device it was signed out.
   */
  const send = Effect.fn("ServerUpdate.send")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* deps.token;
    return yield* deps.http.execute(request.pipe(HttpClientRequest.bearerToken(token))).pipe(
      Effect.flatMap((response): Effect.Effect<Answer, unknown> => {
        switch (response.status) {
          case 200:
          case 202:
            return decode(response, ReceivedUpdateStatus).pipe(
              Effect.map((status) => ({ _tag: "status", status }) as const),
            );
          case 409:
            return decode(response, ReceivedUpdateRefused).pipe(
              Effect.map((refused) => ({ _tag: "refused", refused }) as const),
            );
          case 404:
            return Effect.succeed({ _tag: "unsupported" } as const);
          default:
            return Effect.succeed({ _tag: "unreachable" } as const);
        }
      }),
      within(deps.requestTimeout, () => "timeout" as const),
      Effect.orElseSucceed((): Answer => ({ _tag: "unreachable" })),
    );
  });

  const lastStatus = (): ReceivedUpdateStatus | null => {
    const current = view.get();
    switch (current._tag) {
      case "status":
        return current.status;
      case "restarting":
      case "lost":
        return current.last;
      case "unreachable":
        return current.last;
      case "unread":
      case "unsupported":
        return null;
    }
  };

  /** Whether this client follows a run under way. */
  let following = false;
  const scope = yield* Effect.scope;

  /** Reads the status every two seconds until the run ends or nothing answers for ten minutes. */
  const follow = Effect.fn("ServerUpdate.follow")(
    function* (to: ReleaseVersion | null) {
      let answeredAt = yield* DateTime.now;
      while (true) {
        yield* Effect.sleep(FOLLOW_EVERY);
        const answer = yield* send(HttpClientRequest.get(url(UPDATE_HTTP_PATHS.status))).pipe(
          Effect.catchTag("NotPaired", () => Effect.succeed<Answer>({ _tag: "unreachable" })),
        );
        if (answer._tag === "status") {
          answeredAt = yield* DateTime.now;
          view.set({ _tag: "status", status: answer.status });
          if (isRunning(answer.status.state)) continue;
          ended.set(answer.status.lastResult);
          yield* deps.reconnect;
          return;
        }
        const last = lastStatus();
        if (last === null) return;
        const silent = DateTime.distance(answeredAt, yield* DateTime.now);
        if (Duration.isGreaterThanOrEqualTo(silent, GIVE_UP_AFTER)) {
          view.set({ _tag: "lost", to, last });
          return;
        }
        view.set({ _tag: "restarting", to, last });
      }
    },
    Effect.ensuring(
      Effect.sync(() => {
        following = false;
      }),
    ),
  );

  /** Starts following the run under way, unless this client already does. */
  const ensureFollowing = Effect.fn("ServerUpdate.ensureFollowing")(function* (
    to: ReleaseVersion | null,
  ) {
    if (following) return;
    following = true;
    yield* Effect.forkIn(follow(to), scope);
  });

  /** Shows what `answer` says, and follows a run it shows under way. */
  const apply = Effect.fn("ServerUpdate.apply")(function* (
    answer: Answer,
    to: ReleaseVersion | null = null,
  ) {
    switch (answer._tag) {
      case "status": {
        view.set({ _tag: "status", status: answer.status });
        if (isRunning(answer.status.state)) {
          yield* ensureFollowing(to ?? answer.status.available?.version ?? null);
        }
        return;
      }
      case "unsupported":
        view.set({ _tag: "unsupported" });
        return;
      case "unreachable":
        // A run under way is restarting, and its follower says so.
        if (!following) view.set({ _tag: "unreachable", last: lastStatus() });
        return;
      case "refused":
        return;
    }
  });

  const result = (answer: Answer): RequestResult =>
    answer._tag === "status" ? "done" : answer._tag === "unsupported" ? "unsupported" : "unreachable";

  const refresh = send(HttpClientRequest.get(url(UPDATE_HTTP_PATHS.status))).pipe(
    Effect.flatMap((answer) => apply(answer)),
  );

  const post = <S extends Schema.Top & { readonly EncodingServices: never }>(
    path: string,
    schema: S,
    body: S["Type"],
  ) =>
    HttpClientRequest.post(url(path)).pipe(
      HttpClientRequest.schemaBodyJson(schema)(body),
      Effect.orDie,
      Effect.flatMap(send),
    );

  const check = HttpClientRequest.post(url(UPDATE_HTTP_PATHS.check)).pipe(
    send,
    Effect.tap((answer) => apply(answer)),
    Effect.map(result),
  );

  const setChannel = (channel: UpdateChannel) =>
    post(UPDATE_HTTP_PATHS.channel, UpdateChannelRequest, { channel }).pipe(
      Effect.tap((answer) => apply(answer)),
      Effect.map(result),
    );

  const start = (version: ReleaseVersion, stopWork: boolean) =>
    post(UPDATE_HTTP_PATHS.start, UpdateStartRequest, { version, stopWork }).pipe(
      Effect.flatMap((answer): Effect.Effect<StartResult> => {
        switch (answer._tag) {
          case "status":
            return apply(answer, version).pipe(
              Effect.andThen(ensureFollowing(version)),
              Effect.as({ _tag: "started" } as const),
            );
          case "refused":
            return refresh.pipe(
              Effect.ignore,
              Effect.as({
                _tag: "refused",
                reason: answer.refused.reason,
                runningBots: answer.refused.runningBots,
              } as const),
            );
          case "unsupported":
          case "unreachable":
            return Effect.succeed({ _tag: answer._tag });
        }
      }),
    );

  return ServerUpdate.of({
    view,
    ended,
    dismissEnded: Effect.sync(() => ended.set(null)),
    refresh,
    check,
    setChannel,
    start,
  });
});

/** Changes of `readable`, starting with its value now. */
const changes = <A>(readable: Readable<A>): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const push = () => {
          Queue.offerUnsafe(queue, readable.get());
        };
        push();
        return readable.subscribe(push);
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

/**
 * The server's update status for this client. It is read when the client
 * connects and when it finds the server on another protocol, which is when a
 * client most needs it; screens that show it read it again with `refresh`.
 */
export const layer = Layer.effect(
  ServerUpdate,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const { origin } = yield* ServerAddress;
    const policy = yield* ReconnectPolicy;
    const service = yield* make({
      origin,
      http: yield* HttpClient.HttpClient,
      requestTimeout: policy.requestTimeout,
      token: Effect.flatMap(connection.deviceId, connection.bearer),
      reconnect: connection.reconnectNow,
    });
    yield* changes(connection.state).pipe(
      Stream.map((state) => state._tag),
      Stream.changes,
      Stream.filter((tag) => tag === "connected" || tag === "incompatible"),
      Stream.runForEach(() => service.refresh.pipe(Effect.ignore)),
      Effect.forkScoped,
    );
    return service;
  }),
);
