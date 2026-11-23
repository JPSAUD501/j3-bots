// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { awaitReady, type ServerProbe } from "./readiness.ts";

const answering = (version: string, pid: number, engine: string): ServerProbe => ({
  _tag: "running",
  pid: Option.some(42),
  answer: Option.some({ version, pid, engine: { state: { _tag: engine } } }),
});

/** A probe that answers `first`, then each of `rest` in turn, then the last one again. */
const probing = (first: ServerProbe, ...rest: ReadonlyArray<ServerProbe>) => {
  const seen = [first, ...rest];
  let call = 0;
  return Effect.sync(() => seen[Math.min(call++, seen.length - 1)] ?? first);
};

/** The step and reason `awaitReady` failed with, if it did. */
const failureOf = <E extends { readonly step: string; readonly reason: string }>(
  exit: Exit.Exit<void, E>,
) => (Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none<E>());

describe("waiting for a started server", () => {
  it.effect("is over once it answers as its version, from its process, its engine ready", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        awaitReady(
          "0.3.0",
          probing(
            { _tag: "running", pid: Option.none(), answer: Option.none() },
            answering("0.2.0", 42, "ready"),
            answering("0.3.0", 7, "ready"),
            answering("0.3.0", 42, "starting"),
            answering("0.3.0", 42, "ready"),
          ),
          "await-new",
        ),
      );
      yield* TestClock.adjust("3 seconds");
      assert.isUndefined(fiber.pollUnsafe(), "not ready while it answers as starting");
      yield* TestClock.adjust("1 second");
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
    }),
  );

  for (const [what, probe, reason] of [
    [
      "its supervisor says it exited",
      { _tag: "exited", reason: "it exited with code 1" },
      "it exited with code 1",
    ],
    ["its engine is incompatible", answering("0.3.0", 42, "incompatible"), "its engine is not"],
  ] as const) {
    it.effect(`fails at once when ${what}`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(awaitReady("0.3.0", Effect.succeed(probe), "await-old"));
        const failed = Option.getOrThrow(failureOf(exit));
        assert.strictEqual(failed.step, "await-old");
        assert.include(failed.reason, reason);
      }),
    );
  }

  it.effect("fails after five minutes without an answer", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        awaitReady(
          "0.3.0",
          Effect.succeed<ServerProbe>({
            _tag: "running",
            pid: Option.some(42),
            answer: Option.none(),
          }),
          "await-new",
        ),
      );
      yield* TestClock.adjust("4 minutes");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      const failed = Option.getOrThrow(failureOf(yield* Fiber.await(fiber)));
      assert.strictEqual(failed.step, "await-new");
      assert.include(failed.reason, "did not answer with its engine ready");
    }),
  );
});
