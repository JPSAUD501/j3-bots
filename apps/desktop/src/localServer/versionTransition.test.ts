// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Transition from "@j3-bots/server/transition";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { AdminRefused, type AdminChannel } from "./adminChannel.ts";
import * as Runtime from "./runtime.ts";
import type { RunningServer, ServerExit } from "./supervisor.ts";
import * as VersionTransition from "./versionTransition.ts";

const OLD = "0.3.0";
const NEW = "0.3.1";

/** Lays out a runtime of `version` at `source`, as a package carries it. */
const packaged = Effect.fn(function* (source: string, version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(source, { recursive: true, force: true });
  yield* fs.makeDirectory(path.join(source, "node", "bin"), { recursive: true });
  yield* fs.makeDirectory(path.join(source, "server"), { recursive: true });
  yield* fs.writeFileString(path.join(source, "node", "bin", "node"), `node for ${version}`);
  yield* fs.writeFileString(path.join(source, "server", "bin.mjs"), `server ${version}`);
  yield* fs.writeFileString(
    path.join(source, "release.json"),
    JSON.stringify({ version, engine: `engine-of-${version}` }),
  );
});

/**
 * A computer on which the app ran `ran` on its home: its runtime kept, its
 * database as that release left it, and the record saying so. Its servers
 * are fakes that each migrate the database to their release as they start;
 * a release in `failing` then exits before it is ready, and one in `killedAt`
 * takes the app down with it, once, as the system killing it there would,
 * and one in `lockingState` leaves the home's `state` folder read-only.
 * `startedOn` says, for each start, the data the release found.
 */
const computer = Effect.fn(function* (ran: string = OLD) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-transition-" });
  const home = path.join(root, "home");
  const runtimes = path.join(root, "server-runtime");
  const source = path.join(root, "package");
  const database = path.join(home, "j3.sqlite");
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.writeFileString(database, `data of ${ran}`);
  yield* packaged(source, ran);
  yield* Runtime.install({ source, folder: runtimes });
  yield* Transition.recordReady(home, ran);
  const state = path.join(home, "state");
  yield* Effect.addFinalizer(() => fs.chmod(state, 0o700).pipe(Effect.ignore));

  const host = {
    startedOn: [] as Array<string>,
    failing: new Set<string>(),
    killedAt: new Set<string>(),
    lockingState: new Set<string>(),
    /**
     * How long a release takes to serve, as on a slow computer. It reads its
     * pipe only then, so a request that gives up sooner closes the pipe, and
     * every later one fails. No time passes: the first request is answered at
     * once, by whether its deadline would have outlasted the wait.
     */
    slowToServe: new Map<string, Duration.Duration>(),
  };
  let pid = 100;

  const run = (runtime: Runtime.Runtime) =>
    Effect.gen(function* () {
      const { version } = runtime;
      host.startedOn.push(`${version} on ${yield* fs.readFileString(database)}`);
      yield* fs.writeFileString(database, `data of ${version}`);
      if (host.killedAt.delete(version)) return yield* Effect.die("the app was killed");
      if (host.lockingState.delete(version)) yield* fs.chmod(state, 0o500);
      pid += 1;
      const exited = yield* Deferred.make<ServerExit>();
      const end = (exit: ServerExit) => Deferred.succeed(exited, exit).pipe(Effect.asVoid);
      const failing = host.failing.has(version);
      if (failing) yield* end({ code: 1, signal: null });
      const servesAfter = host.slowToServe.get(version);
      let pipe: "waiting" | "read" | "closed" = servesAfter === undefined ? "read" : "waiting";
      const admin: AdminChannel = {
        status: (deadline = Duration.seconds(30)) =>
          Effect.gen(function* () {
            if (pipe === "waiting" && servesAfter !== undefined) {
              pipe = Duration.isLessThan(Duration.fromInputUnsafe(deadline), servesAfter)
                ? "closed"
                : "read";
            }
            if (pipe === "closed" || (yield* Deferred.isDone(exited))) {
              return yield* new AdminRefused({ route: "/status", status: 503 });
            }
            return {
              version,
              pid,
              listener: { port: 3747 },
              engine: { state: { _tag: "ready" } },
            };
          }),
        localDevice: () => Effect.die("not used here"),
        shutdown: end({ code: 0, signal: null }),
      };
      return {
        pid,
        admin,
        exited: Deferred.await(exited),
        logTail: Effect.succeed(
          failing
            ? `starting J3 Bots ${version}\nerror: the engine could not be started`
            : `starting J3 Bots ${version}`,
        ),
        terminate: end({ code: 0, signal: "SIGTERM" }).pipe(Effect.as(true)),
        kill: end({ code: null, signal: "SIGKILL" }),
      } satisfies RunningServer;
    }).pipe(Effect.orDie);

  /** The app, as a release of `version` starts it: a new run of it each time. */
  const app = Effect.fn(function* (version: string) {
    yield* packaged(source, version);
    return yield* VersionTransition.make({
      home,
      source,
      bundled: { version, engine: `engine-of-${version}` },
      runtimes,
      platform: "linux",
      run,
    });
  });

  /** The release the server a start gave answers as. */
  const versionOf = (server: RunningServer) =>
    Effect.map(server.admin.status(), (status) => status.version);

  const record = Effect.gen(function* () {
    const read = yield* Transition.readRuntimeRecord(home);
    assert.strictEqual(read._tag, "recorded", "the home's record");
    return read._tag === "recorded" ? Option.some(read.record) : Option.none();
  });

  return { home, runtimes, database, host, app, versionOf, record };
});

describe("the version of the server on this computer", () => {
  it.live("moves the data to the app's release at its first start, and keeps the two", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const here = yield* computer();
      const versions = yield* here.app(NEW);

      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), NEW);
      assert.deepStrictEqual(here.host.startedOn, [`${NEW} on data of ${OLD}`]);
      assert.strictEqual(yield* fs.readFileString(here.database), `data of ${NEW}`);
      assert.strictEqual(Option.getOrThrow(yield* here.record).version, NEW);
      const snapshots = yield* Transition.listSnapshots(here.home);
      assert.strictEqual(snapshots.length, 1);
      assert.deepStrictEqual(snapshots[0]?.manifest.from, {
        version: OLD,
        engine: `engine-of-${OLD}`,
      });
      assert.deepStrictEqual((yield* Runtime.kept(here.runtimes)).sort(), [OLD, NEW]);
      // The page hears of the update until the server answers.
      assert.deepStrictEqual(Option.getOrNull(yield* versions.update), {
        _tag: "updating",
        from: OLD,
        to: NEW,
      });
      yield* versions.onReady;
      assert.isTrue(Option.isNone(yield* versions.update));

      // The next start runs it as it is, and records it once it answers.
      const again = yield* (yield* here.app(NEW)).launch;
      assert.strictEqual(yield* here.versionOf(again), NEW);
      assert.strictEqual((yield* Transition.listSnapshots(here.home)).length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("removes the runtimes of other releases only once the new one runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const here = yield* computer();
      const older = path.join(here.home, "..", "older-package");
      yield* packaged(older, "0.2.9");
      yield* Runtime.install({ source: older, folder: here.runtimes });
      yield* fs.remove(older, { recursive: true });
      here.host.failing.add(NEW);

      yield* (yield* here.app(NEW)).launch;
      assert.deepStrictEqual((yield* Runtime.kept(here.runtimes)).sort(), ["0.2.9", OLD, NEW]);

      here.host.failing.clear();
      const versions = yield* here.app(NEW);
      yield* versions.launch;
      assert.isTrue(yield* versions.retry);
      yield* versions.launch;
      assert.deepStrictEqual((yield* Runtime.kept(here.runtimes)).sort(), [OLD, NEW]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("waits for a new release that is slow to serve, without losing its pipe", () =>
    Effect.gen(function* () {
      const here = yield* computer();
      here.host.slowToServe.set(NEW, Duration.seconds(20));
      const versions = yield* here.app(NEW);

      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), NEW);
      assert.strictEqual(Option.getOrThrow(yield* here.record).version, NEW);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rolls back to the release that ran when the app's does not become ready", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const here = yield* computer();
      here.host.failing.add(NEW);
      const versions = yield* here.app(NEW);

      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), OLD);
      // The old release started on its own data, put back, not on the migrated one.
      assert.deepStrictEqual(here.host.startedOn, [
        `${NEW} on data of ${OLD}`,
        `${OLD} on data of ${OLD}`,
      ]);
      assert.strictEqual(yield* fs.readFileString(here.database), `data of ${OLD}`);
      const record = Option.getOrThrow(yield* here.record);
      assert.strictEqual(record.version, OLD);
      assert.deepStrictEqual(record.rollback, { from: NEW });

      const update = Option.getOrThrow(yield* versions.update);
      assert.strictEqual(update._tag, "rolled-back");
      if (update._tag !== "rolled-back") return;
      assert.strictEqual(update.running, OLD);
      assert.strictEqual(update.failed, NEW);
      assert.include(update.reason ?? "", "exit code 1");
      assert.include(update.logTail ?? "", "the engine could not be started");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says the update failed when the release before runs, unrecorded", () =>
    Effect.gen(function* () {
      const here = yield* computer();
      here.host.failing.add(NEW);
      here.host.lockingState.add(OLD);
      const versions = yield* here.app(NEW);

      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), OLD);
      const update = Option.getOrThrow(yield* versions.update);
      assert.strictEqual(update._tag, "rolled-back");
      if (update._tag !== "rolled-back") return;
      assert.strictEqual(update.running, OLD);
      assert.strictEqual(update.failed, NEW);
      assert.include(update.reason ?? "", "exit code 1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps running the release it rolled back to, and tries the app's again when asked", () =>
    Effect.gen(function* () {
      const here = yield* computer();
      here.host.failing.add(NEW);
      yield* (yield* here.app(NEW)).launch;
      here.host.failing.clear();
      here.host.startedOn.length = 0;

      // The app opened again: the release it rolled back from is not tried by itself.
      const versions = yield* here.app(NEW);
      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), OLD);
      assert.deepStrictEqual(here.host.startedOn, [`${OLD} on data of ${OLD}`]);
      assert.deepStrictEqual(Option.getOrNull(yield* versions.update), {
        _tag: "rolled-back",
        running: OLD,
        failed: NEW,
      });

      assert.isTrue(yield* versions.retry);
      // The line says so as soon as the server that runs stops for it.
      assert.deepStrictEqual(Option.getOrNull(yield* versions.update), {
        _tag: "updating",
        from: OLD,
        to: NEW,
      });
      const retried = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(retried), NEW);
      assert.strictEqual(Option.getOrThrow(yield* here.record).version, NEW);
      yield* versions.onReady;
      assert.isTrue(Option.isNone(yield* versions.update));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a Try again that found the data busy for the next start", () =>
    Effect.gen(function* () {
      const here = yield* computer();
      here.host.failing.add(NEW);
      const versions = yield* here.app(NEW);
      yield* versions.launch;
      here.host.failing.clear();

      assert.isTrue(yield* versions.retry);
      // Another change to the data holds it, as an update from the command line would.
      const busy = yield* Effect.scoped(
        Effect.andThen(
          Transition.TransitionLock.hold(here.home, () => "busy"),
          Effect.flip(versions.launch),
        ),
      );
      assert.isTrue(busy.retry);
      // No update is under way while the supervisor waits to start again.
      assert.isTrue(Option.isNone(yield* versions.update));
      assert.strictEqual(Option.getOrThrow(yield* here.record).version, OLD);

      const retried = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(retried), NEW);
      assert.strictEqual(Option.getOrThrow(yield* here.record).version, NEW);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says how to let it lock the data when it cannot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const here = yield* computer();
      const backups = path.join(here.home, "backups");
      yield* Effect.acquireRelease(fs.makeDirectory(backups, { mode: 0o500 }), () =>
        fs.chmod(backups, 0o700).pipe(Effect.orDie),
      );

      const refused = yield* Effect.flip((yield* here.app(OLD)).launch);
      assert.include(refused.reason, path.join(backups, "update.lock"));
      assert.strictEqual(
        refused.fix,
        "Check that this user can write to the folder that holds it.",
      );
      assert.deepStrictEqual(here.host.startedOn, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs the newer release the data was handed to while the app is older", () =>
    Effect.gen(function* () {
      const here = yield* computer(NEW);
      const versions = yield* here.app(OLD);
      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), NEW);
      assert.deepStrictEqual(here.host.startedOn, [`${NEW} on data of ${NEW}`]);
      assert.deepStrictEqual(Option.getOrNull(yield* versions.update), {
        _tag: "older-app",
        running: NEW,
        app: OLD,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts nothing on data a newer release it does not keep was handed to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const here = yield* computer(NEW);
      yield* fs.remove(path.join(here.runtimes, NEW), { recursive: true });
      const refused = yield* Effect.flip((yield* here.app(OLD)).launch);
      assert.isFalse(refused.retry);
      assert.include(refused.reason, `J3 Bots ${NEW}`);
      assert.deepStrictEqual(here.host.startedOn, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("finishes a rollback the app was killed in, at its next start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const here = yield* computer();
      here.host.failing.add(NEW);
      here.host.killedAt.add(OLD);
      const killed = yield* Effect.exit((yield* here.app(NEW)).launch);
      assert.isTrue(Exit.isFailure(killed), "the app was killed");
      assert.isTrue(Option.isSome(yield* Transition.unfinishedRollback(here.home)));
      here.host.startedOn.length = 0;

      const versions = yield* here.app(NEW);
      const server = yield* versions.launch;
      assert.strictEqual(yield* here.versionOf(server), OLD);
      assert.strictEqual(yield* fs.readFileString(here.database), `data of ${OLD}`);
      assert.isTrue(Option.isNone(yield* Transition.unfinishedRollback(here.home)));
      assert.deepStrictEqual(Option.getOrThrow(yield* here.record).rollback, { from: NEW });
      assert.strictEqual(Option.getOrThrow(yield* versions.update)._tag, "rolled-back");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("carries on an update the app was killed in, with the snapshot it took", () =>
    Effect.gen(function* () {
      const here = yield* computer();
      here.host.killedAt.add(NEW);
      const killed = yield* Effect.exit((yield* here.app(NEW)).launch);
      assert.isTrue(Exit.isFailure(killed), "the app was killed");
      here.host.startedOn.length = 0;

      const server = yield* (yield* here.app(NEW)).launch;
      assert.strictEqual(yield* here.versionOf(server), NEW);
      // No second snapshot: the data may be the new release's already.
      assert.strictEqual((yield* Transition.listSnapshots(here.home)).length, 1);
      assert.deepStrictEqual(here.host.startedOn, [`${NEW} on data of ${NEW}`]);
      const record = Option.getOrThrow(yield* here.record);
      assert.strictEqual(record.version, NEW);
      assert.isUndefined(record.pending);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("takes over a server left running only when a start would run it as it is", () =>
    Effect.gen(function* () {
      const here = yield* computer();
      const asked: Array<Option.Option<string>> = [];
      const takeOver = (version: Option.Option<string>) =>
        Effect.sync(() => {
          asked.push(version);
          return Option.none<RunningServer>();
        });
      // The app's release would be moved to first: whatever runs is stopped.
      yield* (yield* here.app(NEW)).adopt(takeOver);
      // The release that ran, which an older app runs as it is.
      yield* (yield* here.app(OLD)).adopt(takeOver);
      assert.deepStrictEqual(asked, [Option.none(), Option.some(OLD)]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
