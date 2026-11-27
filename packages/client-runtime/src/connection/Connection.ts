// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DeviceId,
  type DeviceToken,
  J3Rpcs,
  Label,
  normalizePairingCode,
  PairingCode,
  PROTOCOL_VERSION,
  type PairRequest,
  type ServerInfo,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
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
  type CredentialEnded,
  type CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
  Lifecycle,
  type LifecycleState,
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
  /**
   * The app is in the background, where the server pushes to the device
   * instead. No socket is open; the client connects again when it returns.
   */
  | { readonly _tag: "background" }
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
  /**
   * The server speaks another protocol version, so no socket opens. Its
   * release version says which side is behind; the update routes, which are
   * outside the protocol, can still bring the server forward. Nothing is
   * retried until `reconnectNow`.
   */
  | {
      readonly _tag: "incompatible";
      readonly serverProtocol: number;
      readonly serverVersion: string;
    }
  /** The credential storage failed. Nothing is retried until `reconnectNow`. */
  | { readonly _tag: "storage-failed" };

/**
 * Why the client has no credential. `new`: it never had one. `signed-out`: the
 * server ended this device's access, or it was signed out here or in another
 * window. `still-listed`: it signed out here without the server confirming
 * it, which may list it until another device revokes it.
 */
export type UnpairedReason = "new" | "signed-out" | "still-listed";

/**
 * What forgetting a pairing did. `paired-anew`: storage holds a pairing made
 * since, here or in another window, which stays, and this window follows it.
 */
export type ForgetResult = "forgotten" | "paired-anew";

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
  Schema.TaggedStruct("incompatible-server", {
    serverProtocol: Schema.Int,
    serverVersion: Schema.String,
  }),
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
   * How long a request may take to answer: an HTTP request, before the server
   * counts as unreachable, and a read on the socket that has no other end,
   * such as the usage view's, before it counts as failed. A file transfer is
   * also given time for its bytes: see `transferDeadline`.
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

/** One open socket. `generation` grows with every socket, so a retry can wait for a newer one. */
interface Session {
  readonly client: J3RpcClient;
  /** The pairing the socket was opened with: the server acts on its behalf. */
  readonly pairing: DeviceId;
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
  | {
      readonly _tag: "incompatible";
      readonly serverProtocol: number;
      readonly serverVersion: string;
    }
  | { readonly _tag: "credential-changed" }
  /** The platform reported the network gone. */
  | { readonly _tag: "offline" }
  /** The app went to the background. */
  | { readonly _tag: "background" };

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
     * Keeps a credential this device was given without a code, as the desktop
     * app's own server signs the computer it runs on in, then follows it as
     * after pairing.
     */
    readonly adopt: (credential: DeviceCredential) => Effect.Effect<void, CredentialStorageError>;
    /**
     * The pairing this window follows: its device id, or null while the
     * credential is read and when there is none. It changes in the same step
     * as the credential this window holds. What the client keeps on the
     * device belongs to the pairing that wrote it.
     */
    readonly pairing: Readable<DeviceId | null>;
    /**
     * Deletes the credential of `pairing` from storage, then lets go of it, so
     * a failure leaves the device as it was. It revokes nothing: `reason` says
     * whether the server still lists the device. A pairing made since, here
     * or in another window, is left in storage, and this window follows it,
     * even when word of it has not reached this window yet: the result says so.
     */
    readonly forget: (
      reason: Exclude<UnpairedReason, "new">,
      pairing: DeviceId | null,
    ) => Effect.Effect<ForgetResult, CredentialStorageError>;
    /**
     * The pairing the device's credential storage holds now, read afresh:
     * another window may have changed it since this one last heard.
     */
    readonly storedPairing: Effect.Effect<DeviceId | null, CredentialStorageError>;
    /**
     * Whether the device's credential storage still holds `pairing`, read
     * afresh. A pairing that ended never returns, so after a transaction
     * guarded by `pairing` was refused, this tells whether the pairing ended
     * or another window changed a record. Storage that cannot be read counts
     * as ended, so nothing is written meanwhile.
     */
    readonly stillPaired: (pairing: DeviceId) => Effect.Effect<boolean>;
    /** Skips the wait before the next attempt, and leaves `incompatible` and `storage-failed`. */
    readonly reconnectNow: Effect.Effect<void>;
    /**
     * Whether the server said that `pairing` ended: it refused that pairing's
     * credential to this window, or to another window, which deleted the
     * credential and left the refusal in its place. A credential another
     * window deleted without one was only signed out here.
     */
    readonly endedOnServer: (pairing: DeviceId) => Effect.Effect<boolean>;
    /**
     * Runs `use` on the open socket, waiting for one if there is none. If the
     * socket drops before `use` finishes, runs it again on the next socket, so
     * `use` must be safe to repeat: a command with a fixed command id, or a read.
     * It belongs to the pairing it started under, or, started while the
     * credential is read, to that of the first socket: it fails with
     * `NotPaired` once the device has no credential, or a socket of another
     * pairing opens.
     */
    readonly call: <A, E>(
      use: (client: J3RpcClient) => Effect.Effect<A, E | RpcClientError>,
    ) => Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired>;
    /**
     * Runs `use` on every socket from the moment it opens, interrupting it when
     * the socket closes, with the pairing the socket was opened with. If `use`
     * dies, it waits for the next socket. Ends only when `use` fails with an
     * error of its own.
     */
    readonly eachSession: <E>(
      use: (client: J3RpcClient, pairing: DeviceId) => Effect.Effect<void, E | RpcClientError>,
    ) => Effect.Effect<never, Exclude<E, RpcClientError>>;
    /**
     * The device token of `pairing`, for the HTTP routes that take it as a
     * bearer: files. Waits while the credential is read; fails with
     * `NotPaired` unless this window holds `pairing`'s credential.
     */
    readonly bearer: (
      pairing: DeviceId,
    ) => Effect.Effect<Redacted.Redacted<DeviceToken>, NotPaired>;
    /**
     * The address of the socket at `path` beside the RPC socket, for the
     * credential this window holds now, with a fresh one-use ticket and
     * `query`: the media socket's. Fails with `NotPaired` without a
     * credential, or when the server refuses it, which the RPC socket finds
     * out on its own; with `ServerUnreachable` when no ticket could be had.
     */
    readonly socketAddress: (
      path: string,
      query: Readonly<Record<string, string>>,
    ) => Effect.Effect<string, NotPaired | ServerHttp.ServerUnreachable>;
    /**
     * What the server said of itself when this window last reached it, as it
     * opened a socket: null before, while this device is not paired, and
     * against a server of another protocol. It names what the server offers
     * beside the protocol, as the diagnostics zip, which a client offers only
     * then.
     */
    readonly server: Readable<ServerInfo | null>;
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
    const lifecycle = yield* Lifecycle;
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const policy = yield* ReconnectPolicy;
    const http = yield* ServerHttp.make(origin, policy.requestTimeout);

    const state = new Cell<ConnectionState>({ _tag: "starting" });
    const slot = yield* SubscriptionRef.make<Slot>({ _tag: "closed" });
    const credential = yield* SubscriptionRef.make<Credential>({ _tag: "loading" });
    const pairing = new Cell<DeviceId | null>(null);
    const server = new Cell<ServerInfo | null>(null);
    /**
     * Changes the credential this window holds, and the pairing it follows
     * with it, in one step: nothing reads one changed and the other not.
     */
    const follow = (next: (current: Credential) => Credential) =>
      SubscriptionRef.updateEffect(credential, (current) =>
        Effect.sync(() => {
          const followed = next(current);
          pairing.set(followed._tag === "paired" ? followed.credential.deviceId : null);
          return followed;
        }),
      );
    const networkStatus = yield* SubscriptionRef.make(yield* network.status);
    const lifecycleState = yield* SubscriptionRef.make<LifecycleState>(yield* lifecycle.state);
    // Asks the supervisor to try now. One pending wake is enough.
    const wakes = yield* Queue.sliding<void>(1);
    let generation = 0;
    // The pairings whose credential the server refused to this window.
    const refused = new Set<DeviceId>();

    yield* network.changes.pipe(
      Stream.runForEach((status) =>
        SubscriptionRef.set(networkStatus, status).pipe(Effect.andThen(Queue.offer(wakes, void 0))),
      ),
      Effect.forkScoped,
    );
    yield* lifecycle.changes.pipe(
      Stream.runForEach((next) => SubscriptionRef.set(lifecycleState, next)),
      Effect.forkScoped,
    );

    const firstChange = <A>(
      ref: SubscriptionRef.SubscriptionRef<A>,
      predicate: (a: A) => boolean,
    ) => SubscriptionRef.changes(ref).pipe(Stream.filter(predicate), Stream.runHead, Effect.asVoid);

    const wake = Queue.take(wakes).pipe(Effect.asVoid);
    const toBackground = firstChange(lifecycleState, (next) => next === "background");

    const sameCredential = (a: DeviceCredential, b: DeviceCredential) =>
      a.deviceId === b.deviceId && Redacted.value(a.token) === Redacted.value(b.token);

    /**
     * Deletes `ended` from storage, with the server's refusal when it is why,
     * and follows what is left: nothing, or a pairing another window made
     * after this one last read the credential.
     */
    const end = (
      ended: DeviceCredential,
      reason: Exclude<UnpairedReason, "new">,
      endedWhere: CredentialEnded,
    ) =>
      store.clear(ended, endedWhere).pipe(
        Effect.flatMap((left) => {
          const newer = Option.filter(left, (found) => !sameCredential(found, ended));
          return follow(() =>
            Option.match(newer, {
              onNone: (): Credential => ({ _tag: "none", reason }),
              onSome: (found): Credential => ({ _tag: "paired", credential: found }),
            }),
          ).pipe(Effect.as<ForgetResult>(Option.isSome(newer) ? "paired-anew" : "forgotten"));
        }),
      );

    // Another window paired or signed out: this one follows. A credential
    // that is gone was signed out; one that differs was paired anew.
    yield* store.changes.pipe(
      Stream.runForEach(() =>
        store.load.pipe(
          Effect.flatMap((loaded) =>
            follow((current): Credential => {
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
    const holdSocket = (url: string, paired: DeviceId): Effect.Effect<AttemptOutcome> =>
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
          session: { client, pairing: paired, generation, closed },
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
          server.set(null);
          return {
            _tag: "incompatible",
            serverProtocol: info.protocolVersion,
            serverVersion: info.version,
          } as const;
        }
        server.set(info);
        const grant = yield* http.socketTicket(paired.token);
        return yield* holdSocket(http.socketUrl(grant.ticket), paired.deviceId);
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
        // And going to the background, where the server pushes instead.
        Effect.raceFirst(toBackground.pipe(Effect.as({ _tag: "background" } as const))),
      );

    /** Reads the credential and follows it, unless storage fails: succeeds with whether it could. */
    const tryLoad = store.load.pipe(
      Effect.option,
      Effect.flatMap((loaded) =>
        Option.isNone(loaded)
          ? Effect.succeed(false)
          : follow(() =>
              Option.match(loaded.value, {
                onNone: (): Credential => ({ _tag: "none", reason: "new" }),
                onSome: (stored): Credential => ({ _tag: "paired", credential: stored }),
              }),
            ).pipe(Effect.as(true)),
      ),
    );

    const load = Effect.gen(function* () {
      while ((yield* SubscriptionRef.get(credential))._tag === "loading") {
        if (yield* tryLoad) return;
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
          // Nothing of the server is offered to a device it no longer knows.
          server.set(null);
          yield* SubscriptionRef.set(slot, { _tag: "unpaired" });
          yield* firstChange(credential, (next) => next !== current);
          if ((yield* SubscriptionRef.get(credential))._tag === "paired") {
            yield* SubscriptionRef.set(slot, { _tag: "closed" });
          }
          failures = 0;
          continue;
        }
        if ((yield* SubscriptionRef.get(lifecycleState)) === "background") {
          state.set({ _tag: "background" });
          // Signing out needs no socket, and is not left waiting for the app's return.
          yield* firstChange(lifecycleState, (next) => next === "foreground").pipe(
            Effect.raceFirst(firstChange(credential, (next) => next !== current)),
          );
          failures = 0;
          continue;
        }
        if ((yield* SubscriptionRef.get(networkStatus)) === "offline") {
          state.set({ _tag: "offline" });
          // Signing out, here or in another window, needs no network.
          yield* firstChange(networkStatus, (status) => status !== "offline").pipe(
            Effect.raceFirst(wake),
            Effect.raceFirst(firstChange(credential, (next) => next !== current)),
            Effect.raceFirst(toBackground),
          );
          failures = 0;
          continue;
        }

        state.set({ _tag: "connecting", attempt: failures + 1 });
        const outcome = yield* attempt(current.credential);
        switch (outcome._tag) {
          case "credential-changed":
          case "offline":
          case "background":
            failures = 0;
            continue;
          case "revoked":
            // The server refused this credential. The refusal may come late,
            // after another window paired anew: that pairing stays.
            refused.add(current.credential.deviceId);
            yield* end(current.credential, "signed-out", "refused").pipe(
              Effect.catchTag("CredentialStorageError", (error) =>
                Effect.logWarning("The revoked credential stays in storage", error).pipe(
                  Effect.andThen(follow(() => ({ _tag: "none", reason: "signed-out" }))),
                ),
              ),
            );
            continue;
          case "incompatible":
            state.set({
              _tag: "incompatible",
              serverProtocol: outcome.serverProtocol,
              serverVersion: outcome.serverVersion,
            });
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
              Effect.raceFirst(toBackground),
              Effect.as(true),
              Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.succeed(false) }),
            );
            if (woken) failures = 0;
            continue;
          }
        }
      }
    });
    // Read once before anything else starts, so every store begins with the
    // pairing this window follows. Storage that fails is read again by `load`.
    yield* tryLoad;
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
          serverVersion: info.version,
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
      yield* follow(() => ({ _tag: "paired", credential: paired }));
    });

    const adopt = Effect.fn("Connection.adopt")(function* (given: DeviceCredential) {
      yield* store.save(given);
      yield* follow(() => ({ _tag: "paired", credential: given }));
    });

    const forget = Effect.fn("Connection.forget")(function* (
      reason: Exclude<UnpairedReason, "new">,
      pairing: DeviceId | null,
    ) {
      const current = yield* SubscriptionRef.get(credential);
      if (current._tag !== "paired") {
        // This window let go of its credential already, but storage decides:
        // another window's pairing may be there before word of it arrived
        // here, or the credential that ended may still be there.
        const stored = yield* store.load;
        if (Option.isSome(stored) && stored.value.deviceId === pairing) {
          return yield* end(stored.value, reason, "here");
        }
        return yield* follow(() =>
          Option.match(stored, {
            onNone: (): Credential => ({ _tag: "none", reason }),
            onSome: (found): Credential => ({ _tag: "paired", credential: found }),
          }),
        ).pipe(Effect.as<ForgetResult>(Option.isSome(stored) ? "paired-anew" : "forgotten"));
      }
      // This window already follows a pairing made since: it stays.
      if (current.credential.deviceId !== pairing) return "paired-anew";
      return yield* end(current.credential, reason, "here");
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
      const run = (
        after: number,
        bound: DeviceId | null,
      ): Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired> =>
        awaitSession(after).pipe(
          Effect.flatMap((session) => {
            if (bound !== null && session.pairing !== bound) return Effect.fail(new NotPaired());
            return use(session.client).pipe(
              Effect.asSome,
              Effect.catchIf(isRpcClientError, () => Effect.succeed(Option.none<A>())),
              // Closing the socket here, offline or for another credential,
              // interrupts what is in flight: that is no answer either.
              Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.succeed(Option.none<A>())),
              // A request in flight when its socket closes may never be
              // answered: the socket's end decides, not the request's.
              Effect.raceFirst(Deferred.await(session.closed).pipe(Effect.as(Option.none<A>()))),
              Effect.flatMap(
                (answered): Effect.Effect<A, Exclude<E, RpcClientError> | NotPaired> =>
                  Option.isSome(answered)
                    ? Effect.succeed(answered.value)
                    : run(session.generation, session.pairing),
              ),
            );
          }),
        );
      return Effect.suspend(() => run(0, pairing.get()));
    };

    const eachSession = <E>(
      use: (client: J3RpcClient, pairing: DeviceId) => Effect.Effect<void, E | RpcClientError>,
    ): Effect.Effect<never, Exclude<E, RpcClientError>> =>
      SubscriptionRef.changes(slot).pipe(
        Stream.switchMap((current) =>
          current._tag === "open"
            ? Stream.fromEffect(
                use(current.session.client, current.session.pairing).pipe(
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

    const storedPairing = store.load.pipe(
      Effect.map((stored) => Option.getOrNull(Option.map(stored, (found) => found.deviceId))),
    );

    return Connection.of({
      state,
      pairing,
      server,
      pair,
      adopt,
      forget,
      storedPairing,
      stillPaired: Effect.fn("Connection.stillPaired")((held: DeviceId) =>
        storedPairing.pipe(
          Effect.map((stored) => stored === held),
          Effect.catchTag("CredentialStorageError", (error) =>
            Effect.logWarning("The device's pairing could not be read", error).pipe(
              Effect.as(false),
            ),
          ),
        ),
      ),
      endedOnServer: Effect.fn("Connection.endedOnServer")((held: DeviceId) =>
        refused.has(held)
          ? Effect.succeed(true)
          : store.refusedPairing.pipe(
              Effect.map((found) => Option.contains(found, held)),
              Effect.catchTag("CredentialStorageError", (error) =>
                Effect.logWarning(
                  "Whether the server refused the device could not be read",
                  error,
                ).pipe(Effect.as(false)),
              ),
            ),
      ),
      reconnectNow: Queue.offer(wakes, void 0).pipe(Effect.asVoid),
      call,
      eachSession,
      bearer: Effect.fn("Connection.bearer")(function* (held: DeviceId) {
        const current = yield* paired;
        if (current.deviceId !== held) return yield* new NotPaired();
        return current.token;
      }),
      socketAddress: Effect.fn("Connection.socketAddress")(function* (path, query) {
        const current = yield* paired;
        const grant = yield* http
          .socketTicket(current.token)
          .pipe(Effect.catchTag("NotAuthenticated", () => Effect.fail(new NotPaired())));
        return http.socketUrl(grant.ticket, path, query);
      }),
      deviceId: Effect.map(paired, (current) => current.deviceId),
      awaitConnected: awaitSession(0).pipe(Effect.asVoid),
    });
  }),
);
