// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DeviceId,
  type DeviceToken,
  J3Rpcs,
  Label,
  PairingCode,
  PROTOCOL_VERSION,
  type PairRequest,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RpcClient from "effect/rpc/RpcClient";
import { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  type CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
  Network,
  ServerAddress,
} from "../ports.ts";
import { Cell, type Readable } from "../Store.ts";
import * as ServerHttp from "./http.ts";

/** The client for every RPC in the contract, bound to one socket. */
export type J3RpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof J3Rpcs>, RpcClientError>;

/**
 * What the UI shows about the link to the server. While it is anything but
 * `connected`, every store keeps what it last had and marks it stale.
 */
export type ConnectionState =
  /** Reading the device credential. */
  | { readonly _tag: "starting" }
  /** No device credential: the client must pair. `reason` says why, for the UI. */
  | { readonly _tag: "unpaired"; readonly reason: UnpairedReason }
  /** The platform reports no network. The client tries again when it returns. */
  | { readonly _tag: "offline" }
  | { readonly _tag: "connecting"; readonly attempt: number }
  | { readonly _tag: "connected" }
  /**
   * The last attempt failed, and the next starts at `retryAt`. `unreachable`
   * when no socket opened; `dropped` when an open socket closed.
   */
  | {
      readonly _tag: "waiting";
      readonly reason: "unreachable" | "dropped";
      readonly attempt: number;
      readonly retryAt: DateTime.Utc;
    }
  /** The server speaks another protocol version. Nothing is retried until `reconnectNow`. */
  | { readonly _tag: "incompatible"; readonly serverProtocol: number }
  /** The credential storage failed. Nothing is retried until `reconnectNow`. */
  | { readonly _tag: "storage-failed" };

/**
 * Why the client has no credential. `new`: it never had one. `signed-out`: the
 * server ended this device's access, or it was signed out here or in another
 * window. `still-listed`: it signed out here without reaching the server,
 * which lists it until another device revokes it.
 */
export type UnpairedReason = "new" | "signed-out" | "still-listed";

/** The device is not paired, so the command cannot reach the server. */
export class NotPaired extends Schema.TaggedError<NotPaired>()("NotPaired", {}) {
  override get message(): string {
    return "This device is not paired.";
  }
}

export const PairingFailure = Schema.Union([
  /** The code is malformed, wrong, expired or already used. */
  Schema.TaggedStruct("invalid-code", {}),
  /** Too many failed codes; pairing opens again at `retryAt`. */
  Schema.TaggedStruct("rate-limited", { retryAt: Schema.DateTimeUtc }),
  Schema.TaggedStruct("unreachable", {}),
  Schema.TaggedStruct("incompatible-server", { serverProtocol: Schema.Int }),
  /** Paired, but the credential could not be kept, so the pairing is lost. */
  Schema.TaggedStruct("storage-failed", {}),
]);
export type PairingFailure = typeof PairingFailure.Type;

export class PairingFailed extends Schema.TaggedError<PairingFailed>()("PairingFailed", {
  reason: PairingFailure,
}) {
  override get message(): string {
    return `Pairing failed: ${this.reason._tag}.`;
  }
}

export interface ReconnectSettings {
  /** The pause after the first failure. Each further failure doubles it. */
  readonly initialDelay: Duration.Duration;
  readonly maxDelay: Duration.Duration;
  /** How long a socket may take to open. */
  readonly openTimeout: Duration.Duration;
  /**
   * How long an HTTP request may take to answer before the server counts as
   * unreachable. An upload is also given time for its bytes: see `uploadDeadline`.
   */
  readonly requestTimeout: Duration.Duration;
  /** How long an open socket may stay silent before it counts as dropped. */
  readonly pingTimeout: Duration.Duration;
}

/** How the client paces its attempts. The defaults suit every platform. */
export class ReconnectPolicy extends Context.Reference<ReconnectSettings>(
  "@j3-bots/client-runtime/connection/ReconnectPolicy",
  {
    defaultValue: () => ({
      initialDelay: Duration.millis(500),
      maxDelay: Duration.seconds(30),
      openTimeout: Duration.seconds(10),
      requestTimeout: Duration.seconds(10),
      pingTimeout: Duration.seconds(15),
    }),
  },
) {}

/**
 * The pause before attempt `failures + 1`: exponential, capped, and jittered
 * over its upper half so clients that lost the server together do not return
 * together, while none retries at once.
 */
export const backoffDelay = (
  failures: number,
  policy: Pick<ReconnectSettings, "initialDelay" | "maxDelay">,
  random: number,
): Duration.Duration => {
  const base = Math.min(
    Duration.toMillis(policy.maxDelay),
    Duration.toMillis(policy.initialDelay) * 2 ** Math.max(0, failures - 1),
  );
  return Duration.millis(base / 2 + (random * base) / 2);
};

/** Upper case, without the spaces and dashes people type between groups. */
export const normalizePairingCode = (input: string) => input.replace(/[\s-]/g, "").toUpperCase();

/** One open socket. `generation` grows with every socket, so a retry can wait for a newer one. */
interface Session {
  readonly client: J3RpcClient;
  readonly generation: number;
  /** Completes when the socket closes. */
  readonly closed: Deferred.Deferred<void>;
}

type Slot =
  | { readonly _tag: "closed" }
  | { readonly _tag: "open"; readonly session: Session }
  | { readonly _tag: "unpaired" };

type Credential =
  | { readonly _tag: "loading" }
  | { readonly _tag: "none"; readonly reason: UnpairedReason }
  | { readonly _tag: "paired"; readonly credential: DeviceCredential };

type AttemptOutcome =
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "dropped" }
  | { readonly _tag: "revoked" }
  | { readonly _tag: "incompatible"; readonly serverProtocol: number }
  | { readonly _tag: "credential-changed" }
  /** The platform reported the network gone. */
  | { readonly _tag: "offline" };

const isRpcClientError = Schema.is(RpcClientError);

/**
 * The link to the server: pairing, the ticket handshake, the socket, and
 * reconnecting with backoff. Every socket is opened with a fresh single-use
 * ticket, so a refused handshake costs nothing: the next attempt asks for a new
 * ticket, and the server's own `NotAuthenticated` from the ticket route is
 * what tells the client it is no longer paired.
 */
export class Connection extends Context.Service<
  Connection,
  {
    readonly state: Readable<ConnectionState>;
    /**
     * Pairs with a code from `j3-bots pair` or another client's Devices screen,
     * typed in any case, with spaces or dashes.
     */
    readonly pair: (input: {
      readonly code: string;
      readonly deviceName: string;
    }) => Effect.Effect<void, PairingFailed>;
    /**
     * Deletes this device's credential from storage, then lets go of it, so a
     * failure leaves the device as it was. It revokes nothing: `reason` says
     * whether the server still lists the device.
     */
    readonly forget: (
      reason: Exclude<UnpairedReason, "new">,
    ) => Effect.Effect<void, CredentialStorageError>;
    /** Skips the wait before the next attempt, and leaves `incompatible` and `storage-failed`. */
    readonly reconnectNow: Effect.Effect<void>;
    /**
     * Runs `use` on the open socket, waiting for one if there is none. If the
     * socket drops before `use` finishes, runs it again on the next socket, so
     * `use` must be safe to repeat: a command with a fixed command id, or a read.
     * Fails with `NotPaired` once the device has no credential.
     */
    readonly call: <A, E>(
      use: (client: J3RpcClient) => Effect.Effect<A, E | RpcClientError>,
    ) => Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired>;
    /**
     * Runs `use` on every socket from the moment it opens, interrupting it when
     * the socket closes. If `use` dies, it waits for the next socket. Ends only
     * when `use` fails with an error of its own.
     */
    readonly eachSession: <E>(
      use: (client: J3RpcClient) => Effect.Effect<void, E | RpcClientError>,
    ) => Effect.Effect<never, Exclude<E, RpcClientError>>;
    /**
     * The device token, for the HTTP routes that take it as a bearer: files.
     * Waits while the credential is read; fails with `NotPaired` without one.
     */
    readonly bearer: Effect.Effect<Redacted.Redacted<DeviceToken>, NotPaired>;
    /** This device's id, as the server knows it. Fails with `NotPaired` without a credential. */
    readonly deviceId: Effect.Effect<DeviceId, NotPaired>;
    /**
     * Waits until a socket is open, which means the server answers and takes
     * this device's credential. Fails with `NotPaired` once there is none.
     */
    readonly awaitConnected: Effect.Effect<void, NotPaired>;
  }
>()("@j3-bots/client-runtime/connection/Connection") {}

export const layer = Layer.effect(
  Connection,
  Effect.gen(function* () {
    const { origin } = yield* ServerAddress;
    const store = yield* CredentialStore;
    const network = yield* Network;
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const policy = yield* ReconnectPolicy;
    const http = yield* ServerHttp.make(origin, policy.requestTimeout);

    const state = new Cell<ConnectionState>({ _tag: "starting" });
    const slot = yield* SubscriptionRef.make<Slot>({ _tag: "closed" });
    const credential = yield* SubscriptionRef.make<Credential>({ _tag: "loading" });
    const networkStatus = yield* SubscriptionRef.make(yield* network.status);
    // Asks the supervisor to try now. One pending wake is enough.
    const wakes = yield* Queue.sliding<void>(1);
    let generation = 0;

    yield* network.changes.pipe(
      Stream.runForEach((status) =>
        SubscriptionRef.set(networkStatus, status).pipe(Effect.andThen(Queue.offer(wakes, void 0))),
      ),
      Effect.forkScoped,
    );

    const firstChange = <A>(
      ref: SubscriptionRef.SubscriptionRef<A>,
      predicate: (a: A) => boolean,
    ) => SubscriptionRef.changes(ref).pipe(Stream.filter(predicate), Stream.runHead, Effect.asVoid);

    const wake = Queue.take(wakes).pipe(Effect.asVoid);

    const sameCredential = (a: DeviceCredential, b: DeviceCredential) =>
      a.deviceId === b.deviceId && Redacted.value(a.token) === Redacted.value(b.token);

    // Another window paired or signed out: this one follows. A credential
    // that is gone was signed out; one that differs was paired anew.
    yield* store.changes.pipe(
      Stream.runForEach(() =>
        store.load.pipe(
          Effect.flatMap((loaded) =>
            SubscriptionRef.update(credential, (current): Credential => {
              if (Option.isNone(loaded)) {
                return current._tag === "paired" ? { _tag: "none", reason: "signed-out" } : current;
              }
              return current._tag === "paired" && sameCredential(current.credential, loaded.value)
                ? current
                : { _tag: "paired", credential: loaded.value };
            }),
          ),
          Effect.catchTag("CredentialStorageError", (error) =>
            Effect.logWarning("Another window changed the credential; it could not be read", error),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    /** Opens the socket and holds it until it closes. */
    const holdSocket = (url: string): Effect.Effect<AttemptOutcome> =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const hooks = RpcClient.ConnectionHooks.of({
          onConnect: Deferred.succeed(opened, void 0).pipe(Effect.asVoid),
          onDisconnect: Deferred.succeed(closed, void 0).pipe(Effect.asVoid),
        });
        const socket = yield* Socket.makeWebSocket(url, { openTimeout: policy.openTimeout }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
        );
        const protocol = yield* RpcClient.makeProtocolSocket({
          // One socket per attempt: the supervisor decides when to try again,
          // with a fresh ticket.
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
          pingTimeout: policy.pingTimeout,
        }).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provideService(RpcClient.ConnectionHooks, hooks),
          Effect.provide(RpcSerialization.layerJson),
        );
        const client = yield* RpcClient.make(J3Rpcs).pipe(
          Effect.provideService(RpcClient.Protocol, protocol),
        );
        const didOpen = yield* Deferred.await(opened).pipe(
          Effect.as(true),
          Effect.raceFirst(Deferred.await(closed).pipe(Effect.as(false))),
        );
        if (!didOpen) return { _tag: "unreachable" } as const;

        generation += 1;
        yield* SubscriptionRef.set(slot, {
          _tag: "open",
          session: { client, generation, closed },
        });
        state.set({ _tag: "connected" });
        yield* Deferred.await(closed);
        return { _tag: "dropped" } as const;
      }).pipe(Effect.ensuring(SubscriptionRef.set(slot, { _tag: "closed" })), Effect.scoped);

    /** One attempt: protocol check, ticket, socket. */
    const attempt = (paired: DeviceCredential): Effect.Effect<AttemptOutcome> =>
      Effect.gen(function* () {
        const info = yield* http.serverInfo;
        if (info.protocolVersion !== PROTOCOL_VERSION) {
          return { _tag: "incompatible", serverProtocol: info.protocolVersion } as const;
        }
        const grant = yield* http.socketTicket(paired.token);
        return yield* holdSocket(http.socketUrl(grant.ticket));
      }).pipe(
        Effect.catchTags({
          ServerUnreachable: () => Effect.succeed({ _tag: "unreachable" } as const),
          NotAuthenticated: () => Effect.succeed({ _tag: "revoked" } as const),
        }),
        // Pairing again or forgetting the device ends the attempt at once.
        Effect.raceFirst(
          firstChange(
            credential,
            (current) => current._tag !== "paired" || current.credential !== paired,
          ).pipe(Effect.as({ _tag: "credential-changed" } as const)),
        ),
        // So does losing the network. A socket can outlive it for a long time
        // without failing; the platform's word that it is gone is reliable.
        Effect.raceFirst(
          firstChange(networkStatus, (status) => status === "offline").pipe(
            Effect.as({ _tag: "offline" } as const),
          ),
        ),
      );

    const load = Effect.gen(function* () {
      while (true) {
        const loaded = yield* store.load.pipe(Effect.option);
        if (Option.isSome(loaded)) {
          const next: Credential = Option.match(loaded.value, {
            onNone: () => ({ _tag: "none", reason: "new" }),
            onSome: (stored) => ({ _tag: "paired", credential: stored }),
          });
          return yield* SubscriptionRef.set(credential, next);
        }
        state.set({ _tag: "storage-failed" });
        yield* wake;
      }
    });

    const supervise = Effect.gen(function* () {
      yield* load;
      let failures = 0;
      while (true) {
        const current = yield* SubscriptionRef.get(credential);
        if (current._tag !== "paired") {
          state.set({ _tag: "unpaired", reason: current._tag === "none" ? current.reason : "new" });
          yield* SubscriptionRef.set(slot, { _tag: "unpaired" });
          yield* firstChange(credential, (next) => next !== current);
          if ((yield* SubscriptionRef.get(credential))._tag === "paired") {
            yield* SubscriptionRef.set(slot, { _tag: "closed" });
          }
          failures = 0;
          continue;
        }
        if ((yield* SubscriptionRef.get(networkStatus)) === "offline") {
          state.set({ _tag: "offline" });
          yield* firstChange(networkStatus, (status) => status !== "offline").pipe(
            Effect.raceFirst(wake),
          );
          failures = 0;
          continue;
        }

        state.set({ _tag: "connecting", attempt: failures + 1 });
        const outcome = yield* attempt(current.credential);
        switch (outcome._tag) {
          case "credential-changed":
          case "offline":
            failures = 0;
            continue;
          case "revoked":
            yield* SubscriptionRef.set(credential, { _tag: "none", reason: "signed-out" });
            yield* store.clear.pipe(
              Effect.catchTag("CredentialStorageError", (error) =>
                Effect.logWarning("The revoked credential stays in storage", error),
              ),
            );
            continue;
          case "incompatible":
            state.set({ _tag: "incompatible", serverProtocol: outcome.serverProtocol });
            yield* wake.pipe(Effect.raceFirst(firstChange(credential, (next) => next !== current)));
            failures = 0;
            continue;
          case "unreachable":
          case "dropped": {
            // A socket that was open starts the count again.
            failures = outcome._tag === "dropped" ? 1 : failures + 1;
            const delay = backoffDelay(failures, policy, yield* Random.next);
            const retryAt = DateTime.addDuration(yield* DateTime.now, delay);
            state.set({ _tag: "waiting", reason: outcome._tag, attempt: failures, retryAt });
            const woken = yield* wake.pipe(
              Effect.raceFirst(firstChange(credential, (next) => next !== current)),
              Effect.as(true),
              Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.succeed(false) }),
            );
            if (woken) failures = 0;
            continue;
          }
        }
      }
    });
    yield* Effect.forkScoped(supervise);

    const pair = Effect.fn("Connection.pair")(function* (input: {
      readonly code: string;
      readonly deviceName: string;
    }) {
      const failed = (reason: PairingFailure) => new PairingFailed({ reason });
      const code = Schema.decodeOption(PairingCode)(normalizePairingCode(input.code));
      if (Option.isNone(code)) return yield* failed({ _tag: "invalid-code" });
      // The name is the application's, not the operator's: a bad one is a bug.
      const name = yield* Schema.decodeEffect(Label)(input.deviceName.trim()).pipe(Effect.orDie);

      const info = yield* http.serverInfo.pipe(
        Effect.mapError(() => failed({ _tag: "unreachable" })),
      );
      if (info.protocolVersion !== PROTOCOL_VERSION) {
        return yield* failed({
          _tag: "incompatible-server",
          serverProtocol: info.protocolVersion,
        });
      }
      const request: PairRequest = { code: code.value, name };
      const result = yield* http.pair(request).pipe(
        Effect.catchTags({
          Invalid: () => Effect.fail(failed({ _tag: "invalid-code" })),
          RateLimited: (error) =>
            Effect.fail(failed({ _tag: "rate-limited", retryAt: error.retryAt })),
          ServerUnreachable: () => Effect.fail(failed({ _tag: "unreachable" })),
        }),
      );
      const paired: DeviceCredential = {
        deviceId: result.deviceId,
        token: Redacted.make(result.token),
      };
      yield* store.save(paired).pipe(Effect.mapError(() => failed({ _tag: "storage-failed" })));
      yield* SubscriptionRef.set(credential, { _tag: "paired", credential: paired });
    });

    const forget = Effect.fn("Connection.forget")(function* (
      reason: Exclude<UnpairedReason, "new">,
    ) {
      yield* store.clear;
      yield* SubscriptionRef.set(credential, { _tag: "none", reason });
    });

    const awaitSession = (after: number) =>
      SubscriptionRef.changes(slot).pipe(
        Stream.filter(
          (current) =>
            current._tag === "unpaired" ||
            (current._tag === "open" && current.session.generation > after),
        ),
        Stream.runHead,
        Effect.flatMap((found) =>
          Option.isSome(found) && found.value._tag === "open"
            ? Effect.succeed(found.value.session)
            : Effect.fail(new NotPaired()),
        ),
      );

    const call = <A, E>(
      use: (client: J3RpcClient) => Effect.Effect<A, E | RpcClientError>,
    ): Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired> => {
      const run = (after: number): Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired> =>
        awaitSession(after).pipe(
          Effect.flatMap((session) =>
            use(session.client).pipe(
              Effect.asSome,
              Effect.catchIf(isRpcClientError, () => Effect.succeed(Option.none<A>())),
              // A request in flight when its socket closes may never be
              // answered: the socket's end decides, not the request's.
              Effect.raceFirst(Deferred.await(session.closed).pipe(Effect.as(Option.none<A>()))),
              Effect.flatMap(
                (answered): Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired> =>
                  Option.isSome(answered)
                    ? Effect.succeed(answered.value)
                    : run(session.generation),
              ),
            ),
          ),
        );
      return Effect.suspend(() => run(0));
    };

    const eachSession = <E>(
      use: (client: J3RpcClient) => Effect.Effect<void, E | RpcClientError>,
    ): Effect.Effect<never, Exclude<E, RpcClientError>> =>
      SubscriptionRef.changes(slot).pipe(
        Stream.switchMap((current) =>
          current._tag === "open"
            ? Stream.fromEffect(
                use(current.session.client).pipe(
                  Effect.catchIf(isRpcClientError, () => Effect.void),
                  // The server fails a request alone, with a generic defect. The
                  // subscription starts again on the next socket.
                  Effect.catchDefect((defect) =>
                    Effect.logWarning(
                      "A subscription failed; it resumes on the next socket",
                      defect,
                    ),
                  ),
                ),
              )
            : Stream.empty,
        ),
        Stream.runDrain,
        Effect.andThen(Effect.never),
      );

    const paired = SubscriptionRef.changes(credential).pipe(
      Stream.filter((current) => current._tag !== "loading"),
      Stream.runHead,
      Effect.flatMap((current) =>
        Option.isSome(current) && current.value._tag === "paired"
          ? Effect.succeed(current.value.credential)
          : Effect.fail(new NotPaired()),
      ),
    );

    return Connection.of({
      state,
      pair,
      forget,
      reconnectNow: Queue.offer(wakes, void 0).pipe(Effect.asVoid),
      call,
      eachSession,
      bearer: Effect.map(paired, (current) => current.token),
      deviceId: Effect.map(paired, (current) => current.deviceId),
      awaitConnected: awaitSession(0).pipe(Effect.asVoid),
    });
  }),
);
