// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderId, type ProviderSignInStatus } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
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
import * as Host from "../system/Host.ts";
import { configFor } from "../testing/database.ts";
import { invocation, pageIn, signIn, signInCommand } from "./signIn.ts";
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
    { ...kept, DISPLAY: ":0", BROWSER: "/tmp/j3-sign-in-x/open-page", CLAUDE_CONFIG_DIR: home },
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

/** A stand-in harness: a shell script in `folder`, which `PATH` finds as `name`. */
const harness = Effect.fn(function* (folder: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(folder, name);
  yield* fs.writeFileString(file, `#!/bin/sh\n${body}\n`);
  yield* fs.chmod(file, 0o755);
  return file;
});

/** A file the test creates to let a stand-in harness finish, once the page has been given. */
const waitFor = (go: string) => `while [ ! -e '${go}' ]; do sleep 0.05; done`;

// Real processes, on the real clock. The stand-in harnesses are sh scripts,
// which Windows cannot run: there, the cmd.exe test above checks how a
// harness is started.
describe.skipIf(process.platform === "win32")("with sh stand-ins", () => {
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
            environment: { PATH: "/usr/bin:/bin" },
            deviceAuth: false,
            platform: "linux",
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

      it.effect(
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
                `echo "Opening browser to sign in… ${SECRET}"`,
                `"$BROWSER" "https://claude.com/cai/oauth/authorize?state=abc"`,
                `echo "If the browser didn't open, visit: https://claude.ai/oauth/authorize?state=abc"`,
                waitFor(go),
                `printf '{"accessToken":"${SECRET}"}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
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
        "offers the printed page to open when the harness hands BROWSER none, and no other URL it printed",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const go = path.join(root, "go");
            const claude = yield* harness(
              root,
              "claude",
              [
                `echo "Diagnostics at https://status.example.com/report?token=${SECRET}"`,
                `echo "Or https://ada:${SECRET}@claude.ai/oauth/authorize?code=true"`,
                `echo "Visit https://claude.ai/oauth/authorize?code=true&state=xyz to sign in"`,
                waitFor(go),
              ].join("\n"),
            );
            const { result, reported } = yield* runApp("claude-code", claude, root, (status) =>
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
                opened: false,
              },
            ]);
            assert.notInclude(JSON.stringify(reported), SECRET);
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
            `"$BROWSER" "https://claude.com/cai/oauth/authorize"\nsleep 0.5\necho "${SECRET}" >&2\nexit 1`,
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
            `echo "Error: Raw mode is not supported on the current process.stdin" >&2\nexit 1`,
          );
          const needsTerminal = yield* runApp("claude-code", tty, root);
          assert.deepStrictEqual(
            Result.isFailure(needsTerminal.result) ? needsTerminal.result.failure.reason : null,
            "needs-terminal",
          );
          assert.deepStrictEqual(needsTerminal.reported, [{ _tag: "starting" }]);
        }).pipe(Effect.scoped),
      );

      it.effect("stops the harness and keeps the stored sign-in when it is cancelled", () =>
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
              `echo $$ > '${pid}'`,
              `printf 'revoked\\n' > "$CODEX_HOME/auth.json"`,
              `"$BROWSER" "https://auth.openai.com/oauth/authorize"`,
              "exec sleep 60",
            ].join("\n"),
          );
          const waiting = yield* Deferred.make<void>();
          const fiber = yield* runApp("codex", codex, home, (status) =>
            status._tag === "waiting-for-browser" ? Deferred.succeed(waiting, void 0) : Effect.void,
          ).pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          yield* Fiber.interrupt(fiber);
          assert.strictEqual(yield* fs.readFileString(credential), "stored\n");
          // The new folder is gone with the sign-in that used it.
          assert.deepStrictEqual(yield* fs.readDirectory(home), ["auth.json"]);
          const signedIn = Number((yield* fs.readFileString(pid)).trim());
          const alive = () => {
            try {
              process.kill(signedIn, 0);
              return true;
            } catch {
              return false;
            }
          };
          // Stopped once its scope closed: SIGTERM, then SIGKILL.
          for (let waited = 0; waited < 100 && alive(); waited++) yield* Effect.sleep("50 millis");
          assert.isFalse(alive());
        }).pipe(Effect.scoped),
      );

      it.effect(
        "stops a harness that ignores SIGTERM, and all it started, on a cancel and at each deadline",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const limits = {
              pageWait: Duration.seconds(1),
              signInWait: Duration.seconds(2),
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
                    "trap '' TERM",
                    `echo $$ >> '${pids}'`,
                    "sleep 600 &",
                    `echo $! >> '${pids}'`,
                    ...(page
                      ? [`"$BROWSER" "${HARNESSES[harnessName].signInPages[0]}?state=s"`]
                      : []),
                    "wait",
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
                  .filter((pid) => {
                    try {
                      process.kill(pid, 0);
                      return true;
                    } catch {
                      return false;
                    }
                  });
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
            assert.isBelow(noPage.took, 3_000);
            const timedOut = yield* stubborn("codex", true, false);
            assert.deepStrictEqual(
              [timedOut.reason, timedOut.running, timedOut.left],
              ["timed-out", [], []],
            );
            assert.isBelow(timedOut.took, 4_000);
          }).pipe(Effect.scoped),
        20_000,
      );

      it.effect("refuses a Codex sign-in that left no credential file, replacing nothing", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          const home = path.join(root, "codex");
          yield* fs.makeDirectory(home, { mode: 0o700 });
          yield* fs.writeFileString(path.join(home, "auth.json"), "stored\n");
          const keyring = yield* harness(
            root,
            "stand-in",
            `"$BROWSER" "https://auth.openai.com/oauth/authorize"\nexit 0`,
          );
          const { result } = yield* runApp("codex", keyring, home);
          assert.deepStrictEqual(
            Result.isFailure(result) ? result.failure.reason : null,
            "no-credential",
          );
          assert.strictEqual(yield* fs.readFileString(path.join(home, "auth.json")), "stored\n");
        }).pipe(Effect.scoped),
      );
    },
  );
});

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
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ PATH: `${bin}:/usr/bin:/bin` })),
        ),
      );
    }),
  );

// sh stand-ins, as above.
describe.skipIf(process.platform === "win32")("with sh stand-ins", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })(
    "the sign-ins clients follow",
    (it) => {
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
            yield* harness(
              bin,
              "claude",
              [`"$BROWSER" "https://claude.com/cai/oauth/authorize"`, waitFor(go)].join("\n"),
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
                { harness: "claude-code", path: path.join(bin, "claude") },
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
              assert.deepStrictEqual(
                yield* (yield* TestEngine.TestEngineControl).recheckedProviders,
                [ProviderId.make("claude-code")],
              );
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
              `trap '' TERM\n"$BROWSER" "https://claude.com/cai/oauth/authorize"\nsleep 600 &\nwait`,
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

      it.effect(
        "lets a second client follow the sign-in under way, and a cancel end it for both",
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
              `"$BROWSER" "https://claude.com/cai/oauth/authorize"\nexec sleep 60`,
            );
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
              assert.deepStrictEqual(
                yield* signIns.follow("codex", false).pipe(Stream.runCollect),
                [],
              );
            }).pipe(Effect.provide(signInsIn(home, bin)));
          }).pipe(Effect.scoped),
      );
    },
  );
});
