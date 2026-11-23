// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeProcesses, servesHome, stopPlan, windowsCommandWords } from "./Processes.ts";

describe("windowsCommandWords", () => {
  it("splits as the C runtime does: quotes group, and backslashes count only before a quote", () => {
    assert.deepStrictEqual(
      windowsCommandWords(
        String.raw`"C:\Program Files\J3 Bots\t3.exe" serve --base-dir "C:\Users\Sam\AppData\Roaming\J3 Bots\server\home\engine" --port 3748`,
      ),
      [
        String.raw`C:\Program Files\J3 Bots\t3.exe`,
        "serve",
        "--base-dir",
        String.raw`C:\Users\Sam\AppData\Roaming\J3 Bots\server\home\engine`,
        "--port",
        "3748",
      ],
    );
    assert.deepStrictEqual(windowsCommandWords(String.raw`a\\\"b "c\\" d\e "f""g"`), [
      String.raw`a\"b`,
      "c\\",
      String.raw`d\e`,
      'f"g',
    ]);
    assert.deepStrictEqual(windowsCommandWords(' \t one  ""  two '), ["one", "", "two"]);
  });
});

describe("servesHome", () => {
  const home = String.raw`C:\Users\Sam\AppData\Roaming\J3 Bots\server\home\engine`;

  it("on Windows, finds the engine's own data directory, quoted or not, in any case", () => {
    const line = (baseDir: string) =>
      String.raw`C:\home\engine\j3\runtime\0.1.11\t3.exe serve --base-dir ${baseDir} --port 3748 --host 127.0.0.1 --no-browser`;
    assert.isTrue(servesHome("win32", line(`"${home}"`), home));
    assert.isTrue(servesHome("win32", line(`"${home.toLowerCase()}\\\\"`), home));
    assert.isTrue(servesHome("win32", line(String.raw`C:\j3\engine`), String.raw`C:\j3\engine`));
  });

  it("on Windows, refuses another data directory, one inside it, and a program that is not serving", () => {
    const line = (baseDir: string, command = "serve") =>
      String.raw`C:\t3.exe ${command} --base-dir "${baseDir}" --port 3748`;
    assert.isFalse(servesHome("win32", line(`${home}2`), home));
    assert.isFalse(servesHome("win32", line(String.raw`${home}\userdata`), home));
    assert.isFalse(servesHome("win32", line(home, "doctor"), home));
    assert.isFalse(servesHome("win32", String.raw`notepad.exe "${home}"`, home));
  });

  it("elsewhere, takes the data directory as `ps` prints it, words joined by spaces", () => {
    const unixHome = "/home/sam/.j3-bots/engine";
    const line = (baseDir: string) =>
      `/home/sam/.j3-bots/engine/j3/runtime/0.1.11/t3 serve --base-dir ${baseDir} --port 3738 --host 127.0.0.1 --no-browser`;
    assert.isTrue(servesHome("linux", line(unixHome), unixHome));
    assert.isFalse(servesHome("linux", line(`${unixHome}2`), unixHome));
    assert.isFalse(servesHome("linux", line(`${unixHome}/userdata`), unixHome));
    assert.isFalse(servesHome("linux", `vim ${unixHome}`, unixHome));
  });
});

describe("stopPlan", () => {
  it("signals where there are signals, and kills the tree on Windows, which has none", () => {
    assert.deepStrictEqual(stopPlan("linux", Duration.seconds(10)), {
      _tag: "signals",
      grace: Duration.seconds(10),
    });
    assert.deepStrictEqual(stopPlan("win32", Duration.seconds(10)), { _tag: "tree-kill" });
  });
});

/**
 * A Node process that starts a child of its own, prints the child's pid, and
 * waits, like an engine with a harness under it. It ignores SIGTERM, so on
 * Linux the stop has to reach SIGKILL.
 */
const PARENT_SCRIPT = [
  "process.on('SIGTERM', () => {});",
  "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "console.log(child.pid);",
  "setInterval(() => {}, 1000);",
].join(" ");

describe("makeProcesses", () => {
  it.live(
    "reads a running process's command line, and stops it; on Windows, with what it started",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const processes = yield* makeProcesses(process.platform, process.env);
        const marker = `j3-processes-test-${process.pid}`;
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", PARENT_SCRIPT, marker], {
            stdin: "ignore",
            stderr: "inherit",
          }),
        );
        const parent = Number(handle.pid);
        const child = yield* handle.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
          Effect.flatMap((line) => Effect.fromOption(line)),
          Effect.map(Number),
          Effect.timeout("30 seconds"),
        );
        // Whatever the stop leaves running is ended here, so no test leaves a process behind.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [parent, child]) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // Already gone.
              }
            }
          }),
        );

        const line = yield* processes.commandLine(parent);
        assert.isTrue(
          Option.exists(line, (found) => found.includes(marker)),
          String(line),
        );
        assert.isTrue(yield* processes.isAlive(parent));
        assert.isTrue(yield* processes.isAlive(child));

        const gone = yield* processes.stop(
          parent,
          stopPlan(process.platform, Duration.seconds(1)),
          Duration.seconds(10),
        );
        assert.isTrue(gone);
        assert.isFalse(yield* processes.isAlive(parent));
        assert.isTrue(Option.isNone(yield* processes.commandLine(parent)));
        // Windows ends the tree; elsewhere the engine's harnesses live in scopes of their own.
        if (process.platform === "win32") {
          const childGone = yield* processes
            .isAlive(child)
            .pipe(
              Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (alive) => !alive }),
              Effect.timeoutOption("10 seconds"),
            );
          assert.isTrue(Option.isSome(childGone));
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );
});
