// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type { AdminChannel } from "./adminChannel.ts";
import * as Orphans from "./orphans.ts";

const PID = 4242;

/**
 * The system's processes as the test sets them: which process has each pid
 * (by when it started), and the signals sent.
 */
const fakeProcesses = () => {
  const startedAt = new Map<number, string>([[PID, "8812"]]);
  const signals: Array<string> = [];
  const processes: Orphans.Processes = {
    startOf: (pid) => Effect.sync(() => Option.fromNullishOr(startedAt.get(pid))),
    signal: (pid, name) => Effect.sync(() => void signals.push(`${name} ${pid}`)),
  };
  return {
    processes,
    signals,
    /** The server ends, and the system gives its pid to a new process. */
    reused: () => startedAt.set(PID, "9907"),
    /** The server ends, and no process has its pid. */
    ended: () => startedAt.delete(PID),
  };
};

/** The admin socket of a server of `version`; a `/shutdown` does `whenAsked`. */
const socket = (version: string, whenAsked: () => void = () => {}): AdminChannel => ({
  status: () =>
    Effect.succeed({
      version,
      pid: PID,
      listener: { port: 3747 },
      engine: { state: { _tag: "ready" } },
    }),
  localDevice: () => Effect.die("not used here"),
  shutdown: Effect.sync(whenAsked),
});

describe("a server an earlier run of the app left running", () => {
  it.effect(
    "is taken over at this version, and never signalled once its pid is another process's",
    () =>
      Effect.gen(function* () {
        const system = fakeProcesses();
        const adopted = yield* Orphans.takeOverOnSocket(
          socket("0.3.0"),
          Option.some("0.3.0"),
          system.processes,
        );
        assert.isTrue(Option.isSome(adopted));
        if (Option.isNone(adopted)) return;
        system.reused();
        yield* adopted.value.terminate;
        yield* adopted.value.kill;
        yield* adopted.value.exited;
        assert.deepStrictEqual(system.signals, []);
      }),
  );

  it.effect(
    "of another version stops when asked, and is not killed after its pid is given again",
    () =>
      Effect.gen(function* () {
        const system = fakeProcesses();
        const taken = yield* Orphans.takeOverOnSocket(
          socket("0.2.9", system.reused),
          Option.some("0.3.0"),
          system.processes,
        );
        assert.isTrue(Option.isNone(taken));
        assert.deepStrictEqual(system.signals, []);
      }),
  );

  it.effect("of another version that does not stop is killed 30 s after it was asked", () =>
    Effect.gen(function* () {
      const system = fakeProcesses();
      const stopping = yield* Effect.forkChild(
        Orphans.takeOverOnSocket(socket("0.2.9"), Option.some("0.3.0"), system.processes),
      );
      yield* TestClock.adjust(Duration.seconds(29));
      assert.deepStrictEqual(system.signals, []);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(stopping);
      assert.deepStrictEqual(system.signals, [`SIGKILL ${PID}`]);
    }),
  );

  it.effect("is left alone when the system cannot say when its process started", () =>
    Effect.gen(function* () {
      const system = fakeProcesses();
      system.ended();
      let asked = false;
      const taken = yield* Orphans.takeOverOnSocket(
        socket("0.2.9", () => {
          asked = true;
        }),
        Option.some("0.3.0"),
        system.processes,
      );
      assert.isTrue(Option.isNone(taken));
      assert.isFalse(asked);
      assert.deepStrictEqual(system.signals, []);
    }),
  );
});

describe("when a Linux process started", () => {
  it("reads the 22nd field of its stat, counted after a name that holds spaces and parentheses", () => {
    const stat =
      "4242 (node (j3) serve) S 1 4242 4242 0 -1 4194560 2100 0 0 0 12 3 0 0 20 0 11 0 8812 1200 300";
    assert.deepStrictEqual(Orphans.linuxStartTime(stat), Option.some("8812"));
  });

  it("reads nothing from a stat cut short", () => {
    assert.deepStrictEqual(Orphans.linuxStartTime("4242 (node) S 1 4242"), Option.none());
  });
});
