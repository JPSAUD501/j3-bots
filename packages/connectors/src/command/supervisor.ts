// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as RcMap from "effect/RcMap";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { CommandFailed, type ConnectorFailure } from "../errors.ts";
import type { McpSession } from "../session.ts";
import type { CommandSession } from "./session.ts";

/**
 * The command connectors' processes (`docs/architecture/server.md`,
 * "Connectors started by command"):
 *
 * - **Lazy**: a process starts when its connector is first used, never ahead.
 * - **Shared**: one process per connector serves every bot that uses it.
 * - **Idle stop**: it stops once no one has used it for `idle`.
 * - **Restart with backoff**: one that ends by itself, or fails to start, is
 *   started again, by itself, after a pause that doubles from
 *   `backoff.initial` to `backoff.max` while it keeps ending or failing to
 *   start, and starts over once a run lasted `backoff.stable`. Past
 *   `restarts` in a row it is left stopped until its next use. A use during
 *   the pause waits it out. A stop asked for ends a restart under way and the
 *   pause with it.
 * - **Stop at once**: a stop asked for ends the process even while it is in
 *   use, so one started with what the operator since changed does not run on
 *   until its last call ends; the calls under way fail.
 * - **Capped**: at most `capacity` run at once. A start past it stops the
 *   process unused the longest, if one is idle; when every one is in use, the
 *   start fails with `ExceededCapacityError`.
 */

export interface SupervisorOptions<K extends string> {
  /** Starts the key's process and opens its session; the scope's close stops it. */
  readonly start: (key: K) => Effect.Effect<CommandSession, ConnectorFailure, Scope.Scope>;
  /**
   * A process ended by itself (`CommandFailed("exited")`), or a restart
   * failed. A start a use asked for that failed is that use's to hear of.
   */
  readonly onFailure: (key: K, failure: ConnectorFailure) => Effect.Effect<void>;
  readonly idle: Duration.Duration;
  readonly capacity: number;
  readonly backoff: {
    readonly initial: Duration.Duration;
    readonly max: Duration.Duration;
    readonly stable: Duration.Duration;
  };
  /** How many times in a row it may end or fail to start and still be started again by itself. */
  readonly restarts: number;
}

export interface Supervisor<K extends string> {
  /** The key's session, its process started first if it is not running; held while the scope is open. */
  readonly use: (
    key: K,
  ) => Effect.Effect<McpSession, ConnectorFailure | Cause.ExceededCapacityError, Scope.Scope>;
  /**
   * Stops the key's process at once, and waits for it to end; the calls
   * under way with it fail. The next use starts another, with no pause.
   */
  readonly stop: (key: K) => Effect.Effect<void>;
  /** The keys whose process runs, or starts. */
  readonly running: Effect.Effect<ReadonlyArray<K>>;
}

interface Backoff {
  /** How many times in a row it ended by itself, or failed to start. */
  readonly failures: number;
  /** When it may start again, in epoch milliseconds. */
  readonly notBefore: number;
}

interface Use {
  readonly holders: number;
  readonly lastUsed: number;
}

export const makeSupervisor = <K extends string>(
  options: SupervisorOptions<K>,
): Effect.Effect<Supervisor<K>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const backoffs = yield* Ref.make<ReadonlyMap<K, Backoff>>(new Map());
    const uses = yield* Ref.make<ReadonlyMap<K, Use>>(new Map());
    /** Which start of each key is current, so a process stopped and started again is told apart from the one before. */
    const generations = yield* Ref.make<ReadonlyMap<K, number>>(new Map());
    /** The restarts under way, which a stop ends. */
    const restarting = yield* FiberMap.make<K>();
    /**
     * The scope each key's process runs in, a child of its entry's: a stop
     * closes it at once, where the entry's closes only once no one holds it.
     */
    const lives = yield* Ref.make<ReadonlyMap<K, Scope.Closeable>>(new Map());

    const initial = Duration.toMillis(options.backoff.initial);
    const max = Duration.toMillis(options.backoff.max);
    const stable = Duration.toMillis(options.backoff.stable);

    const failed = Effect.fn("Supervisor.failed")(function* (key: K, startedAt: number) {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(backoffs, (all) => {
        const before = all.get(key);
        const failures =
          before === undefined || now - startedAt >= stable ? 1 : before.failures + 1;
        const pause = Math.min(initial * 2 ** (failures - 1), max);
        return new Map(all).set(key, { failures, notBefore: now + pause });
      });
    });

    const waitOutBackoff = Effect.fn("Supervisor.waitOutBackoff")(function* (key: K) {
      const backoff = (yield* Ref.get(backoffs)).get(key);
      if (backoff === undefined) return;
      const left = backoff.notBefore - (yield* Clock.currentTimeMillis);
      if (left > 0) yield* Effect.sleep(Duration.millis(left));
    });

    /** Watches the key's process from the supervisor's scope, not the entry's, which a stop closes. */
    const watch = Effect.fn("Supervisor.watch")(function* (
      key: K,
      generation: number,
      startedAt: number,
      stopping: Ref.Ref<boolean>,
    ) {
      if (yield* Ref.get(stopping)) return;
      if ((yield* Ref.get(generations)).get(key) !== generation) return;
      yield* Effect.logWarning("A command connector's process ended by itself.").pipe(
        Effect.annotateLogs({ connector: key }),
      );
      yield* failed(key, startedAt);
      yield* RcMap.invalidate(processes, key);
      yield* options.onFailure(key, new CommandFailed({ reason: "exited" }));
      yield* FiberMap.run(restarting, key, restart(key));
    });

    const lookup = Effect.fn("Supervisor.start")(function* (key: K) {
      yield* waitOutBackoff(key);
      const generation = yield* Ref.modify(generations, (all): [number, ReadonlyMap<K, number>] => {
        const next = (all.get(key) ?? 0) + 1;
        return [next, new Map(all).set(key, next)];
      });
      const startedAt = yield* Clock.currentTimeMillis;
      const life = yield* Scope.fork(yield* Effect.scope);
      yield* Ref.update(lives, (all) => new Map(all).set(key, life));
      yield* Scope.addFinalizer(
        life,
        Ref.update(lives, (all) => {
          if (all.get(key) !== life) return all;
          const rest = new Map(all);
          rest.delete(key);
          return rest;
        }),
      );
      const command = yield* options.start(key).pipe(
        Scope.provide(life),
        Effect.tapError(() => failed(key, startedAt)),
      );
      yield* Effect.logInfo("A command connector's process started.").pipe(
        Effect.annotateLogs({ connector: key }),
      );
      // Added after the start, so it runs before the process is stopped: an end the
      // supervisor asked for is not a crash.
      const stopping = yield* Ref.make(false);
      yield* Scope.addFinalizer(
        life,
        Ref.set(stopping, true).pipe(
          Effect.andThen(
            Effect.logInfo("A command connector's process stopped.").pipe(
              Effect.annotateLogs({ connector: key }),
            ),
          ),
        ),
      );
      yield* command.ended.pipe(
        Effect.andThen(watch(key, generation, startedAt, stopping)),
        Effect.forkIn(scope),
      );
      return command.session;
    });

    const processes: RcMap.RcMap<K, McpSession, ConnectorFailure | Cause.ExceededCapacityError> =
      yield* RcMap.make({ lookup, idleTimeToLive: options.idle, capacity: options.capacity });

    const held = Effect.fn("Supervisor.held")(function* (key: K, change: 1 | -1) {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(uses, (all) => {
        const holders = (all.get(key)?.holders ?? 0) + change;
        return new Map(all).set(key, { holders, lastUsed: now });
      });
    });

    /** Stops the process unused the longest of those no one uses now, other than `key`'s; whether there was one. */
    const evictIdle = Effect.fn("Supervisor.evictIdle")(function* (key: K) {
      const all = yield* Ref.get(uses);
      const [oldest] = Array.from(yield* RcMap.keys(processes))
        .filter((other) => other !== key && (all.get(other)?.holders ?? 0) === 0)
        .toSorted((a, b) => (all.get(a)?.lastUsed ?? 0) - (all.get(b)?.lastUsed ?? 0));
      if (oldest === undefined) return false;
      yield* RcMap.invalidate(processes, oldest);
      return true;
    });

    const acquire = (key: K) =>
      RcMap.get(processes, key).pipe(
        // A start that failed is not kept: the next use tries again, after its pause, as does
        // the supervisor by itself unless a restart is already under way.
        Effect.tapError((failure) =>
          RcMap.invalidate(processes, key).pipe(
            Effect.andThen(
              Cause.isExceededCapacityError(failure)
                ? Effect.void
                : FiberMap.run(restarting, key, restart(key), { onlyIfMissing: true }),
            ),
          ),
        ),
      );

    const use = Effect.fn("Supervisor.use")(function* (key: K) {
      yield* Effect.acquireRelease(held(key, 1), () => held(key, -1));
      return yield* acquire(key).pipe(
        Effect.catchIf(Cause.isExceededCapacityError, (full) =>
          Effect.flatMap(evictIdle(key), (evicted) => (evicted ? acquire(key) : Effect.fail(full))),
        ),
      );
    });

    /**
     * Starts the key's process again, held for no one, so it stops once idle
     * unless a bot uses it. A start that fails is tried again, until it has
     * ended or failed `restarts` times in a row.
     */
    const restart: (key: K) => Effect.Effect<void> = Effect.fn("Supervisor.restart")(function* (
      key: K,
    ) {
      if (((yield* Ref.get(backoffs)).get(key)?.failures ?? 0) > options.restarts) return;
      const outcome = yield* Effect.scoped(use(key)).pipe(Effect.result);
      if (Result.isSuccess(outcome) || Cause.isExceededCapacityError(outcome.failure)) return;
      yield* options.onFailure(key, outcome.failure);
      yield* restart(key);
    });

    const stop = Effect.fn("Supervisor.stop")(function* (key: K) {
      yield* FiberMap.remove(restarting, key);
      yield* Ref.update(backoffs, (all) => {
        const rest = new Map(all);
        rest.delete(key);
        return rest;
      });
      const life = (yield* Ref.get(lives)).get(key);
      if (life !== undefined) yield* Scope.close(life, Exit.void);
      yield* RcMap.invalidate(processes, key);
    });

    return {
      use,
      stop,
      running: RcMap.keys(processes).pipe(Effect.map((keys) => [...keys])),
    } satisfies Supervisor<K>;
  });

/** How many command connectors' processes may run at once on a computer with `totalMemory` bytes: one a gibibyte, from two to twelve. */
export const processCapacity = (totalMemory: number): number =>
  Math.min(12, Math.max(2, Math.floor(totalMemory / 1024 ** 3)));
