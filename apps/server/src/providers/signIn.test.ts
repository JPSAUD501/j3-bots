// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderId, type ProviderSignInStatus } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as TestEngine from "@j3-bots/engine-t3/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../config.ts";
import { HARNESSES } from "../engine/harnesses.ts";
import { openToOthers } from "../home/testPrivacy.ts";
import * as Host from "../system/Host.ts";
import { configFor } from "../testing/database.ts";
import { invocation, pageIn, prepareHome, signIn, signInCommand } from "./signIn.ts";
import * as SignIns from "./SignIns.ts";

/** What a stand-in harness prints and writes as its sign-in's secret, which must go nowhere else. */
const SECRET = "sk-ant-oat01-not-a-real-token";

it("runs each harness's own sign-in in J3 Bots' home for it, with only the variables a sign-in needs", () => {
  // The operator's shell points the harnesses at their own folders and endpoints.
  const kept = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/ada",
    LANG: "pt_BR.UTF-8",
    HTTPS_PROXY: "http://proxy.example:3128",
  };
  // What the engine's environment sets of its own, whatever the operator's shell holds.
  const engine = EngineLive.engineEnvironment({}, "linux");
  const shell = {
    ...kept,
    TERM: "xterm-256color",
    BROWSER: "firefox",
    DISPLAY: ":0",
    CLAUDE_CONFIG_DIR: "/home/ada/.claude-work",
    CODEX_HOME: "/home/ada/.codex-work",
    ANTHROPIC_BASE_URL: "https://elsewhere.example",
    OPENAI_API_KEY: "not-for-bots",
  };
  const home = "/home/ada/.j3-bots/providers/claude-code";
  assert.deepStrictEqual(
    signInCommand("claude-code", "/usr/local/bin/claude", home, shell, {
      deviceAuth: false,
      terminal: true,
      browser: null,
      platform: "linux",
    }),
    {
      command: "/usr/local/bin/claude",
      args: ["auth", "login"],
      env: {
        ...kept,
        ...engine,
        TERM: "xterm-256color",
        BROWSER: "firefox",
        DISPLAY: ":0",
        CLAUDE_CONFIG_DIR: home,
      },
    },
  );
  // Codex's code sign-in, for a machine reached over SSH.
  assert.deepStrictEqual(
    signInCommand("codex", "/usr/local/bin/codex", "/home/ada/.j3-bots/providers/codex", shell, {
      deviceAuth: true,
      terminal: true,
      browser: null,
      platform: "linux",
    }).args,
    ["login", "--device-auth"],
  );
  // With no terminal: no terminal variables, and the page goes to J3 Bots, not to Firefox.
  assert.deepStrictEqual(
    signInCommand("claude-code", "/usr/local/bin/claude", home, shell, {
      deviceAuth: false,
      terminal: false,
      browser: "/tmp/j3-sign-in-x/open-page",
      platform: "linux",
    }).env,
    {
      ...kept,
      ...engine,
      DISPLAY: ":0",
      BROWSER: "/tmp/j3-sign-in-x/open-page",
      CLAUDE_CONFIG_DIR: home,
    },
  );
});

it("runs a Windows .cmd shim through cmd.exe, every word quoted, and refuses what cmd.exe would read in quotes", () => {
  assert.deepStrictEqual(
    invocation("C:\\Tools\\claude.exe", ["auth", "login"], "win32"),
    Result.succeed({
      command: "C:\\Tools\\claude.exe",
      args: ["auth", "login"],
      shell: false,
    }),
  );
  // `&`, `^`, `(` and `)` in a folder's name are part of the path, not commands of their own.
  assert.deepStrictEqual(
    invocation("C:\\Users\\Ada\\R&D^(Co)\\npm\\codex.cmd", ["login", "C:\\Data\\"], "win32"),
    Result.succeed({
      command: '"C:\\Users\\Ada\\R&D^(Co)\\npm\\codex.cmd" "login" "C:\\Data\\\\"',
      args: [],
      shell: true,
    }),
  );
  for (const path of ["C:\\%PATH%\\codex.cmd", "C:\\Hi!\\codex.cmd", 'C:\\a"b\\codex.cmd']) {
    assert.isTrue(Result.isFailure(invocation(path, ["login"], "win32")), path);
  }
  // Elsewhere a `.cmd` is a file like another.
  assert.isFalse(invocation("/opt/codex.cmd", ["login"], "linux").pipe(Result.getOrThrow).shell);
});

it.layer(NodeServices.layer, { excludeTestServices: true })("a harness's home", (it) => {
  it.effect("gets no sign-in once others can open it, by its mode or its access list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataHome = yield* fs.makeTempDirectoryScoped();
      yield* fs.chmod(dataHome, 0o700);
      const home = yield* prepareHome("codex", dataHome);

      yield* openToOthers(home);
      const refused = yield* prepareHome("codex", dataHome).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "home-refused");
      assert.include(refused.message, home);
    }).pipe(Effect.scoped),
  );
});

// A real cmd.exe, which only Windows has.
it.layer(NodeServices.layer, { excludeTestServices: true })("cmd.exe", (it) => {
  it.effect.runIf(process.platform === "win32")(
    "runs a .cmd shim in a folder whose name cmd.exe would otherwise split, with its arguments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = path.join(yield* fs.makeTempDirectoryScoped(), "R&D^(Co)");
        yield* fs.makeDirectory(folder);
        const shim = path.join(folder, "stand-in.cmd");
        yield* fs.writeFileString(shim, '@echo off\r\n> "%~dp0args.txt" echo [%~1] [%~2]\r\n');
        const how = invocation(shim, ["auth", "login"], "win32").pipe(Result.getOrThrow);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const code = yield* spawner.exitCode(
          ChildProcess.make(how.command, how.args, { shell: how.shell }),
        );
        assert.strictEqual(code, 0);
        assert.strictEqual(
          (yield* fs.readFileString(path.join(folder, "args.txt"))).trim(),
          "[auth] [login]",
        );
      }).pipe(Effect.scoped),
  );
});

it("finds a harness on Windows as its .exe or its npm .cmd shim", () => {
  assert.deepStrictEqual(Host.executableNames("win32", ".COM;.EXE;.CMD")("codex"), [
    "codex.com",
    "codex.exe",
    "codex.cmd",
  ]);
  assert.deepStrictEqual(Host.executableNames("linux", ".EXE")("codex"), ["codex"]);
});

it("reads only the harness's own sign-in page in what it prints", () => {
  assert.strictEqual(
    pageIn(
      "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true\u001b[0m",
      "claude-code",
    ),
    "https://claude.ai/oauth/authorize?code=true",
  );
  // Another URL earlier on the line is passed over, and the page found after it.
  assert.strictEqual(
    pageIn(
      "Help: https://docs.example.com/login, then https://auth.openai.com/oauth/authorize?state=s",
      "codex",
    ),
    "https://auth.openai.com/oauth/authorize?state=s",
  );
  for (const line of [
    "Starting local login server on http://localhost:1455.",
    "Paste code here if prompted >",
    // Another harness's page, a page with a user name, another path, another port.
    "https://auth.openai.com/oauth/authorize?state=s",
    "https://ada:hunter2@claude.ai/oauth/authorize?code=true",
    "https://claude.ai/oauth/authorize/../../logout",
    "https://claude.ai:8443/oauth/authorize",
    "https://claude.ai.example.com/oauth/authorize",
  ]) {
    assert.strictEqual(pageIn(line, "claude-code"), null, line);
  }
});

/**
 * What a stand-in harness's script starts with: `hand(url)` hands a page to
 * `BROWSER`, which only a sign-in off Windows gives a harness; `page(url)`
 * does so where there is one and prints the page otherwise, as the harnesses
 * do; `waitFor(file)` waits until the test creates `file`; `forever()` keeps
 * the process running until it is ended.
 */
const PRELUDE = `
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const hand = (url) => {
  if (process.env.BROWSER) spawnSync(process.env.BROWSER, [url], { stdio: "ignore" });
};
const page = (url) => {
  if (process.env.BROWSER) hand(url);
  else console.log("Visit " + url + " to sign in");
};
const waitFor = (file) =>
  new Promise((resolve) => {
    const poll = () => (fs.existsSync(file) ? resolve() : setTimeout(poll, 50));
    poll();
  });
const forever = () => setInterval(() => {}, 1000);
`;

/**
 * A stand-in harness in `folder`, which `PATH` finds as `name`: `body`, a
 * Node script after `PRELUDE` that may `await`, started by a `.cmd` shim on
 * Windows, as npm installs a harness there, and by `sh` elsewhere.
 */
const harness = Effect.fn(function* (folder: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const script = path.join(folder, `${name}.cjs`);
  yield* fs.writeFileString(script, `${PRELUDE}\n(async () => {\n${body}\n})();\n`);
  if (process.platform === "win32") {
    const shim = path.join(folder, `${name}.cmd`);
    yield* fs.writeFileString(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  const file = path.join(folder, name);
  yield* fs.writeFileString(file, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  yield* fs.chmod(file, 0o755);
  return file;
});

/** A string as a literal in a stand-in's script. */
const literal = (value: string) => JSON.stringify(value);

/**
 * What a sign-in started here gets of this process's environment: the search
 * path, and on Windows the variables Windows' own programs need, which the
 * sign-in keeps (`engineEnvironment`).
 */
const SIGN_IN_ENVIRONMENT: Readonly<Record<string, string | undefined>> =
  process.platform === "win32" ? { ...process.env } : { PATH: "/usr/bin:/bin" };

/**
 * Whether a sign-in hands the harness a `BROWSER`: never on Windows, where
 * the harnesses do not honour it and print the page instead.
 */
const HANDS_BROWSER = process.platform !== "win32";

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Real processes, on the real clock, on every system.
describe("with stand-in harnesses", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })(
    "a sign-in with no terminal",
    (it) => {
      /** Runs `executable`'s sign-in for `home` with no terminal, keeping what it reported. */
      const runApp = (
        harnessName: "claude-code" | "codex",
        executable: string,
        home: string,
        onStatus: (status: ProviderSignInStatus) => Effect.Effect<void> = () => Effect.void,
        limits?: Parameters<typeof signIn>[0]["limits"],
      ) =>
        Effect.gen(function* () {
          const reported: Array<ProviderSignInStatus> = [];
          const result = yield* signIn({
            harness: harnessName,
            executable,
            home,
            environment: SIGN_IN_ENVIRONMENT,
            deviceAuth: false,
            platform: process.platform,
            io: {
              _tag: "app",
              report: (status) =>
                Effect.sync(() => void reported.push(status)).pipe(
                  Effect.andThen(onStatus(status)),
                ),
            },
            ...(limits === undefined ? {} : { limits }),
          }).pipe(Effect.result);
          return { result, reported };
        });

      // Windows gives a harness no `BROWSER`: the printed page is the one it has.
      it.effect.runIf(HANDS_BROWSER)(
        "hands the client the page BROWSER is given, then signs in, never passing on what the harness printed",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const home = path.join(root, "claude-code");
            yield* fs.makeDirectory(home, { mode: 0o700 });
            const go = path.join(root, "go");
            const claude = yield* harness(
              root,
              "claude",
              [
                `console.log("Opening browser to sign in… ${SECRET}");`,
                `hand("https://claude.com/cai/oauth/authorize?state=abc");`,
                `console.log("If the browser didn't open, visit: https://claude.ai/oauth/authorize?state=abc");`,
                `await waitFor(${literal(go)});`,
                `fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), '{"accessToken":"${SECRET}"}');`,
              ].join("\n"),
            );
            const { result, reported } = yield* runApp("claude-code", claude, home, (status) =>
              status._tag === "waiting-for-browser"
                ? fs.writeFileString(go, "").pipe(Effect.orDie)
                : Effect.void,
            );
            assert.isTrue(Result.isSuccess(result));
            assert.deepStrictEqual(reported, [
              { _tag: "starting" },
              {
                _tag: "waiting-for-browser",
                url: "https://claude.com/cai/oauth/authorize?state=abc",
                opened: false,
              },
            ]);
            assert.notInclude(JSON.stringify(reported), SECRET);
            assert.include(yield* fs.readFileString(path.join(home, ".credentials.json")), SECRET);
          }).pipe(Effect.scoped),
      );

      it.effect(
        "offers the printed page to open when the harness hands BROWSER none, and no other URL it printed, then signs in",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const home = path.join(root, "claude-code");
            yield* fs.makeDirectory(home, { mode: 0o700 });
            const go = path.join(root, "go");
            const claude = yield* harness(
              root,
              "claude",
              [
                `console.log("Diagnostics at https://status.example.com/report?token=${SECRET}");`,
                `console.log("Or https://ada:${SECRET}@claude.ai/oauth/authorize?code=true");`,
                `console.log("Visit https://claude.ai/oauth/authorize?code=true&state=xyz to sign in");`,
                `await waitFor(${literal(go)});`,
                `fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), '{"accessToken":"${SECRET}"}');`,
              ].join("\n"),
            );
            const { result, reported } = yield* runApp("claude-code", claude, home, (status) =>
              status._tag === "waiting-for-browser"
                ? fs.writeFileString(go, "").pipe(Effect.orDie)
                : Effect.void,
            );
            assert.isTrue(Result.isSuccess(result));
            assert.deepStrictEqual(reported, [
              { _tag: "starting" },
              {
                _tag: "waiting-for-browser",
                url: "https://claude.ai/oauth/authorize?code=true&state=xyz",
                // Whether the harness opened it too or not, the client opens it.
                opened: false,
              },
            ]);
            assert.notInclude(JSON.stringify(reported), SECRET);
            assert.include(yield* fs.readFileString(path.join(home, ".credentials.json")), SECRET);
          }).pipe(Effect.scoped),
        // The printed page waits two seconds for one handed to `BROWSER`.
        10_000,
      );

      it.effect("tells a sign-in that failed on its page from one that needs a terminal", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const refused = yield* harness(
            root,
            "refused",
            [
              `page("https://claude.com/cai/oauth/authorize");`,
              `await new Promise((resolve) => setTimeout(resolve, 500));`,
              `console.error(${literal(SECRET)});`,
              `process.exit(1);`,
            ].join("\n"),
          );
          const ended = yield* runApp("claude-code", refused, root);
          assert.deepStrictEqual(
            Result.isFailure(ended.result) ? ended.result.failure.reason : null,
            "ended",
          );
          if (Result.isFailure(ended.result))
            assert.notInclude(ended.result.failure.message, SECRET);

          const tty = yield* harness(
            root,
            "tty",
            [
              `console.error("Error: Raw mode is not supported on the current process.stdin");`,
              `process.exit(1);`,
            ].join("\n"),
          );
          const needsTerminal = yield* runApp("claude-code", tty, root);
          assert.deepStrictEqual(
            Result.isFailure(needsTerminal.result) ? needsTerminal.result.failure.reason : null,
            "needs-terminal",
          );
          assert.deepStrictEqual(needsTerminal.reported, [{ _tag: "starting" }]);
        }).pipe(Effect.scoped),
      );

      it.effect(
        "stops the harness and keeps the stored sign-in when it is cancelled",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const home = path.join(root, "codex");
            yield* fs.makeDirectory(home, { mode: 0o700 });
            const credential = path.join(home, "auth.json");
            yield* fs.writeFileString(credential, "stored\n");
            const pid = path.join(root, "pid");
            // Codex's own sign-in revokes what is stored in its folder first.
            const codex = yield* harness(
              root,
              "stand-in",
              [
                `fs.writeFileSync(${literal(pid)}, String(process.pid));`,
                `fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "revoked\\n");`,
                `fs.mkdirSync(path.join(process.env.CODEX_HOME, "log"), { recursive: true });`,
                `fs.writeFileSync(path.join(process.env.CODEX_HOME, "log", "codex-login.log"), "waiting\\n");`,
                `page("https://auth.openai.com/oauth/authorize");`,
                `forever();`,
              ].join("\n"),
            );
            const waiting = yield* Deferred.make<void>();
            const fiber = yield* runApp("codex", codex, home, (status) =>
              status._tag === "waiting-for-browser"
                ? Deferred.succeed(waiting, void 0)
                : Effect.void,
            ).pipe(Effect.forkChild);
            yield* Deferred.await(waiting);
            yield* Fiber.interrupt(fiber);
            assert.strictEqual(yield* fs.readFileString(credential), "stored\n");
            // The new folder is gone with the sign-in that used it, and what Codex logged of it stays.
            assert.deepStrictEqual((yield* fs.readDirectory(home)).toSorted(), [
              "auth.json",
              "log",
            ]);
            assert.strictEqual(
              yield* fs.readFileString(path.join(home, "log", "codex-login.log")),
              "waiting\n",
            );
            const signedIn = Number((yield* fs.readFileString(pid)).trim());
            // Stopped once its scope closed: SIGTERM, then SIGKILL; on Windows, at once.
            for (let waited = 0; waited < 100 && isRunning(signedIn); waited++)
              yield* Effect.sleep("50 millis");
            assert.isFalse(isRunning(signedIn));
          }).pipe(Effect.scoped),
        10_000,
      );

      it.effect(
        "stops a harness that ignores SIGTERM, and all it started, on a cancel and at each deadline",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            // Longer than the two seconds a printed page waits for one handed to `BROWSER`.
            const limits = {
              pageWait: Duration.seconds(3),
              signInWait: Duration.seconds(4),
              stopWithin: Duration.millis(300),
            };
            /** A sign-in of a stand-in that ignores SIGTERM, as do the child it starts, and how it ended. */
            const stubborn = (
              harnessName: "claude-code" | "codex",
              page: boolean,
              cancel: boolean,
            ) =>
              Effect.gen(function* () {
                const home = path.join(root, `${harnessName}-${page}-${cancel}`);
                yield* fs.makeDirectory(home, { mode: 0o700 });
                const pids = path.join(root, `${path.basename(home)}.pids`);
                const executable = yield* harness(
                  root,
                  `${path.basename(home)}-stand-in`,
                  [
                    `process.on("SIGTERM", () => {});`,
                    `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
                    `fs.writeFileSync(${literal(pids)}, process.pid + "\\n" + child.pid + "\\n");`,
                    ...(page
                      ? [`page(${literal(`${HARNESSES[harnessName].signInPages[0]}?state=s`)});`]
                      : []),
                    `forever();`,
                  ].join("\n"),
                );
                const waiting = yield* Deferred.make<void>();
                const fiber = yield* runApp(
                  harnessName,
                  executable,
                  home,
                  (status) =>
                    status._tag === "waiting-for-browser"
                      ? Deferred.succeed(waiting, void 0)
                      : Effect.void,
                  limits,
                ).pipe(Effect.forkChild);
                if (cancel) {
                  yield* Deferred.await(waiting);
                  const [stopping] = yield* Effect.timed(Fiber.interrupt(fiber));
                  assert.isBelow(Duration.toMillis(stopping), 3_000);
                }
                const [took, ended] = yield* Effect.timed(Fiber.await(fiber));
                const running = (yield* fs.readFileString(pids))
                  .trim()
                  .split("\n")
                  .map(Number)
                  .filter(isRunning);
                // Nothing the sign-in made is left: not the page's folder, not Codex's new folder.
                const left = [
                  ...(yield* fs.readDirectory(root)),
                  ...(yield* fs.readDirectory(home)),
                ];
                return {
                  took: Duration.toMillis(took),
                  running,
                  left: left.filter((name) => name.startsWith(".sign-in")),
                  reason:
                    Exit.isSuccess(ended) && Result.isFailure(ended.value.result)
                      ? ended.value.result.failure.reason
                      : null,
                };
              });

            const cancelled = yield* stubborn("claude-code", true, true);
            assert.deepStrictEqual([cancelled.running, cancelled.left], [[], []]);
            const noPage = yield* stubborn("claude-code", false, false);
            assert.deepStrictEqual(
              [noPage.reason, noPage.running, noPage.left],
              ["needs-terminal", [], []],
            );
            assert.isBelow(noPage.took, 5_000);
            const timedOut = yield* stubborn("codex", true, false);
            assert.deepStrictEqual(
              [timedOut.reason, timedOut.running, timedOut.left],
              ["timed-out", [], []],
            );
            assert.isBelow(timedOut.took, 6_000);
          }).pipe(Effect.scoped),
        30_000,
      );

      it.effect("refuses a Codex sign-in that left no credential file, replacing nothing", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          const home = path.join(root, "codex");
          yield* fs.makeDirectory(home, { mode: 0o700 });
          yield* fs.writeFileString(path.join(home, "auth.json"), "stored\n");
          // An earlier sign-in's log, which Codex appends to.
          yield* fs.makeDirectory(path.join(home, "log"));
          yield* fs.writeFileString(path.join(home, "log", "codex-login.log"), "earlier\n");
          const keyring = yield* harness(
            root,
            "stand-in",
            [
              `fs.mkdirSync(path.join(process.env.CODEX_HOME, "log"), { recursive: true });`,
              `fs.writeFileSync(path.join(process.env.CODEX_HOME, "log", "codex-login.log"), "keyring\\n");`,
              `page("https://auth.openai.com/oauth/authorize");`,
              `process.exit(0);`,
            ].join("\n"),
          );
          const { result } = yield* runApp("codex", keyring, home);
          assert.deepStrictEqual(
            Result.isFailure(result) ? result.failure.reason : null,
            "no-credential",
          );
          assert.strictEqual(yield* fs.readFileString(path.join(home, "auth.json")), "stored\n");
          // What Codex logged of the failed sign-in is what an operator reads next.
          assert.strictEqual(
            yield* fs.readFileString(path.join(home, "log", "codex-login.log")),
            "earlier\nkeyring\n",
          );
        }).pipe(Effect.scoped),
      );
    },
  );
});

/** The server's search path with `bin` first, as its environment names it on this system. */
const searchPathWith = (bin: string): Record<string, string> =>
  process.platform === "win32"
    ? {
        PATH: `${bin};${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }
    : { PATH: `${bin}:/usr/bin:/bin` };

/**
 * The sign-ins service over the in-memory engine, in a private test home,
 * with the stand-in harnesses `bin` holds as the server's `PATH`.
 */
const signInsIn = (home: string, bin: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return SignIns.layer.pipe(
        Layer.provideMerge(TestEngine.layer),
        Layer.provide(Layer.succeed(ServerConfig, configFor(path, home))),
        Layer.provide(Host.layer.pipe(Layer.provide(FetchHttpClient.layer))),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(searchPathWith(bin)))),
      );
    }),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })("the sign-ins clients follow", (it) => {
  it.effect(
    "says a stored endpoint connection still wins, and has the engine check the provider again",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const bin = path.join(home, "bin");
        yield* fs.makeDirectory(bin);
        const go = path.join(bin, "go");
        const claude = yield* harness(
          bin,
          "claude",
          [
            `page("https://claude.com/cai/oauth/authorize");`,
            `await waitFor(${literal(go)});`,
          ].join("\n"),
        );
        const statuses = yield* Effect.gen(function* () {
          const engine = yield* Engine;
          yield* engine.connectProviders({
            baseUrl: "https://proxy.example",
            key: Redacted.make("not-a-real-key"),
          });
          const signIns = yield* SignIns.SignIns;
          const locations = yield* signIns.locations;
          assert.deepStrictEqual(locations, [
            { harness: "claude-code", path: claude },
            { harness: "codex", path: null },
          ]);
          const followed = yield* signIns.follow("claude-code", true).pipe(
            Stream.tap((status) =>
              status._tag === "waiting-for-browser"
                ? fs.writeFileString(go, "").pipe(Effect.orDie)
                : Effect.void,
            ),
            Stream.runCollect,
          );
          assert.deepStrictEqual(followed.at(-1), {
            _tag: "succeeded",
            endpoint: "https://proxy.example",
          });
          assert.deepStrictEqual(yield* (yield* TestEngine.TestEngineControl).recheckedProviders, [
            ProviderId.make("claude-code"),
          ]);
          // A harness not on the PATH says so.
          const missing = yield* signIns.follow("codex", true).pipe(Stream.runCollect);
          return { followed, missing };
        }).pipe(Effect.provide(signInsIn(home, bin)));
        assert.deepStrictEqual(statuses.followed.at(-1), {
          _tag: "succeeded",
          endpoint: "https://proxy.example",
        });
        assert.deepStrictEqual(statuses.missing.at(-1), {
          _tag: "failed",
          reason: "not-installed",
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "ends a cancel of a harness that ignores SIGTERM in time, and can sign in again",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const bin = path.join(home, "bin");
        yield* fs.makeDirectory(bin);
        yield* harness(
          bin,
          "claude",
          [
            `process.on("SIGTERM", () => {});`,
            `spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
            `page("https://claude.com/cai/oauth/authorize");`,
            `forever();`,
          ].join("\n"),
        );
        yield* Effect.gen(function* () {
          const signIns = yield* SignIns.SignIns;
          const untilPage = signIns.follow("claude-code", true).pipe(
            Stream.takeUntil((status) => status._tag === "waiting-for-browser"),
            Stream.runCollect,
          );
          assert.strictEqual((yield* untilPage).at(-1)?._tag, "waiting-for-browser");
          // SIGTERM, then SIGKILL three seconds later.
          const [stopping] = yield* Effect.timed(signIns.cancel("claude-code"));
          assert.isBelow(Duration.toMillis(stopping), 6_000);
          assert.strictEqual((yield* untilPage).at(-1)?._tag, "waiting-for-browser");
          yield* signIns.cancel("claude-code");
        }).pipe(Effect.provide(signInsIn(home, bin)));
      }).pipe(Effect.scoped),
    20_000,
  );

  it.effect("lets a second client follow the sign-in under way, and a cancel end it for both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(home, "bin");
      yield* fs.makeDirectory(bin);
      yield* harness(bin, "claude", `page("https://claude.com/cai/oauth/authorize");\nforever();`);
      yield* Effect.gen(function* () {
        const signIns = yield* SignIns.SignIns;
        const first = yield* signIns
          .follow("claude-code", true)
          .pipe(Stream.runCollect, Effect.forkChild);
        const second = yield* signIns.follow("claude-code", true).pipe(
          Stream.takeUntil((status) => status._tag === "waiting-for-browser"),
          Stream.runCollect,
        );
        assert.deepStrictEqual(second.at(-1)?._tag, "waiting-for-browser");
        yield* signIns.cancel("claude-code");
        assert.deepStrictEqual((yield* Fiber.join(first)).at(-1), { _tag: "cancelled" });
        // A client back on a new socket learns how it ended, and starts nothing.
        assert.deepStrictEqual(
          yield* signIns.follow("claude-code", false).pipe(Stream.runCollect),
          [{ _tag: "cancelled" }],
        );
        assert.deepStrictEqual(yield* signIns.follow("codex", false).pipe(Stream.runCollect), []);
      }).pipe(Effect.provide(signInsIn(home, bin)));
    }).pipe(Effect.scoped),
  );
});
