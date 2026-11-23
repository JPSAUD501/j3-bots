// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { CommandFailed, type ConnectorFailure } from "../errors.ts";
import { alive, answerOf, eventually, fixtureOptions } from "../testing/stdioFixture.ts";
import { openCommandSession } from "./session.ts";
import { makeSupervisor, type SupervisorOptions } from "./supervisor.ts";

/** A test starts, talks to and stops real processes. */
const SLOW = 30_000;

/** A supervisor of fixture servers, one per key, counting its starts and the failures it reports. */
const supervised = (
  overrides: Partial<Omit<SupervisorOptions<string>, "start" | "onFailure">> = {},
) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<ReadonlyArray<string>>([]);
    const failures = yield* Ref.make<ReadonlyArray<ConnectorFailure>>([]);
    const supervisor = yield* makeSupervisor<string>({
      start: (key) =>
        Ref.update(starts, (all) => [...all, key]).pipe(
          Effect.andThen(openCommandSession({ ...fixtureOptions(), onToolsChanged: Effect.void })),
        ),
      onFailure: (_key, failure) => Ref.update(failures, (all) => [...all, failure]),
      idle: Duration.minutes(1),
      capacity: 4,
      backoff: {
        initial: Duration.millis(100),
        max: Duration.seconds(1),
        stable: Duration.seconds(30),
      },
      restarts: 3,
      ...overrides,
    });
    /** The process id of the key's server, through a use that ends at once. */
    const pidOf = (key: string) =>
      Effect.scoped(
        Effect.flatMap(supervisor.use(key), (session) => answerOf(session, "whoami")),
      ).pipe(Effect.map(Number));
    return { supervisor, starts, failures, pidOf };
  });

describe("the command connectors' supervisor", () => {
  it.live(
    "starts a process at its first use, not before, and shares it among every use",
    () =>
      Effect.gen(function* () {
        const { supervisor, starts } = yield* supervised();
        assert.deepStrictEqual(yield* supervisor.running, []);
        assert.deepStrictEqual(yield* Ref.get(starts), []);

        const [first, second] = yield* Effect.all(
          [supervisor.use("notes"), supervisor.use("notes")],
          { concurrency: "unbounded" },
        );
        const pids = yield* Effect.all([answerOf(first, "whoami"), answerOf(second, "whoami")]);
        assert.strictEqual(pids[0], pids[1]);
        assert.deepStrictEqual(yield* Ref.get(starts), ["notes"]);
        assert.deepStrictEqual(yield* supervisor.running, ["notes"]);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "stops a process no one has used for its idle time",
    () =>
      Effect.gen(function* () {
        const { supervisor, pidOf } = yield* supervised({ idle: Duration.millis(300) });
        const pid = yield* pidOf("notes");
        assert.isTrue(alive(pid));
        yield* eventually(Effect.sync(() => !alive(pid)));
        assert.deepStrictEqual(yield* supervisor.running, []);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "starts a process that ended by itself again, after a pause, and says it ended",
    () =>
      Effect.gen(function* () {
        const { supervisor, starts, failures, pidOf } = yield* supervised();
        const before = yield* pidOf("notes");
        yield* Effect.scoped(
          Effect.flatMap(supervisor.use("notes"), (session) => answerOf(session, "exit")),
        );
        yield* eventually(Effect.map(Ref.get(starts), (all) => all.length === 2));
        assert.deepStrictEqual(
          (yield* Ref.get(failures)).map((failure) => failure._tag),
          ["CommandFailed"],
        );
        const after = yield* pidOf("notes");
        assert.notStrictEqual(after, before);
        assert.isFalse(alive(before));
        assert.deepStrictEqual(yield* Ref.get(starts), ["notes", "notes"]);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "stops the process with everything it started, at once though it is in use",
    () =>
      Effect.gen(function* () {
        const { supervisor, failures } = yield* supervised();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* supervisor.use("notes");
            const pid = Number(yield* answerOf(session, "whoami"));
            const child = Number(yield* answerOf(session, "spawn"));
            assert.isTrue(alive(child));
            yield* supervisor.stop("notes");
            assert.isFalse(alive(pid));
            yield* eventually(Effect.sync(() => !alive(child)));
            // The use still held has nothing left to talk to.
            yield* Effect.flip(answerOf(session, "whoami"));
          }),
        );
        // A stop asked for is not a crash.
        assert.deepStrictEqual(yield* Ref.get(failures), []);
        assert.deepStrictEqual(yield* supervisor.running, []);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "starts a process that failed to start again, by itself, after a pause",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const failures = yield* Ref.make<ReadonlyArray<ConnectorFailure>>([]);
        const supervisor = yield* makeSupervisor<string>({
          start: () =>
            Ref.updateAndGet(attempts, (n) => n + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt < 3
                  ? Effect.fail(new CommandFailed({ reason: "exited" }))
                  : openCommandSession({ ...fixtureOptions(), onToolsChanged: Effect.void }),
              ),
            ),
          onFailure: (_key, failure) => Ref.update(failures, (all) => [...all, failure]),
          idle: Duration.minutes(1),
          capacity: 2,
          backoff: {
            initial: Duration.millis(50),
            max: Duration.millis(200),
            stable: Duration.seconds(30),
          },
          restarts: 3,
        });
        yield* Effect.flip(Effect.scoped(supervisor.use("notes")));
        yield* eventually(Effect.map(Ref.get(attempts), (n) => n === 3));
        // A use now gets the process the supervisor started by itself, not a fourth.
        yield* Effect.scoped(
          Effect.flatMap(supervisor.use("notes"), (session) => answerOf(session, "whoami")),
        );
        assert.strictEqual(yield* Ref.get(attempts), 3);
        // The second attempt was the supervisor's own, so its failure is told; the first was the use's.
        assert.strictEqual((yield* Ref.get(failures)).length, 1);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "stops the process unused the longest when one more would pass the cap",
    () =>
      Effect.gen(function* () {
        const { supervisor, pidOf } = yield* supervised({ capacity: 2 });
        const oldest = yield* pidOf("notes");
        yield* pidOf("calendar");
        yield* pidOf("mail");
        assert.sameMembers([...(yield* supervisor.running)], ["calendar", "mail"]);
        yield* eventually(Effect.sync(() => !alive(oldest)));
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "fails a start whose program is not there, and keeps nothing of it",
    () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor<string>({
          start: () =>
            openCommandSession({
              ...fixtureOptions(),
              program: "j3-no-such-program",
              args: [Redacted.make("--version")],
              onToolsChanged: Effect.void,
            }),
          onFailure: () => Effect.void,
          idle: Duration.minutes(1),
          capacity: 2,
          backoff: {
            initial: Duration.millis(10),
            max: Duration.millis(10),
            stable: Duration.seconds(1),
          },
          restarts: 0,
        });
        const failure = yield* Effect.flip(Effect.scoped(supervisor.use("missing")));
        assert.deepStrictEqual(
          failure._tag === "CommandFailed" ? failure.reason : failure._tag,
          "not-found",
        );
        assert.deepStrictEqual(yield* supervisor.running, []);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "starts nothing for a start a stop overtook during its pause",
    () =>
      Effect.gen(function* () {
        // No restart of its own, so the only start in the pause is the call's.
        const { supervisor, starts, failures, pidOf } = yield* supervised({
          backoff: {
            initial: Duration.seconds(1),
            max: Duration.seconds(1),
            stable: Duration.seconds(30),
          },
          restarts: 0,
        });
        yield* Effect.scoped(
          Effect.flatMap(supervisor.use("notes"), (session) => answerOf(session, "exit")),
        );
        yield* eventually(Effect.map(Ref.get(failures), (all) => all.length === 1));
        const waiting = yield* Effect.forkChild(pidOf("notes"));
        yield* eventually(Effect.map(supervisor.running, (running) => running.includes("notes")));
        yield* supervisor.stop("notes");
        assert.isTrue(Exit.isFailure(yield* Fiber.await(waiting)));
        const fresh = yield* pidOf("notes");
        yield* Effect.sleep(Duration.millis(1_500));
        assert.strictEqual((yield* Ref.get(starts)).length, 2);
        yield* supervisor.stop("notes");
        assert.isFalse(alive(fresh));
        assert.deepStrictEqual(yield* supervisor.running, []);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "counts every start that fails, however long it took, against the restarts",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const supervisor = yield* makeSupervisor<string>({
          start: () =>
            Ref.update(attempts, (n) => n + 1).pipe(
              Effect.andThen(Effect.sleep(Duration.millis(150))),
              Effect.andThen(Effect.fail(new CommandFailed({ reason: "exited" }))),
            ),
          onFailure: () => Effect.void,
          idle: Duration.minutes(1),
          capacity: 2,
          backoff: {
            initial: Duration.millis(10),
            max: Duration.millis(10),
            stable: Duration.millis(100),
          },
          restarts: 2,
        });
        yield* Effect.flip(Effect.scoped(supervisor.use("slow")));
        yield* Effect.sleep(Duration.seconds(2));
        // The use's start, then two restarts.
        assert.strictEqual(yield* Ref.get(attempts), 3);
      }).pipe(Effect.scoped),
    SLOW,
  );

  it.live(
    "stops a process that writes too long a message though no call waits on it",
    () =>
      Effect.gen(function* () {
        const { failures, pidOf, supervisor } = yield* supervised();
        const pid = yield* pidOf("notes");
        yield* Effect.scoped(
          Effect.flatMap(supervisor.use("notes"), (session) => answerOf(session, "flood")),
        );
        yield* eventually(Effect.map(Ref.get(failures), (all) => all.length > 0));
        assert.deepStrictEqual(
          (yield* Ref.get(failures)).map((failure) => failure._tag),
          ["CommandFailed"],
        );
        assert.isFalse(alive(pid));
      }).pipe(Effect.scoped),
    SLOW,
  );
});
