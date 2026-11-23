// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { engineEnvironment } from "./Command.ts";
import { inJob } from "./WindowsJob.ts";

/**
 * A stand-in engine. It starts a harness that runs until it is ended, and a
 * second one through a process that exits at once, so that the harness has
 * lost its parent, as a harness's own children do once the harness ends.
 * It writes both ids, its arguments and its environment's names to the file
 * its first argument names, then runs until it is ended, or exits with the
 * code its second argument gives.
 */
const ENGINE_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [file, code, ...rest] = process.argv.slice(1);
const forever = ["-e", "setInterval(() => {}, 1000)"];
const harness = spawn(process.execPath, forever, { stdio: "ignore" });
const middle = spawn(process.execPath, ["-e", ${JSON.stringify(
  `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }); c.unref(); console.log(c.pid);`,
)}], { stdio: ["ignore", "pipe", "ignore"] });
let orphan = "";
middle.stdout.on("data", (chunk) => (orphan += chunk));
middle.on("exit", () => {
  fs.writeFileSync(file, JSON.stringify({
    harness: harness.pid,
    orphan: Number(orphan.trim()),
    args: rest,
    environment: Object.keys(process.env),
  }));
  if (code !== "run") process.exit(Number(code));
  setInterval(() => {}, 1000);
});
`;

const Report = Schema.Struct({
  harness: Schema.Int,
  orphan: Schema.Int,
  args: Schema.Array(Schema.String),
  environment: Schema.Array(Schema.String),
});
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report));

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

/** Whether `pids` are all gone within ten seconds. */
const allGone = (pids: ReadonlyArray<number>) =>
  Effect.sync(() => pids.filter(isRunning)).pipe(
    Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: (left) => left.length === 0 }),
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.getOrElse(() => pids.filter(isRunning))),
  );

/** Ends `pids` when the test's scope closes, so that no test leaves a process behind. */
const endWithTest = (pids: ReadonlyArray<number>) =>
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }),
  );

/** The arguments the stand-in is given after its own, which the launcher must pass as they are. */
const ARGS = [
  "serve",
  "--base-dir",
  String.raw`C:\Users\Sam Lee\J3 Bots\home\engine`,
  'a "quoted" word',
  "",
  "C:\\ends with\\",
];

/** The environment the stand-in is started with: the engine's, and one of the test's own. */
const environment = { ...engineEnvironment(process.env, "win32"), J3_JOB_TEST: "1" };

/** Starts the stand-in engine through the launcher; the launcher, the engine's id and its report. */
const launch = (code: "run" | number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const file = path.join(yield* fs.makeTempDirectoryScoped(), "report.json");
    const launched = inJob(environment, process.execPath, [
      "-e",
      ENGINE_SCRIPT,
      file,
      String(code),
      ...ARGS,
    ]);
    const launcher = yield* spawner.spawn(
      ChildProcess.make(launched.command, launched.args, {
        stdin: "ignore",
        stderr: "ignore",
        env: environment,
        extendEnv: false,
      }),
    );
    const engine = yield* launcher.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runHead,
      Effect.flatMap((line) => Effect.fromOption(line)),
      Effect.map(Number),
      Effect.timeout("60 seconds"),
    );
    const report = yield* fs
      .readFileString(file)
      .pipe(
        Effect.retry(Schedule.spaced("200 millis")),
        Effect.timeout("30 seconds"),
        Effect.flatMap(decodeReport),
      );
    yield* endWithTest([Number(launcher.pid), engine, report.harness, report.orphan]);
    return { launcher, engine, report };
  });

describe.runIf(process.platform === "win32")("inJob", () => {
  it.live(
    "ends what the engine started once the engine has ended, also what lost its parent",
    () =>
      Effect.gen(function* () {
        const { launcher, engine, report } = yield* launch("run");
        assert.isTrue(isRunning(report.harness));
        assert.isTrue(isRunning(report.orphan));

        // Only the engine ends, as in a crash.
        process.kill(engine, "SIGKILL");
        assert.strictEqual(Number(yield* launcher.exitCode.pipe(Effect.timeout("30 seconds"))), 1);
        assert.deepStrictEqual(yield* allGone([engine, report.harness, report.orphan]), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  );

  it.live(
    "ends the engine and everything it started when the launcher itself is ended",
    () =>
      Effect.gen(function* () {
        const { launcher, engine, report } = yield* launch("run");
        process.kill(Number(launcher.pid), "SIGKILL");
        assert.deepStrictEqual(yield* allGone([engine, report.harness, report.orphan]), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  );

  it.live(
    "passes the engine its arguments and its environment as given, and exits with its code",
    () =>
      Effect.gen(function* () {
        const { launcher, report } = yield* launch(7);
        assert.strictEqual(Number(yield* launcher.exitCode.pipe(Effect.timeout("30 seconds"))), 7);
        assert.deepStrictEqual(report.args, ARGS);
        const names = (list: Iterable<string>) =>
          [...list].map((name) => name.toUpperCase()).sort();
        assert.deepStrictEqual(names(report.environment), names(Object.keys(environment)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  );
});
