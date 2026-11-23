// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { LocalServerState } from "@j3-bots/desktop-bridge";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { type AdminChannel, AdminRefused, type StatusReply } from "./adminChannel.ts";
import * as Supervisor from "./supervisor.ts";

/** A server process that does what the test tells it, and records what was done to it. */
const fakeServer = (
  pid: number,
  options: {
    /** The pid its status answers with: its own unless told otherwise. */
    readonly statusPid?: number;
    /** Whether its status answers at all; a server still starting does not. */
    readonly answers?: boolean;
    /**
     * What a `/shutdown` on its admin channel does: stop it (the default),
     * nothing (`ignored`), never answer (`stalls`), or fail at once, its pipe
     * closed (`unreachable`).
     */
    readonly whenAsked?: "stops" | "ignored" | "stalls" | "unreachable";
    /** Whether the system has a graceful signal for it: not on Windows. */
    readonly graceful?: boolean;
    readonly logTail?: string;
  } = {},
) => {
  const exited = Deferred.makeUnsafe<Supervisor.ServerExit>();
  const done: Array<string> = [];
  const end = (exit: Supervisor.ServerExit) => Deferred.doneUnsafe(exited, Effect.succeed(exit));
  const status: StatusReply = {
    version: "0.3.0",
    pid: options.statusPid ?? pid,
    listener: { address: "127.0.0.1", port: 3747 },
    engine: { state: { _tag: "ready" } },
  };
  const whenAsked = options.whenAsked ?? "stops";
  const admin: AdminChannel = {
    status: () => (options.answers === false ? Effect.never : Effect.succeed(status)),
    localDevice: () => Effect.die("not used here"),
    runningWork: Effect.die("not used here"),
    pairing: () => Effect.die("not used here"),
    shutdown: Effect.suspend(() => {
      done.push("shutdown");
      switch (whenAsked) {
        case "stops":
          end({ code: 0, signal: null });
          return Effect.void;
        case "ignored":
          return Effect.void;
        case "stalls":
          return Effect.never;
        case "unreachable":
          return Effect.fail(new AdminRefused({ route: "/shutdown", status: 0 }));
      }
    }),
  };
  const server: Supervisor.RunningServer = {
    pid,
    admin,
    exited: Deferred.await(exited),
    logTail: Effect.succeed(options.logTail ?? ""),
    terminate: Effect.sync(() => {
      done.push("terminate");
      return options.graceful ?? true;
    }),
    kill: Effect.sync(() => {
      done.push("kill");
      end({ code: null, signal: "SIGKILL" });
    }),
  };
  return { server, done, crash: (code: number) => end({ code, signal: null }) };
};

type Fake = ReturnType<typeof fakeServer>;

/** A supervisor whose launches start `servers` in turn, and the launches it made. */
const supervising = (servers: ReadonlyArray<Fake>, adopt: Option.Option<Fake> = Option.none()) =>
  Effect.gen(function* () {
    let launches = 0;
    const supervisor = yield* Supervisor.make({
      launch: Effect.suspend(() => {
        const next = servers[launches];
        launches += 1;
        return next === undefined
          ? Effect.fail(new Supervisor.LaunchFailed({ reason: "no more servers", retry: false }))
          : Effect.succeed(next.server);
      }),
      adopt: Effect.succeed(Option.map(adopt, (fake) => fake.server)),
    });
    return { supervisor, launches: () => launches };
  });

/** Waits for the supervisor to reach a state that `matches`. */
const reach = (supervisor: Supervisor.Supervisor, matches: (state: LocalServerState) => boolean) =>
  supervisor.changes.pipe(Stream.filter(matches), Stream.runHead, Effect.map(Option.getOrThrow));

const isReady = (state: LocalServerState) => state.state === "ready";

describe("the local server's supervisor", () => {
  it("waits one second before the first start again, doubling up to thirty", () => {
    assert.deepStrictEqual(
      [1, 2, 3, 4, 5, 6, 7, 20].map((attempt) =>
        Duration.toSeconds(Supervisor.restartDelay(attempt)),
      ),
      [1, 2, 4, 8, 16, 30, 30, 30],
    );
  });

  it.effect("starts a server that stopped on its own again, after the pause", () =>
    Effect.gen(function* () {
      const first = fakeServer(101);
      const second = fakeServer(102);
      const { supervisor, launches } = yield* supervising([first, second]);
      yield* supervisor.start;
      yield* reach(supervisor, isReady);
      first.crash(1);
      const restarting = yield* reach(supervisor, (state) => state.state === "restarting");
      assert.strictEqual(restarting.retryInSeconds, 1);
      assert.strictEqual(restarting.attempt, 1);
      assert.strictEqual(launches(), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* reach(supervisor, isReady);
      assert.strictEqual(launches(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("pauses longer after each stop that comes before a minute of running", () =>
    Effect.gen(function* () {
      const servers = [fakeServer(201), fakeServer(202), fakeServer(203)];
      const { supervisor } = yield* supervising(servers);
      yield* supervisor.start;
      yield* reach(supervisor, isReady);
      servers[0]?.crash(1);
      yield* reach(
        supervisor,
        (state) => state.state === "restarting" && state.retryInSeconds === 1,
      );
      yield* TestClock.adjust(Duration.seconds(1));
      yield* reach(supervisor, isReady);
      servers[1]?.crash(1);
      const second = yield* reach(supervisor, (state) => state.state === "restarting");
      assert.strictEqual(second.retryInSeconds, 2);
      assert.strictEqual(second.attempt, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("counts a stop after a minute of running as the first again", () =>
    Effect.gen(function* () {
      const servers = [fakeServer(301), fakeServer(302), fakeServer(303)];
      const { supervisor } = yield* supervising(servers);
      yield* supervisor.start;
      yield* reach(supervisor, isReady);
      servers[0]?.crash(1);
      yield* reach(supervisor, (state) => state.state === "restarting");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* reach(supervisor, isReady);
      yield* TestClock.adjust(Supervisor.HEALTHY_AFTER);
      servers[1]?.crash(1);
      const after = yield* reach(supervisor, (state) => state.state === "restarting");
      assert.strictEqual(after.retryInSeconds, 1);
      assert.strictEqual(after.attempt, 1);
    }).pipe(Effect.scoped),
  );

  for (const refusal of [
    "Other users on this machine can open /data. Run `chmod 700 /data`.",
    'Port 3747, for the server, is in use by another program. Stop that program, or set "port" in /data/config.json to a free port.',
  ]) {
    it.effect(`never starts again a server that refused to start: ${refusal.slice(0, 24)}…`, () =>
      Effect.gen(function* () {
        const refusing = fakeServer(401, {
          logTail: `{"level":"INFO","message":"starting"}\n${refusal}\n`,
        });
        const fixed = fakeServer(402);
        const { supervisor, launches } = yield* supervising([refusing, fixed]);
        yield* supervisor.start;
        yield* reach(supervisor, isReady);
        refusing.crash(Supervisor.START_REFUSED);
        const failed = yield* reach(supervisor, (state) => state.state === "failed");
        assert.strictEqual(failed.reason, refusal);
        yield* TestClock.adjust(Duration.minutes(5));
        assert.strictEqual(launches(), 1);
        assert.strictEqual((yield* supervisor.state).state, "failed");
        // The operator repaired it, and tries again.
        yield* supervisor.retry;
        yield* reach(supervisor, isReady);
        assert.strictEqual(launches(), 2);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("never starts again a launch the app refused, such as a home others can open", () =>
    Effect.gen(function* () {
      const { supervisor, launches } = yield* supervising([]);
      yield* supervisor.start;
      const failed = yield* reach(supervisor, (state) => state.state === "failed");
      assert.strictEqual(failed.reason, "no more servers");
      yield* TestClock.adjust(Duration.minutes(5));
      assert.strictEqual(launches(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("kills a server whose admin channel answers for another process", () =>
    Effect.gen(function* () {
      const impostor = fakeServer(501, { statusPid: 999 });
      const { supervisor } = yield* supervising([impostor, fakeServer(502)]);
      yield* supervisor.start;
      yield* reach(supervisor, (state) => state.state === "restarting");
      assert.deepStrictEqual(impostor.done, ["kill"]);
    }).pipe(Effect.scoped),
  );

  it.effect("takes over a server an earlier run left running, instead of starting one", () =>
    Effect.gen(function* () {
      const leftOver = fakeServer(601);
      const { supervisor, launches } = yield* supervising([fakeServer(602)], Option.some(leftOver));
      yield* supervisor.start;
      const server = yield* supervisor.ready;
      assert.strictEqual(server.pid, 601);
      assert.strictEqual(launches(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("stops a server by asking it, and waits until it has", () =>
    Effect.gen(function* () {
      const server = fakeServer(701);
      const { supervisor } = yield* supervising([server]);
      yield* supervisor.start;
      yield* reach(supervisor, isReady);
      yield* supervisor.stop;
      assert.deepStrictEqual(server.done, ["shutdown"]);
      assert.strictEqual((yield* supervisor.state).state, "stopped");
    }).pipe(Effect.scoped),
  );

  it.effect("kills a server that has not stopped thirty seconds after it was asked", () =>
    Effect.gen(function* () {
      const stubborn = fakeServer(801, { whenAsked: "ignored" });
      const { supervisor } = yield* supervising([stubborn]);
      yield* supervisor.start;
      yield* reach(supervisor, isReady);
      const stopping = yield* Effect.forkChild(supervisor.stop);
      yield* TestClock.adjust(Duration.seconds(29));
      assert.deepStrictEqual(stubborn.done, ["shutdown"]);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(stopping);
      assert.deepStrictEqual(stubborn.done, ["shutdown", "kill"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "kills a server thirty seconds after the stop began, when asking it never answers",
    () =>
      Effect.gen(function* () {
        const stalled = fakeServer(811, { whenAsked: "stalls" });
        const { supervisor } = yield* supervising([stalled]);
        yield* supervisor.start;
        yield* reach(supervisor, isReady);
        const stopping = yield* Effect.forkChild(supervisor.stop);
        yield* TestClock.adjust(Duration.seconds(29));
        assert.deepStrictEqual(stalled.done, ["shutdown"]);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(stopping);
        assert.deepStrictEqual(stalled.done, ["shutdown", "kill"]);
        assert.strictEqual((yield* supervisor.state).state, "stopped");
      }).pipe(Effect.scoped),
  );

  it.effect("kills at once a server still starting that it has no way to ask (Windows)", () =>
    Effect.gen(function* () {
      const starting = fakeServer(821, {
        answers: false,
        whenAsked: "unreachable",
        graceful: false,
      });
      const { supervisor, launches } = yield* supervising([starting]);
      yield* supervisor.start;
      while (launches() === 0) yield* Effect.yieldNow;
      // No clock moves: the stop must not wait out a deadline.
      yield* supervisor.stop;
      assert.deepStrictEqual(starting.done, ["shutdown", "terminate", "kill"]);
      assert.strictEqual((yield* supervisor.state).state, "stopped");
    }).pipe(Effect.scoped),
  );

  it.effect("tells a sign-in waiting on a start that the server will not come", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* supervising([]);
      yield* supervisor.start;
      const notReady = yield* Effect.flip(supervisor.ready);
      assert.strictEqual(notReady.state, "failed");
    }).pipe(Effect.scoped),
  );

  it.effect("tells a sign-in that no server runs when none was started", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* supervising([fakeServer(901)]);
      const notReady = yield* Effect.flip(supervisor.ready);
      assert.strictEqual(notReady.state, "stopped");
    }).pipe(Effect.scoped),
  );
});
