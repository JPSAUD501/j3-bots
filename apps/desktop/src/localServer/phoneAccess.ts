// SPDX-License-Identifier: AGPL-3.0-or-later
import { pairingOrigins, type ServerOrigin } from "@j3-bots/contracts";
import {
  type LocalPairingLink,
  PhoneAccess,
  type PhoneAccessChange,
  type PhoneAccessRequest,
} from "@j3-bots/desktop-bridge";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { isPrivateAddress } from "@j3-bots/server/network";
import { DesktopSettings } from "../settings.ts";
import type { StatusReply } from "./adminChannel.ts";
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
// Each time the server answers, where it listens is compared with where the
// choice puts it now, and a server that listens elsewhere, as one an earlier
// run of the app left running, or one launched while the choice changed, is
// started again where it should, once no bot has work running there: that
// restart is no one's choice to stop the work for, so it waits for the work
// to end.
//
// Changing it starts the server again, which stops the work bots have
// running: the operator is asked first while any has, or while the server
// cannot say. The move is one step with the changes of where the bots live
// (`whileLocal`), so the choice is never kept, nor the server moved, once
// they run elsewhere. Devices paired over the network stay paired while it is
// off; they reach the server again once it is back on.
//
// The network is read at each start of the server, at each change of the
// choice, and again (only the addresses to show) as the page asks and as the
// system wakes. Nothing watches it in between: a public address that appears
// while the server listens on `lan` is refused by the server itself, which
// checks the address each new connection reached, while it keeps listening.

/** Where the server listens: every IPv4 interface (`lan`), or this computer alone. */
export type ListenHost = "lan" | "127.0.0.1";

const LOOPBACK = "127.0.0.1";
/** The longest `detail` the page is given, as the bridge bounds it. */
const DETAIL = 4096;
/** How often a server that listens elsewhere than chosen is asked again whether bots still work there. */
export const WORK_POLL = Duration.seconds(15);

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
  /** The server failed, and nothing starts it until the operator tries again. */
  readonly serverFailed: boolean;
  /** The private origins phones reach the server at, once it answered on `lan`; `null` until then. */
  readonly origins: ReadonlyArray<ServerOrigin> | null;
}

/** Phone access, as the page and the tray are told it. */
const phoneAccessOf = (listening: Listening): PhoneAccess => {
  if (!listening.on) return { on: false, origins: [] };
  if (listening.serverFailed) return { on: true, origins: [], refusedReason: "not-running" };
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

/** A plain-HTTP origin at a private, non-loopback IP address. */
const isPrivateInterface = (origin: ServerOrigin): boolean => {
  const url = new URL(origin);
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return url.protocol === "http:" && isPrivateAddress(host);
};

/**
 * The origins a phone is given, best first: the server's own private
 * interfaces alone. Its `publicOrigin`, which names a way in the operator set
 * up for elsewhere, such as a proxy, is not one a phone on this network is
 * sent to.
 */
const phoneOrigins = (status: StatusReply): ReadonlyArray<ServerOrigin> =>
  pairingOrigins(status.origins ?? [])
    .filter((origin) => origin !== status.publicOrigin && isPrivateInterface(origin))
    .slice(0, 16);

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
    serverFailed: false,
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
      serverFailed: false,
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
      serverFailed: false,
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
  readonly supervisor: Pick<Supervisor, "state" | "changes" | "ready" | "retry" | "stop" | "start">;
  /**
   * Runs `effect` one at a time with the changes of where the bots live,
   * while they live on this computer; nothing, without running it, once they
   * live elsewhere.
   */
  readonly whileLocal: <A>(effect: Effect.Effect<A>) => Effect.Effect<Option.Option<A>>;
}

/** Bots with work running, as the server counts them; `null` when it could not say. */
type RunningWork = number | null;

/** Follows the server's starts, and turns phone access on and off, for as long as the scope lasts. */
export const serve = Effect.fn("PhoneAccess.serve")(function* (options: PhoneAccessOptions) {
  const settings = yield* DesktopSettings;
  const scope = yield* Effect.scope;
  const { state, publicAddress } = options.listening;
  const { supervisor, whileLocal } = options;
  const oneAtATime = yield* Semaphore.make(1);
  const restart = Effect.andThen(supervisor.stop, supervisor.start);

  /** The server, while it answers. */
  const answering = Effect.gen(function* () {
    if ((yield* supervisor.state).state !== "ready") return Option.none();
    return yield* supervisor.ready.pipe(Effect.option);
  });

  /** The work bots have running, which a stop of the server stops: none while it does not answer. */
  const runningWork: Effect.Effect<RunningWork> = answering.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<RunningWork>(0),
        onSome: (server) =>
          server.admin.runningWork.pipe(
            Effect.map((bots): RunningWork => bots),
            // A server that cannot say may have work running: the operator is asked.
            Effect.catch((error) =>
              Effect.logWarning("Asking the server for its running work failed", error).pipe(
                Effect.as<RunningWork>(null),
              ),
            ),
          ),
      }),
    ),
  );

  /** The private origins phones reach the server at, read from it now; `null` while it does not answer on `lan`. */
  const originsNow = Effect.gen(function* () {
    const server = yield* answering;
    if (Option.isNone(server)) return Option.none<ReadonlyArray<ServerOrigin> | null>();
    const status = yield* server.value.admin.status().pipe(Effect.option);
    if (Option.isNone(status)) return Option.none<ReadonlyArray<ServerOrigin> | null>();
    return Option.some(
      status.value.listener.address === LOOPBACK ? null : phoneOrigins(status.value),
    );
  });

  /** Where the server should listen now, as the next start would put it. */
  const chosenHost: Effect.Effect<ListenHost> = Effect.gen(function* () {
    const { phoneAccess } = yield* settings.get;
    const { fellBack } = yield* SubscriptionRef.get(state);
    if (!phoneAccess || Option.isSome(fellBack)) return LOOPBACK;
    return Option.isNone(yield* publicAddress) ? ("lan" as const) : LOOPBACK;
  });

  /**
   * One look at a server that answers elsewhere than it should listen:
   * nothing to do (`placed`), as a change of the choice may have moved it
   * since; work running there, which waits (`working`); or started again
   * where it should.
   */
  const placeOnce = whileLocal(
    Effect.gen(function* () {
      const { host, lanPending } = yield* SubscriptionRef.get(state);
      if ((yield* supervisor.state).state !== "ready" || lanPending || host === null) {
        return "placed" as const;
      }
      const chosen = yield* chosenHost;
      if (chosen === host) return "placed" as const;
      // A server that cannot say may have work running too.
      if ((yield* runningWork) !== 0) return "working" as const;
      yield* Effect.logInfo("The server listens elsewhere than chosen; restarting it", {
        listens: host,
        chosen,
      });
      yield* restart;
      return "placed" as const;
    }),
  );
  /** One at a time: each answer of the server may ask for it. */
  const placing = yield* Semaphore.make(1);

  /**
   * Starts the server again where it should listen, when it answers
   * elsewhere, once no bot has work running there, asking again every
   * `WORK_POLL` until then.
   */
  const placeAgain = Semaphore.withPermitsIfAvailable(
    placing,
    1,
  )(
    placeOnce.pipe(
      Effect.repeat({
        while: (step) => Option.contains(step, "working"),
        schedule: Schedule.spaced(WORK_POLL),
      }),
      Effect.asVoid,
    ),
  );

  /** The server answered: where it listens, and the origins phones reach it at. */
  const answered = Effect.gen(function* () {
    const server = yield* answering;
    if (Option.isNone(server)) return;
    const status = yield* server.value.admin.status().pipe(Effect.option);
    if (Option.isNone(status)) return;
    const onLan = status.value.listener.address !== LOOPBACK;
    const host: ListenHost = onLan ? "lan" : LOOPBACK;
    yield* SubscriptionRef.update(state, (now) => ({
      ...now,
      host,
      lanPending: false,
      origins: onLan ? phoneOrigins(status.value) : null,
    }));
    // A server an earlier run of the app left running, or one launched as the
    // choice changed, which read it before it was kept, may listen where the
    // operator no longer wants it to.
    if ((yield* chosenHost) !== host) yield* placeAgain.pipe(Effect.forkIn(scope));
  });

  /**
   * The server stopped or failed before it answered: a start on `lan` falls
   * back to 127.0.0.1, and says why. A public address that appeared since the
   * start, which the server refuses `lan` for, is that reason. Whether it
   * starts the server again for that.
   */
  const didNotAnswer = Effect.fn("PhoneAccess.didNotAnswer")(function* (
    reason: string | undefined,
  ) {
    const before = yield* SubscriptionRef.get(state);
    if (!before.lanPending) return false;
    const exposed = yield* publicAddress;
    if (Option.isSome(exposed)) {
      yield* Effect.logWarning(
        "This computer has a public address, so the server did not start on the network; it starts on 127.0.0.1 instead",
        exposed.value,
      );
      yield* SubscriptionRef.update(state, (now) => ({
        ...now,
        lanPending: false,
        publicAddress: true,
        origins: null,
      }));
    } else {
      const why = reason ?? "The server did not start on the network.";
      yield* Effect.logWarning(
        "The server did not start on the network; it starts on 127.0.0.1 instead",
        why,
      );
      yield* SubscriptionRef.update(state, (now) => ({
        ...now,
        lanPending: false,
        fellBack: Option.some(why),
        origins: null,
      }));
    }
    yield* supervisor.retry;
    return true;
  });

  yield* supervisor.changes.pipe(
    Stream.runForEach((server) => {
      switch (server.state) {
        case "ready":
          return answered;
        case "restarting":
          return didNotAnswer(server.reason);
        case "failed":
          // Started again on this computer alone, or left for the operator to try again.
          return didNotAnswer(server.reason).pipe(
            Effect.andThen((retried) =>
              retried
                ? Effect.void
                : SubscriptionRef.update(state, (now) => ({ ...now, serverFailed: true })),
            ),
          );
        case "stopped":
          return SubscriptionRef.update(state, (now) => ({
            ...now,
            lanPending: false,
            origins: null,
          }));
        case "starting":
          return SubscriptionRef.update(state, (now) => ({ ...now, serverFailed: false }));
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

  /** A server that runs moves when it listens elsewhere than `target`; one that is stopped or failed starts there. */
  const movesTo = Effect.fn("PhoneAccess.movesTo")(function* (target: ListenHost) {
    const server = (yield* supervisor.state).state;
    if (server === "stopped" || server === "failed") return false;
    return target !== (yield* SubscriptionRef.get(state)).host;
  });

  const set = (request: PhoneAccessRequest): Effect.Effect<PhoneAccessChange> =>
    oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        const exposed = request.on && Option.isSome(yield* publicAddress);
        // Asked on again after it fell back, it tries the network again.
        const target: ListenHost = request.on && !exposed ? "lan" : LOOPBACK;
        const notSaved = () =>
          SubscriptionRef.get(state).pipe(
            Effect.map((now) => ({ _tag: "not-saved", access: phoneAccessOf(now) }) as const),
          );
        // Asked first outside the step below, which waits on the changes of
        // where the bots live: asking the operator never waits on one.
        if (!request.stopWork && (yield* movesTo(target))) {
          const bots = yield* runningWork;
          if (bots !== 0) return { _tag: "work-running", bots } as const;
        }
        const step = yield* whileLocal(
          Effect.gen(function* () {
            // Asked again right before the stop: work may have started since.
            if (!request.stopWork && (yield* movesTo(target))) {
              const bots = yield* runningWork;
              if (bots !== 0) return { _tag: "work-running", bots } as const;
            }
            const saved = yield* settings
              .update((now) => ({ ...now, phoneAccess: request.on }))
              .pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("Saving phone access failed", error).pipe(Effect.as(false)),
                ),
              );
            if (!saved) return yield* notSaved();
            yield* SubscriptionRef.update(state, (now) => ({
              ...now,
              on: request.on,
              fellBack: Option.none(),
              publicAddress: exposed,
            }));
            // Where it listens is read again once the choice is kept: a start
            // under way may have put it elsewhere meanwhile, having read the
            // choice before. Such a server has only just started, so has no
            // work to stop.
            if (yield* movesTo(target)) {
              yield* SubscriptionRef.update(state, (now) => ({ ...now, origins: null }));
              yield* restart;
              return { _tag: "changed", access: yield* current } as const;
            }
            // Where it stays, the addresses are read again: asking again is how
            // the operator checks a network they just joined.
            return { _tag: "changed", access: yield* refresh } as const;
          }),
        );
        // The bots live elsewhere now: nothing is kept.
        return Option.isSome(step) ? step.value : yield* notSaved();
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
