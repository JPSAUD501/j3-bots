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

/**
 * One start of a key's process, and the process it started. A stop, a start
 * that failed and a process that ended each make the key's next use another
 * attempt, so what is done about one attempt never reaches a later one.
 */
interface Attempt<K extends string> {
  readonly key: K;
  readonly number: number;
}

export const makeSupervisor = <K extends string>(
  options: SupervisorOptions<K>,
): Effect.Effect<Supervisor<K>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const backoffs = yield* Ref.make<ReadonlyMap<K, Backoff>>(new Map());
    const uses = yield* Ref.make<ReadonlyMap<K, Use>>(new Map());
    /** The number of each key's current attempt: the one its next use joins or starts. */
    const attempts = yield* Ref.make<ReadonlyMap<K, number>>(new Map());
    /** The restarts under way, which a stop ends. */
    const restarting = yield* FiberMap.make<K>();
    /**
     * The scope each attempt's process runs in, by key and attempt number, a
     * child of the attempt's entry: a stop closes it at once, where the
     * entry's closes only once no one holds it.
     */
    const lives = yield* Ref.make<ReadonlyMap<K, ReadonlyMap<number, Scope.Closeable>>>(new Map());

    const initial = Duration.toMillis(options.backoff.initial);
    const max = Duration.toMillis(options.backoff.max);
    const stable = Duration.toMillis(options.backoff.stable);

    /**
     * Counts a failure: a start that failed, or a process that ended by
     * itself. The count starts over only after a process that opened its
     * session ran `stable`, so starts that fail however slowly use up the
     * restarts.
     */
    const failed = Effect.fn("Supervisor.failed")(function* (key: K, openedAt: number | null) {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(backoffs, (all) => {
        const before = all.get(key);
        const failures =
          before === undefined || (openedAt !== null && now - openedAt >= stable)
            ? 1
            : before.failures + 1;
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

    const currentOf = (key: K) => Effect.map(Ref.get(attempts), (all) => all.get(key) ?? 0);

    const isCurrent = (attempt: Attempt<K>) =>
      Effect.map(currentOf(attempt.key), (current) => current === attempt.number);

    /**
     * Ends the attempt as the key's current one, if it still is: whether it
     * was. Its next use starts another.
     */
    const retire = (attempt: Attempt<K>) =>
      Ref.modify(attempts, (all): [boolean, ReadonlyMap<K, number>] =>
        (all.get(attempt.key) ?? 0) === attempt.number
          ? [true, new Map(all).set(attempt.key, attempt.number + 1)]
          : [false, all],
      );

    /**
     * Watches the key's process from the supervisor's scope, not the entry's,
     * which a stop closes. A process that ended, or whose session broke, is
     * stopped with what it started, and started again after its pause.
     */
    const watch = Effect.fn("Supervisor.watch")(function* (
      attempt: Attempt<K>,
      openedAt: number,
      stopping: Ref.Ref<boolean>,
      life: Scope.Closeable,
    ) {
      const { key } = attempt;
      if (yield* Ref.get(stopping)) return;
      if (!(yield* retire(attempt))) return;
      yield* Effect.logWarning("A command connector's process ended by itself.").pipe(
        Effect.annotateLogs({ connector: key }),
      );
      yield* failed(key, openedAt);
      yield* RcMap.invalidate(processes, attempt);
      yield* Scope.close(life, Exit.void);
      yield* options.onFailure(key, new CommandFailed({ reason: "exited" }));
      yield* FiberMap.run(restarting, key, restart(key));
    });

    const lookup = Effect.fn("Supervisor.start")(function* (attempt: Attempt<K>) {
      const { key } = attempt;
      // Its scope is known before the pause, so a stop during the pause or the start ends it.
      const life = yield* Scope.fork(yield* Effect.scope);
      yield* Ref.update(lives, (all) =>
        new Map(all).set(key, new Map(all.get(key)).set(attempt.number, life)),
      );
      yield* Scope.addFinalizer(
        life,
        Ref.update(lives, (all) => {
          const left = new Map(all.get(key));
          left.delete(attempt.number);
          const rest = new Map(all);
          if (left.size === 0) rest.delete(key);
          else rest.set(key, left);
          return rest;
        }),
      );
      /** A start a stop overtook: not a failure of the process's, so not counted or tried again. */
      const overtaken = new CommandFailed({ reason: "exited" });
      yield* waitOutBackoff(key);
      if (!(yield* isCurrent(attempt))) {
        yield* Scope.close(life, Exit.void);
        return yield* overtaken;
      }
      const command = yield* options.start(key).pipe(
        Scope.provide(life),
        Effect.tapError(() =>
          Effect.flatMap(isCurrent(attempt), (current) =>
            current ? failed(key, null) : Effect.void,
          ),
        ),
      );
      if (!(yield* isCurrent(attempt))) {
        yield* Scope.close(life, Exit.void);
        return yield* overtaken;
      }
      const openedAt = yield* Clock.currentTimeMillis;
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
        Effect.andThen(watch(attempt, openedAt, stopping, life)),
        Effect.forkIn(scope),
      );
      return command.session;
    });

    /** Each attempt's process, by its attempt: an attempt is never started twice. */
    const processes: RcMap.RcMap<
      Attempt<K>,
      McpSession,
      ConnectorFailure | Cause.ExceededCapacityError
    > = yield* RcMap.make({ lookup, idleTimeToLive: options.idle, capacity: options.capacity });

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
        .filter((other) => other.key !== key && (all.get(other.key)?.holders ?? 0) === 0)
        .toSorted((a, b) => (all.get(a.key)?.lastUsed ?? 0) - (all.get(b.key)?.lastUsed ?? 0));
      if (oldest === undefined) return false;
      yield* retire(oldest);
      yield* RcMap.invalidate(processes, oldest);
      return true;
    });

    const acquire = Effect.fn("Supervisor.acquire")(function* (key: K) {
      const attempt: Attempt<K> = { key, number: yield* currentOf(key) };
      return yield* RcMap.get(processes, attempt).pipe(
        // A start that failed is not kept: the next use tries again, after its pause, as does
        // the supervisor by itself unless a restart is already under way. One a stop overtook
        // counted no failure, and is not tried again.
        Effect.tapError(() =>
          retire(attempt).pipe(
            Effect.andThen(RcMap.invalidate(processes, attempt)),
            Effect.andThen(Ref.get(backoffs)),
            Effect.flatMap((all) =>
              all.has(key)
                ? FiberMap.run(restarting, key, restart(key), { onlyIfMissing: true })
                : Effect.void,
            ),
          ),
        ),
      );
    });

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
      // A start under way, or waiting out its pause, is no longer the key's: the next use starts
      // another, which this stop leaves alone.
      const number = yield* Ref.modify(attempts, (all): [number, ReadonlyMap<K, number>] => {
        const current = all.get(key) ?? 0;
        return [current, new Map(all).set(key, current + 1)];
      });
      yield* RcMap.invalidate(processes, { key, number });
      const life = (yield* Ref.get(lives)).get(key)?.get(number);
      if (life !== undefined) yield* Scope.close(life, Exit.void);
    });

    return {
      use,
      stop,
      running: RcMap.keys(processes).pipe(
        Effect.map((all) => [...new Set(Array.from(all, (attempt) => attempt.key))]),
      ),
    } satisfies Supervisor<K>;
  });

/** How many command connectors' processes may run at once on a computer with `totalMemory` bytes: one a gibibyte, from two to twelve. */
export const processCapacity = (totalMemory: number): number =>
  Math.min(12, Math.max(2, Math.floor(totalMemory / 1024 ** 3)));
