// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Readiness from "./Readiness.ts";
import { type Pass, RETRY_TICK, reconcile } from "./reconciler.ts";
import * as Signals from "./Signals.ts";

const machinery = Layer.mergeAll(Readiness.layer, Signals.layer);

/**
 * A worker whose passes are `passes`, in order, the last one repeated: each
 * gets its pass's number. Returns how many passes began, and waits for the
 * first and the second to begin.
 */
const worker = (passes: ReadonlyArray<(n: number) => Effect.Effect<Pass>>) =>
  Effect.gen(function* () {
    const readiness = yield* Readiness.Readiness;
    const signals = yield* Signals.Signals;
    const began = yield* Ref.make(0);
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    const pass = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(began, (count) => count + 1);
      if (n === 1) yield* Deferred.succeed(first, undefined);
      if (n === 2) yield* Deferred.succeed(second, undefined);
      const run = passes[Math.min(n, passes.length) - 1];
      if (run === undefined) return yield* Effect.die(new Error("A worker with no passes"));
      return yield* run(n);
    });
    yield* readiness.release;
    yield* Effect.forkChild(
      reconcile({ name: "A worker", pass, signal: signals.dispatch, readiness }),
    );
    return {
      began: Ref.get(began),
      first: Deferred.await(first),
      second: Deferred.await(second),
    };
  });

const done = (next: DateTime.Utc | null = null, deferred = false): Pass => ({
  _tag: "done",
  deferred,
  next,
});

it.effect("runs again at once after a pass that left work and ran past its retry tick", () =>
  Effect.gen(function* () {
    const { second } = yield* worker([
      () => Effect.as(TestClock.adjust(RETRY_TICK), done(null, true)),
      () => Effect.succeed(done()),
    ]);
    // No time passes after the first pass: its retry was due as it ended.
    yield* second;
  }).pipe(Effect.provide(machinery)),
);

it.effect("runs a deadline that came due while a pass ran as soon as the pass ends", () =>
  Effect.gen(function* () {
    const { second } = yield* worker([
      () =>
        Effect.gen(function* () {
          const due = DateTime.addDuration(yield* DateTime.now, Duration.seconds(1));
          yield* TestClock.adjust("2 seconds");
          return done(due);
        }),
      () => Effect.succeed(done()),
    ]);
    yield* second;
  }).pipe(Effect.provide(machinery)),
);

it.effect("waits a retry tick after a pass that left a deadline already due when it began", () =>
  Effect.gen(function* () {
    const { began, first, second } = yield* worker([
      () => Effect.map(DateTime.now, (now) => done(now)),
      () => Effect.succeed(done()),
    ]);
    yield* first;
    yield* TestClock.adjust(Duration.subtract(RETRY_TICK, Duration.millis(1)));
    assert.strictEqual(yield* began, 1);
    yield* TestClock.adjust(Duration.millis(1));
    yield* second;
  }).pipe(Effect.provide(machinery)),
);

it.effect("runs again at once when the engine came back while a refused pass ran", () =>
  Effect.gen(function* () {
    const readiness = yield* Readiness.Readiness;
    const { second } = yield* worker([
      () =>
        Effect.gen(function* () {
          yield* readiness.hold;
          yield* readiness.release;
          return { _tag: "unavailable" } as const;
        }),
      () => Effect.succeed(done()),
    ]);
    // No time passes: the release came after the pass began.
    yield* second;
  }).pipe(Effect.provide(machinery)),
);
