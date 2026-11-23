// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { listSnapshots, takeSnapshot, unfinishedRollback } from "../install/snapshot.ts";
import { type ServerProbe } from "./readiness.ts";
import { decideStart, readRuntimeRecord } from "./record.ts";
import { type Side, StepFailed } from "./switch.ts";
import { type HostSteps, rollBack, transition, TransitionLock } from "./transition.ts";

const OLD = { version: "0.3.0" };
const NEW = { version: "0.3.1" };

/**
 * A home with J3 Bots' database as the old release left it, and a host as a
 * desktop app runs one: a child process per start. The new release migrates
 * the database as it starts, which the old one cannot read back. A release
 * in `failing` starts, migrates, then exits before it is ready; `crashAt`
 * names a step that never returns, as when the app is killed there, and
 * `beforeStart` runs as a release starts.
 */
const hostOn = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const database = path.join(home, "j3.sqlite");
  yield* fs.writeFileString(database, `data of ${OLD.version}`);
  const host = {
    running: Option.some<Side>("old"),
    log: [] as Array<string>,
    pruned: [] as Array<readonly [string, string]>,
    failing: new Set<string>(),
    crashAt: Option.none<"adopt">(),
    beforeStart: (_version: string): Effect.Effect<void> => Effect.void,
    stopping: Effect.void as Effect.Effect<void>,
  };
  const steps = (releases: Record<Side, { readonly version: string }>): HostSteps<never> => ({
    supervised: true,
    stop: Effect.suspend(() => {
      host.log.push("stop");
      host.running = Option.none();
      return host.stopping;
    }),
    disable: Effect.sync(() => {
      host.log.push("disable");
      host.running = Option.none();
    }),
    start: (side) =>
      Effect.gen(function* () {
        const { version } = releases[side];
        host.log.push(`start ${version}`);
        yield* host.beforeStart(version);
        if (side === "new") yield* fs.writeFileString(database, `data of ${version}`);
        host.running = Option.some(side);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new StepFailed({
              step: side === "new" ? "start-new" : "start-old",
              reason: cause.message,
            }),
        ),
      ),
    probe: (side) =>
      Effect.sync((): ServerProbe => {
        const { version } = releases[side];
        if (host.failing.has(version)) return { _tag: "exited", reason: "it exited with code 1" };
        return {
          _tag: "running",
          pid: Option.some(42),
          answer: Option.some({ version, pid: 42, engine: { state: { _tag: "ready" } } }),
        };
      }),
    adopt: (side) =>
      Option.isSome(host.crashAt)
        ? Effect.die("the app was killed")
        : Effect.sync(() => {
            host.log.push(`adopt ${releases[side].version}`);
          }),
    pruneRuntimes: (keep) =>
      Effect.sync(() => {
        host.pruned.push(keep);
      }),
  });
  const lock = yield* TransitionLock.hold(home, () => "busy" as const);
  return { home, database, host, steps, lock };
});

/** The home's record, which the test expects there. */
const recordOf = Effect.fn(function* (home: string) {
  const read = yield* readRuntimeRecord(home);
  assert.strictEqual(read._tag, "recorded", "the home's record");
  return read._tag === "recorded" ? Option.some(read.record) : Option.none();
});

it.layer(NodeServices.layer)("a version transition", (it) => {
  it.effect("records the new release once it is ready, and keeps two of everything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, database, host, steps, lock } = yield* hostOn();
      // Two updates before this one left their snapshots.
      for (const [from, to] of [
        ["0.2.0", "0.2.1"],
        ["0.2.1", "0.3.0"],
      ] as const) {
        yield* takeSnapshot({ home, from: { version: from }, to: { version: to } });
        yield* TestClock.adjust("1 second");
      }

      const { outcome, recording, pruning } = yield* transition({
        lock,
        from: OLD,
        to: NEW,
        steps,
      });

      assert.strictEqual(outcome._tag, "updated");
      assert.isTrue(Option.isNone(recording) && Option.isNone(pruning));
      assert.deepStrictEqual(host.log, ["stop", "start 0.3.1", "adopt 0.3.1"]);
      assert.strictEqual(yield* fs.readFileString(database), "data of 0.3.1");
      const snapshots = yield* listSnapshots(home);
      assert.deepStrictEqual(
        snapshots.map(({ manifest }) => [manifest.from.version, manifest.to.version]),
        [
          ["0.3.0", "0.3.1"],
          ["0.2.1", "0.3.0"],
        ],
      );
      const taken = snapshots[0];
      assert.isDefined(taken);
      if (taken === undefined) return;
      assert.strictEqual(
        yield* fs.readFileString(path.join(taken.folder, "j3.sqlite")),
        "data of 0.3.0",
        "the snapshot holds the data before the new release started",
      );
      assert.deepStrictEqual(host.pruned, [["0.3.0", "0.3.1"]]);
      const record = Option.getOrThrow(yield* recordOf(home));
      assert.strictEqual(record.version, "0.3.1");
      assert.isUndefined(record.rollback);
      assert.isUndefined(record.pending);
    }),
  );

  it.effect(
    "rolls back to the old release when the new one never becomes ready, and records it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, database, host, steps, lock } = yield* hostOn();
        host.failing.add(NEW.version);

        const { outcome, recording } = yield* transition({ lock, from: OLD, to: NEW, steps });

        assert.strictEqual(outcome._tag, "rolled-back");
        if (outcome._tag !== "rolled-back") return;
        assert.strictEqual(outcome.failed.step, "await-new");
        assert.include(outcome.failed.reason, "it exited with code 1");
        assert.isTrue(Option.isSome(outcome.restored));
        assert.isTrue(Option.isNone(recording));
        assert.deepStrictEqual(host.log, ["stop", "start 0.3.1", "disable", "start 0.3.0"]);
        assert.strictEqual(
          yield* fs.readFileString(database),
          "data of 0.3.0",
          "the old release runs on the data put back",
        );
        assert.isTrue(Option.isNone(yield* unfinishedRollback(home)), "the rollback finished");
        assert.deepStrictEqual(host.pruned, [], "nothing is pruned after a failed update");
        const record = Option.getOrThrow(yield* recordOf(home));
        assert.strictEqual(record.version, "0.3.0");
        assert.deepStrictEqual(record.rollback, { from: "0.3.1" });
        assert.isUndefined(record.pending);
        assert.strictEqual(
          decideStart({
            recorded: yield* readRuntimeRecord(home),
            starting: NEW.version,
            kept: [OLD.version, NEW.version],
            rollingBackTo: Option.none(),
          }),
          "refuse-rolled-back",
          "the release rolled back from is not tried again by itself",
        );
      }),
  );

  it.effect(
    "carries on with its own snapshot after it was cut off once the new release migrated",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, database, host, steps, lock } = yield* hostOn();
        // Killed once the new release ran and migrated, before the record said so.
        host.crashAt = Option.some("adopt");
        const cut = yield* Effect.exit(transition({ lock, from: OLD, to: NEW, steps }));
        assert.isTrue(Exit.isFailure(cut));
        assert.strictEqual(yield* fs.readFileString(database), "data of 0.3.1");
        const original = (yield* listSnapshots(home))[0];
        assert.isDefined(original);
        const pending = Option.getOrThrow(yield* recordOf(home)).pending;
        assert.strictEqual(pending?.from.version, OLD.version);

        // The next launch: the record still names the old release, with the transition pending.
        host.crashAt = Option.none();
        host.failing.add(NEW.version);
        host.log.length = 0;
        assert.strictEqual(
          decideStart({
            recorded: yield* readRuntimeRecord(home),
            starting: NEW.version,
            kept: [OLD.version, NEW.version],
            rollingBackTo: Option.none(),
          }),
          "snapshot-then-start",
        );
        yield* TestClock.adjust("1 minute");
        const { outcome, from } = yield* transition({ lock, from: OLD, to: NEW, steps });

        assert.strictEqual(from.version, OLD.version);
        assert.strictEqual(outcome._tag, "rolled-back");
        if (outcome._tag !== "rolled-back") return;
        assert.strictEqual(
          Option.getOrThrow(outcome.restored).folder,
          original?.folder,
          "the snapshot the cut-off transition took",
        );
        assert.lengthOf(yield* listSnapshots(home), 1, "no snapshot of the migrated data");
        assert.deepStrictEqual(host.log, ["stop", "start 0.3.1", "disable", "start 0.3.0"]);
        assert.strictEqual(yield* fs.readFileString(database), "data of 0.3.0");
        const record = Option.getOrThrow(yield* recordOf(home));
        assert.deepStrictEqual([record.version, record.rollback], ["0.3.0", { from: "0.3.1" }]);
        assert.isUndefined(record.pending);
      }),
  );

  it.effect("keeps the rollback marked until the record says the old release runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, database, host, steps, lock } = yield* hostOn();
      const record = path.join(home, "state", "runtime.json");
      host.failing.add(NEW.version);
      // A record that cannot be written: something that is not a file is in its place.
      host.beforeStart = (version) =>
        version === NEW.version
          ? fs
              .remove(record)
              .pipe(
                Effect.andThen(
                  fs.makeDirectory(path.join(record, "in-the-way"), { recursive: true }),
                ),
                Effect.orDie,
              )
          : Effect.void;

      const { outcome } = yield* transition({ lock, from: OLD, to: NEW, steps });

      assert.strictEqual(outcome._tag, "rollback-failed");
      if (outcome._tag !== "rollback-failed") return;
      assert.strictEqual(outcome.rollback.step, "record");
      const left = Option.getOrThrow(yield* unfinishedRollback(home));
      assert.deepStrictEqual(left.mark, { release: OLD.version, stage: "restored" });

      // The old release ran on the data put back; the next launch finishes the rollback.
      yield* fs.writeFileString(database, "data of 0.3.0, and a turn since");
      yield* fs.remove(record, { recursive: true });
      host.beforeStart = () => Effect.void;
      host.log.length = 0;
      const failed = yield* rollBack({ lock, snapshot: left.snapshot, steps });

      assert.isTrue(Option.isNone(failed));
      assert.deepStrictEqual(host.log, ["disable", "start 0.3.0", "adopt 0.3.0"]);
      assert.strictEqual(
        yield* fs.readFileString(database),
        "data of 0.3.0, and a turn since",
        "the snapshot is not copied over the old release's data again",
      );
      assert.isTrue(Option.isNone(yield* unfinishedRollback(home)));
      const after = Option.getOrThrow(yield* recordOf(home));
      assert.deepStrictEqual([after.version, after.rollback], ["0.3.0", { from: "0.3.1" }]);
    }),
  );

  it.effect("records the old release after a rollback the operator asks for", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, database, host, steps, lock } = yield* hostOn();
      const { outcome } = yield* transition({ lock, from: OLD, to: NEW, steps });
      assert.strictEqual(outcome._tag, "updated");
      if (outcome._tag !== "updated") return;
      host.log.length = 0;

      const failed = yield* rollBack({ lock, snapshot: outcome.snapshot, steps });

      assert.isTrue(Option.isNone(failed));
      assert.deepStrictEqual(host.log, ["disable", "start 0.3.0", "adopt 0.3.0"]);
      assert.strictEqual(yield* fs.readFileString(database), "data of 0.3.0");
      const record = Option.getOrThrow(yield* recordOf(home));
      assert.deepStrictEqual([record.version, record.rollback], ["0.3.0", { from: "0.3.1" }]);
    }),
  );

  it.effect("runs one operation at a time under a lock, and none once it is released", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { host, steps, lock } = yield* hostOn();
      const stopping = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      host.stopping = Deferred.succeed(stopping, undefined).pipe(
        Effect.andThen(Deferred.await(stopped)),
      );
      const first = yield* Effect.forkChild(transition({ lock, from: OLD, to: NEW, steps }));
      yield* Deferred.await(stopping);

      const second = yield* Effect.exit(transition({ lock, from: OLD, to: NEW, steps }));
      const refusal = Exit.isFailure(second) ? Exit.findErrorOption(second) : Option.none();
      assert.isTrue(
        Option.exists(
          refusal,
          (error) => error._tag === "TransitionLockUnusable" && error.reason === "in-use",
        ),
      );
      assert.deepStrictEqual(host.log, ["stop"], "the second ran no step of the host's");

      host.stopping = Effect.void;
      yield* Deferred.succeed(stopped, undefined);
      assert.strictEqual((yield* Fiber.join(first)).outcome._tag, "updated");

      // A lock whose scope closed is no lock: another process may hold the file now.
      const elsewhere = yield* fs.makeTempDirectoryScoped();
      const released = yield* Effect.scoped(TransitionLock.hold(elsewhere, () => "busy" as const));
      host.log.length = 0;
      const late = yield* Effect.exit(transition({ lock: released, from: NEW, to: OLD, steps }));
      const lateRefusal = Exit.isFailure(late) ? Exit.findErrorOption(late) : Option.none();
      assert.isTrue(
        Option.exists(
          lateRefusal,
          (error) => error._tag === "TransitionLockUnusable" && error.reason === "released",
        ),
      );
      assert.deepStrictEqual(host.log, []);
    }),
  );

  it.effect("is one at a time on a home", () =>
    Effect.gen(function* () {
      const { home } = yield* hostOn();
      const second = yield* Effect.exit(TransitionLock.hold(home, () => "busy" as const));
      const refusal = Exit.isFailure(second) ? Exit.findErrorOption(second) : Option.none();
      assert.isTrue(Option.contains(refusal, "busy"));
    }),
  );
});
