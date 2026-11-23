// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { listSnapshots, takeSnapshot } from "../install/snapshot.ts";
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
 * named in `failing` starts, migrates, then exits before it is ready.
 */
const hostOn = Effect.fn(function* (failing: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const database = path.join(home, "j3.sqlite");
  yield* fs.writeFileString(database, `data of ${OLD.version}`);
  const releases: Record<Side, string> = { old: OLD.version, new: NEW.version };
  const host = {
    running: Option.some<Side>("old"),
    log: [] as Array<string>,
    pruned: [] as Array<readonly [string, string]>,
  };
  const steps: HostSteps<FileSystem.FileSystem> = {
    supervised: true,
    stop: Effect.sync(() => {
      host.log.push("stop");
      host.running = Option.none();
    }),
    disable: Effect.sync(() => {
      host.log.push("disable");
      host.running = Option.none();
    }),
    start: (side) =>
      Effect.gen(function* () {
        host.log.push(`start ${releases[side]}`);
        if (side === "new") yield* fs.writeFileString(database, `data of ${NEW.version}`);
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
        const version = releases[side];
        if (failing.includes(version)) return { _tag: "exited", reason: "it exited with code 1" };
        return {
          _tag: "running",
          pid: Option.some(42),
          answer: Option.some({ version, pid: 42, engine: { state: { _tag: "ready" } } }),
        };
      }),
    adopt: (side) => Effect.sync(() => host.log.push(`adopt ${releases[side]}`)),
    pruneRuntimes: (keep) => Effect.sync(() => host.pruned.push(keep)),
  };
  const lock = yield* TransitionLock.hold(home, () => "busy" as const);
  return { home, database, host, steps, lock };
});

it.layer(NodeServices.layer)("a version transition", (it) => {
  it.effect("records the new release once it is ready, and keeps two of everything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, database, host, steps, lock } = yield* hostOn([]);
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
      const record = yield* readRuntimeRecord(home);
      assert.isTrue(record._tag === "recorded" && record.record.version === "0.3.1");
      assert.isTrue(record._tag === "recorded" && record.record.rollback === undefined);
    }),
  );

  it.effect(
    "rolls back to the old release when the new one never becomes ready, and records it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, database, host, steps, lock } = yield* hostOn([NEW.version]);

        const { outcome, recording } = yield* transition({ lock, from: OLD, to: NEW, steps });

        assert.strictEqual(outcome._tag, "rolled-back");
        if (outcome._tag !== "rolled-back") return;
        assert.strictEqual(outcome.failed.step, "await-new");
        assert.include(outcome.failed.reason, "it exited with code 1");
        assert.isTrue(Option.isSome(outcome.restored));
        assert.isTrue(Option.isNone(recording));
        assert.deepStrictEqual(host.log, ["stop", "start 0.3.1", "disable", "start 0.3.0"]);
        assert.isTrue(Option.contains(host.running, "old"));
        assert.strictEqual(
          yield* fs.readFileString(database),
          "data of 0.3.0",
          "the old release runs on the data put back",
        );
        const [snapshot] = yield* listSnapshots(home);
        assert.isTrue(
          snapshot !== undefined && Option.isNone(snapshot.restoring),
          "the rollback finished",
        );
        assert.deepStrictEqual(host.pruned, [], "nothing is pruned after a failed update");
        const record = yield* readRuntimeRecord(home);
        assert.isTrue(record._tag === "recorded");
        if (record._tag !== "recorded") return;
        assert.strictEqual(record.record.version, "0.3.0");
        assert.deepStrictEqual(record.record.rollback, { from: "0.3.1" });
      }),
  );

  it.effect("takes a snapshot only for a change of release, and refuses going back", () =>
    Effect.gen(function* () {
      const { home, steps, lock } = yield* hostOn([]);
      yield* transition({ lock, from: OLD, to: NEW, steps });
      const facts = {
        recorded: yield* readRuntimeRecord(home),
        kept: [OLD.version, NEW.version],
        rollingBackTo: Option.none<string>(),
      };
      assert.strictEqual(decideStart({ ...facts, starting: NEW.version }), "start");
      assert.strictEqual(decideStart({ ...facts, starting: "0.3.2" }), "snapshot-then-start");
      assert.strictEqual(decideStart({ ...facts, starting: OLD.version }), "refuse-downgrade");
    }),
  );

  it.effect("records the old release after a rollback the operator asks for", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, database, host, steps, lock } = yield* hostOn([]);
      const { outcome } = yield* transition({ lock, from: OLD, to: NEW, steps });
      assert.strictEqual(outcome._tag, "updated");
      if (outcome._tag !== "updated") return;
      host.log.length = 0;

      const { failed, recording } = yield* rollBack({ lock, snapshot: outcome.snapshot, steps });

      assert.isTrue(Option.isNone(failed) && Option.isNone(recording));
      assert.deepStrictEqual(host.log, ["disable", "start 0.3.0", "adopt 0.3.0"]);
      assert.strictEqual(yield* fs.readFileString(database), "data of 0.3.0");
      const record = yield* readRuntimeRecord(home);
      assert.isTrue(record._tag === "recorded");
      if (record._tag !== "recorded") return;
      assert.strictEqual(record.record.version, "0.3.0");
      assert.deepStrictEqual(record.record.rollback, { from: "0.3.1" });
    }),
  );

  it.effect("is one at a time on a home", () =>
    Effect.gen(function* () {
      const { home } = yield* hostOn([]);
      const second = yield* Effect.exit(TransitionLock.hold(home, () => "busy" as const));
      const refusal = Exit.isFailure(second) ? Exit.findErrorOption(second) : Option.none();
      assert.isTrue(Option.contains(refusal, "busy"));
    }),
  );
});
