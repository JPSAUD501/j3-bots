// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderId, type ProviderSignInStatus } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as TestEngine from "@j3-bots/engine-t3/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ServerConfig } from "../config.ts";
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
    }).args,
    ["login", "--device-auth"],
  );
  // With no terminal: no terminal variables, and the page goes to J3 Bots, not to Firefox.
  assert.deepStrictEqual(
    signInCommand("claude-code", "/usr/local/bin/claude", home, shell, {
      deviceAuth: false,
      terminal: false,
      browser: "/tmp/j3-sign-in-x/open-page",
    }).env,
    { ...kept, DISPLAY: ":0", BROWSER: "/tmp/j3-sign-in-x/open-page", CLAUDE_CONFIG_DIR: home },
  );
});

it("runs a Windows .cmd shim through cmd.exe, and refuses a path cmd.exe would expand", () => {
  assert.deepStrictEqual(invocation("C:\\Tools\\claude.exe", ["auth", "login"], "win32"), Result.succeed({
    command: "C:\\Tools\\claude.exe",
    args: ["auth", "login"],
    shell: false,
  }));
  assert.deepStrictEqual(
    invocation("C:\\Users\\Ada Lovelace\\npm\\codex.cmd", ["login"], "win32"),
    Result.succeed({
      command: '"C:\\Users\\Ada Lovelace\\npm\\codex.cmd" login',
      args: [],
      shell: true,
    }),
  );
  assert.isTrue(Result.isFailure(invocation("C:\\%PATH%\\codex.cmd", ["login"], "win32")));
  // Elsewhere a `.cmd` is a file like another.
  assert.isFalse(invocation("/opt/codex.cmd", ["login"], "linux").pipe(Result.getOrThrow).shell);
});

it("finds a harness on Windows as its .exe or its npm .cmd shim", () => {
  assert.deepStrictEqual(Host.executableNames("win32", ".COM;.EXE;.CMD")("codex"), [
    "codex.com",
    "codex.exe",
    "codex.cmd",
  ]);
  assert.deepStrictEqual(Host.executableNames("linux", ".EXE")("codex"), ["codex"]);
});

it("reads the page a harness prints, and nothing that is not an https URL", () => {
  assert.strictEqual(
    pageIn("If the browser didn't open, visit: https://claude.example/oauth?code=true\u001b[0m"),
    "https://claude.example/oauth?code=true",
  );
  assert.strictEqual(pageIn("Starting local login server on http://localhost:1455."), null);
  assert.strictEqual(pageIn("Paste code here if prompted >"), null);
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

// Real processes, on the real clock.
it.layer(NodeServices.layer, { excludeTestServices: true })("a sign-in with no terminal", (it) => {
  /** Runs `executable`'s sign-in for `home` with no terminal, keeping what it reported. */
  const runApp = (
    harnessName: "claude-code" | "codex",
    executable: string,
    home: string,
    onStatus: (status: ProviderSignInStatus) => Effect.Effect<void> = () => Effect.void,
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
            Effect.sync(() => void reported.push(status)).pipe(Effect.andThen(onStatus(status))),
        },
      }).pipe(Effect.result);
      return { result, reported };
    });

  it.effect("hands the client the page BROWSER is given, then signs in, never passing on what the harness printed", () =>
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
          `"$BROWSER" "https://claude.example/oauth/authorize?state=abc"`,
          `echo "If the browser didn't open, visit: https://claude.example/short"`,
          waitFor(go),
          `printf '{"accessToken":"${SECRET}"}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
        ].join("\n"),
      );
      const { result, reported } = yield* runApp("claude-code", claude, home, (status) =>
        status._tag === "waiting-for-browser" ? fs.writeFileString(go, "").pipe(Effect.orDie) : Effect.void,
      );
      assert.isTrue(Result.isSuccess(result));
      assert.deepStrictEqual(reported, [
        { _tag: "starting" },
        {
          _tag: "waiting-for-browser",
          url: "https://claude.example/oauth/authorize?state=abc",
          opened: false,
        },
      ]);
      assert.notInclude(JSON.stringify(reported), SECRET);
      assert.include(yield* fs.readFileString(path.join(home, ".credentials.json")), SECRET);
    }).pipe(Effect.scoped),
  );

  it.effect("offers the printed page when the harness opens the browser itself", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const go = path.join(root, "go");
      const claude = yield* harness(
        root,
        "claude",
        [`echo "Visit https://claude.example/short to sign in"`, waitFor(go)].join("\n"),
      );
      const { result, reported } = yield* runApp("claude-code", claude, root, (status) =>
        status._tag === "waiting-for-browser" ? fs.writeFileString(go, "").pipe(Effect.orDie) : Effect.void,
      );
      assert.isTrue(Result.isSuccess(result));
      assert.deepStrictEqual(reported.at(-1), {
        _tag: "waiting-for-browser",
        url: "https://claude.example/short",
        opened: true,
      });
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
        `"$BROWSER" "https://claude.example/oauth"\nsleep 0.5\necho "${SECRET}" >&2\nexit 1`,
      );
      const ended = yield* runApp("claude-code", refused, root);
      assert.deepStrictEqual(
        Result.isFailure(ended.result) ? ended.result.failure.reason : null,
        "ended",
      );
      if (Result.isFailure(ended.result)) assert.notInclude(ended.result.failure.message, SECRET);

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
          `"$BROWSER" "https://auth.example/oauth/authorize"`,
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

  it.effect("refuses a Codex sign-in that left no credential file, replacing nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "codex");
      yield* fs.makeDirectory(home, { mode: 0o700 });
      yield* fs.writeFileString(path.join(home, "auth.json"), "stored\n");
      const keyring = yield* harness(root, "stand-in", `"$BROWSER" "https://auth.example/oauth"\nexit 0`);
      const { result } = yield* runApp("codex", keyring, home);
      assert.deepStrictEqual(
        Result.isFailure(result) ? result.failure.reason : null,
        "no-credential",
      );
      assert.strictEqual(yield* fs.readFileString(path.join(home, "auth.json")), "stored\n");
    }).pipe(Effect.scoped),
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
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ PATH: `${bin}:/usr/bin:/bin` }))),
      );
    }),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })("the sign-ins clients follow", (it) => {
  it.effect("says a stored endpoint connection still wins, and has the engine check the provider again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(home, "bin");
      yield* fs.makeDirectory(bin);
      const go = path.join(bin, "go");
      yield* harness(bin, "claude", [`"$BROWSER" "https://claude.example/oauth"`, waitFor(go)].join("\n"));
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
        const followed = yield* signIns.follow("claude-code").pipe(
          Stream.tap((status) =>
            status._tag === "waiting-for-browser" ? fs.writeFileString(go, "").pipe(Effect.orDie) : Effect.void,
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
        const missing = yield* signIns.follow("codex").pipe(Stream.runCollect);
        return { followed, missing };
      }).pipe(Effect.provide(signInsIn(home, bin)));
      assert.deepStrictEqual(statuses.followed.at(-1), {
        _tag: "succeeded",
        endpoint: "https://proxy.example",
      });
      assert.deepStrictEqual(statuses.missing.at(-1), { _tag: "failed", reason: "not-installed" });
    }).pipe(Effect.scoped),
  );

  it.effect("lets a second client follow the sign-in under way, and a cancel end it for both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(home, "bin");
      yield* fs.makeDirectory(bin);
      yield* harness(bin, "claude", `"$BROWSER" "https://claude.example/oauth"\nexec sleep 60`);
      yield* Effect.gen(function* () {
        const signIns = yield* SignIns.SignIns;
        const first = yield* signIns.follow("claude-code").pipe(Stream.runCollect, Effect.forkChild);
        const second = yield* signIns.follow("claude-code").pipe(
          Stream.takeUntil((status) => status._tag === "waiting-for-browser"),
          Stream.runCollect,
        );
        assert.deepStrictEqual(second.at(-1)?._tag, "waiting-for-browser");
        yield* signIns.cancel("claude-code");
        assert.deepStrictEqual((yield* Fiber.join(first)).at(-1), { _tag: "cancelled" });
      }).pipe(Effect.provide(signInsIn(home, bin)));
    }).pipe(Effect.scoped),
  );
});
