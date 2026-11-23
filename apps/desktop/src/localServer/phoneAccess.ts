// SPDX-License-Identifier: AGPL-3.0-or-later
import { pairingOrigins, type ServerOrigin } from "@j3-bots/contracts";
import {
  type LocalPairingLink,
  PhoneAccess,
  type PhoneAccessChange,
  type PhoneAccessRequest,
} from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { DesktopSettings } from "../settings.ts";
import type { Supervisor } from "./supervisor.ts";

// Phones on this computer's network reaching the server it runs ("Usar pelo
// celular"). The operator's choice is kept in the settings; where the server
// listens is decided at each start of it, through the supervisor's one start
// path:
//
// - off: on 127.0.0.1, which nothing but this computer reaches;
// - on: on `lan`, every IPv4 interface, the server's own setting, which serves
//   private addresses only; while an interface has a public address, which
//   `lan` would listen on too, on 127.0.0.1, and that is why;
// - on, after a start on `lan` that ended without the server answering: on
//   127.0.0.1, with what the server said, until the operator tries again.
//   The app is never left without its server.
//
// Changing it starts the server again, which stops the work bots have
// running: the operator is asked first while any has. Devices paired over
// the network stay paired while it is off; they reach the server again once
// it is back on.
//
// The network is read at each start of the server, at each change of the
// choice, and again (only the addresses to show) as the page asks and as the
// system wakes. Nothing watches it in between: a public address that appears
// while the server listens on `lan` is refused by the server itself, which
// checks the address each connection reached.

/** Where the server listens: every IPv4 interface (`lan`), or this computer alone. */
export type ListenHost = "lan" | "127.0.0.1";

const LOOPBACK = "127.0.0.1";
/** The longest `detail` the page is given, as the bridge bounds it. */
const DETAIL = 4096;

/** Where the server listens, as its last start decided it, and what came of it. */
interface Listening {
  /** The operator's choice, as the settings keep it. */
  readonly on: boolean;
  /**
   * Where the last start this run of the app made put the server; `null`
   * before one, as for a server an earlier run left running and this one
   * took over.
   */
  readonly host: ListenHost | null;
  /** The last start was on `lan`, and the server has not answered yet. */
  readonly lanPending: boolean;
  /** Why the last start on `lan` did not answer: the server stays on 127.0.0.1 until the operator tries again. */
  readonly fellBack: Option.Option<string>;
  /** A public address kept the last start, or the choice, on 127.0.0.1. */
  readonly publicAddress: boolean;
  /** The private origins phones reach the server at, once it answered on `lan`; `null` until then. */
  readonly origins: ReadonlyArray<ServerOrigin> | null;
}

/** Phone access, as the page and the tray are told it. */
const phoneAccessOf = (listening: Listening): PhoneAccess => {
  if (!listening.on) return { on: false, origins: [] };
  if (Option.isSome(listening.fellBack)) {
    return {
      on: true,
      origins: [],
      refusedReason: "unavailable",
      detail: listening.fellBack.value.slice(0, DETAIL),
    };
  }
  if (listening.publicAddress) return { on: true, origins: [], refusedReason: "public-address" };
  // Being moved to the network: there is nothing to show yet.
  if (listening.origins === null) return { on: true, origins: [] };
  if (listening.origins.length === 0) {
    return { on: true, origins: [], refusedReason: "no-network" };
  }
  return { on: true, origins: listening.origins.slice(0, 16) };
};

const samePhoneAccess = Schema.toEquivalence(PhoneAccess);

/**
 * What decides where each start of the server listens, made before the
 * supervisor that starts it, whose launches ask `hostForLaunch`.
 */
interface PhoneListening {
  /** Where this start of the server listens. */
  readonly hostForLaunch: Effect.Effect<ListenHost>;
  /** What `serve` follows and changes. */
  readonly state: SubscriptionRef.SubscriptionRef<Listening>;
  /** The first public IPv4 address of this computer, if any, read now. */
  readonly publicAddress: Effect.Effect<Option.Option<string>>;
}

export const listening = Effect.fn("PhoneAccess.listening")(function* (options: {
  /** The first public IPv4 address of this computer's interfaces, if any, read now. */
  readonly publicAddress: Effect.Effect<Option.Option<string>>;
}) {
  const settings = yield* DesktopSettings;
  const state = yield* SubscriptionRef.make<Listening>({
    on: (yield* settings.get).phoneAccess,
    host: null,
    lanPending: false,
    fellBack: Option.none(),
    publicAddress: false,
    origins: null,
  });

  const hostForLaunch = Effect.gen(function* () {
    const on = (yield* settings.get).phoneAccess;
    const before = yield* SubscriptionRef.get(state);
    const stay = (publicAddress: boolean): Listening => ({
      on,
      host: LOOPBACK,
      lanPending: false,
      fellBack: on ? before.fellBack : Option.none(),
      publicAddress,
      origins: null,
    });
    if (!on || Option.isSome(before.fellBack)) {
      yield* SubscriptionRef.set(state, stay(false));
      return LOOPBACK;
    }
    const exposed = yield* options.publicAddress;
    if (Option.isSome(exposed)) {
      yield* Effect.logWarning(
        "This computer has a public address, so phones cannot reach the bots: the server listens on 127.0.0.1",
        exposed.value,
      );
      yield* SubscriptionRef.set(state, stay(true));
      return LOOPBACK;
    }
    yield* SubscriptionRef.set(state, {
      on,
      host: "lan",
      lanPending: true,
      fellBack: Option.none(),
      publicAddress: false,
      origins: null,
    });
    return "lan" as const;
  });

  return {
    hostForLaunch,
    state,
    publicAddress: options.publicAddress,
  } satisfies PhoneListening;
});

export interface PhoneAccessOptions {
  readonly listening: PhoneListening;
  readonly supervisor: Pick<Supervisor, "state" | "changes" | "ready" | "retry">;
  /**
   * Stops the server and starts it again, where it should listen now,
   * while the bots still live on this computer.
   */
  readonly restart: Effect.Effect<void>;
}

/** Follows the server's starts, and turns phone access on and off, for as long as the scope lasts. */
export const serve = Effect.fn("PhoneAccess.serve")(function* (options: PhoneAccessOptions) {
  const settings = yield* DesktopSettings;
  const scope = yield* Effect.scope;
  const { state, publicAddress } = options.listening;
  const { supervisor } = options;
  const oneAtATime = yield* Semaphore.make(1);

  /** The server, while it answers. */
  const answering = Effect.gen(function* () {
    if ((yield* supervisor.state).state !== "ready") return Option.none();
    return yield* supervisor.ready.pipe(Effect.option);
  });

  /** The private origins phones reach the server at, read from it now; `null` while it does not answer on `lan`. */
  const originsNow = Effect.gen(function* () {
    const server = yield* answering;
    if (Option.isNone(server)) return Option.none<ReadonlyArray<ServerOrigin> | null>();
    const status = yield* server.value.admin.status().pipe(Effect.option);
    if (Option.isNone(status)) return Option.none<ReadonlyArray<ServerOrigin> | null>();
    return Option.some(
      status.value.listener.address === LOOPBACK
        ? null
        : pairingOrigins(status.value.origins ?? []).slice(0, 16),
    );
  });

  /** The server answered: where it listens, and the origins phones reach it at. */
  const answered = Effect.gen(function* () {
    const server = yield* answering;
    if (Option.isNone(server)) return;
    const status = yield* server.value.admin.status().pipe(Effect.option);
    if (Option.isNone(status)) return;
    const onLan = status.value.listener.address !== LOOPBACK;
    const before = yield* SubscriptionRef.get(state);
    const origins = onLan ? pairingOrigins(status.value.origins ?? []).slice(0, 16) : null;
    yield* SubscriptionRef.set(state, {
      ...before,
      host: onLan ? "lan" : LOOPBACK,
      lanPending: false,
      origins,
    });
    // A server an earlier run of the app left running, and this one took
    // over, may listen where the operator no longer wants it to: it is
    // started again, where it should.
    if (before.host === null) {
      const wantsLan = before.on && Option.isNone(yield* publicAddress);
      if (wantsLan !== onLan) {
        yield* Effect.logInfo("The server taken over listens elsewhere than chosen; restarting it");
        yield* options.restart.pipe(Effect.forkIn(scope));
      }
    }
  });

  /** The server stopped or failed before it answered: a start on `lan` falls back to 127.0.0.1. */
  const didNotAnswer = Effect.fn("PhoneAccess.didNotAnswer")(function* (
    reason: string | undefined,
  ) {
    const before = yield* SubscriptionRef.get(state);
    if (!before.lanPending) return;
    const why = reason ?? "The server did not start on the network.";
    yield* Effect.logWarning(
      "The server did not start on the network; it starts on 127.0.0.1 instead",
      why,
    );
    yield* SubscriptionRef.set(state, {
      ...before,
      lanPending: false,
      fellBack: Option.some(why),
      origins: null,
    });
    yield* supervisor.retry;
  });

  yield* supervisor.changes.pipe(
    Stream.runForEach((server) => {
      switch (server.state) {
        case "ready":
          return answered;
        case "restarting":
        case "failed":
          return didNotAnswer(server.reason);
        case "stopped":
          return SubscriptionRef.update(state, (now) => ({
            ...now,
            lanPending: false,
            origins: null,
          }));
        case "starting":
          return Effect.void;
      }
    }),
    Effect.forkIn(scope),
  );

  const current = SubscriptionRef.get(state).pipe(Effect.map(phoneAccessOf));

  /** Phone access, its addresses read from the server again. */
  const refresh = Effect.gen(function* () {
    const before = yield* SubscriptionRef.get(state);
    if (before.on && before.host === "lan" && !before.lanPending) {
      const origins = yield* originsNow;
      if (Option.isSome(origins)) {
        yield* SubscriptionRef.update(state, (now) => ({ ...now, origins: origins.value }));
      }
    }
    return yield* current;
  });

  const set = (request: PhoneAccessRequest): Effect.Effect<PhoneAccessChange> =>
    oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        const before = yield* SubscriptionRef.get(state);
        const { mode } = yield* settings.get;
        const exposed = request.on ? Option.isSome(yield* publicAddress) : false;
        const target: ListenHost = request.on && !exposed ? "lan" : LOOPBACK;
        const server = (yield* supervisor.state).state;
        // A server that runs moves when it listens elsewhere than it should:
        // asked on again after it fell back, it tries the network again. One
        // that is stopped or failed starts where the choice puts it, once it
        // starts again.
        const moves =
          mode === "local" && server !== "stopped" && server !== "failed" && target !== before.host;
        if (moves && !request.stopWork) {
          const bots = yield* answering.pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(0),
                onSome: (server) => server.admin.runningWork.pipe(Effect.orElseSucceed(() => 0)),
              }),
            ),
          );
          if (bots > 0) return { _tag: "work-running", bots } as const;
        }
        const saved = yield* settings
          .update((now) => ({ ...now, phoneAccess: request.on }))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Saving phone access failed", error).pipe(Effect.as(false)),
            ),
          );
        if (!saved) return { _tag: "not-saved", access: phoneAccessOf(before) } as const;
        yield* SubscriptionRef.set(state, {
          ...before,
          on: request.on,
          fellBack: Option.none(),
          publicAddress: exposed && target === before.host,
          origins: moves ? null : before.origins,
        });
        if (moves) yield* options.restart.pipe(Effect.forkIn(scope));
        // Where it stays, the addresses are read again: asking again is how
        // the operator checks a network they just joined.
        return { _tag: "changed", access: moves ? yield* current : yield* refresh } as const;
      }),
    );

  /**
   * A pairing code for a phone, with the private origins it reaches the
   * server at: none while phones cannot reach it. `unlock` lifts a lock
   * that wrong codes set, as the operator is at this computer.
   */
  const pairingLink = Effect.fn("PhoneAccess.pairingLink")(function* (unlock: boolean) {
    if ((yield* settings.get).mode !== "local") return { _tag: "unavailable" } as const;
    const server = yield* answering;
    if (Option.isNone(server)) return { _tag: "unavailable" } as const;
    const access = yield* refresh;
    const [first, ...others] = access.origins;
    if (first === undefined) return { _tag: "phone-access-off" } as const;
    const offer = yield* server.value.admin.pairing(unlock).pipe(Effect.option);
    if (Option.isNone(offer)) return { _tag: "unavailable" } as const;
    return offer.value._tag === "locked"
      ? offer.value
      : ({
          _tag: "granted",
          code: offer.value.code,
          expiresAt: offer.value.expiresAt,
          origins: [first, ...others],
        } satisfies LocalPairingLink);
  });

  /** The operator tries the server again: a start on `lan` that fell back is tried again too. */
  const tryNetworkAgain = SubscriptionRef.update(state, (now) => ({
    ...now,
    fellBack: Option.none(),
  }));

  return {
    current,
    tryNetworkAgain,
    changes: SubscriptionRef.changes(state).pipe(
      Stream.map(phoneAccessOf),
      Stream.changesWith(samePhoneAccess),
    ),
    refresh,
    set,
    pairingLink,
  } as const;
});
