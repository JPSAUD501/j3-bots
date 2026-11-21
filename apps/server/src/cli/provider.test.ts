// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { providerBaseUrlProblem } from "../admin/protocol.ts";
import { normalizeBaseUrl, signIn, signInCommand } from "./provider.ts";

it("takes the endpoint's root from what the operator typed, and refuses what is no base URL", () => {
  assert.deepStrictEqual(normalizeBaseUrl(" http://127.0.0.1:8317/v1/ "), {
    _tag: "url",
    url: "http://127.0.0.1:8317",
  });
  assert.deepStrictEqual(normalizeBaseUrl("http://[::1]:8317"), {
    _tag: "url",
    url: "http://[::1]:8317",
  });
  assert.deepStrictEqual(normalizeBaseUrl("https://proxy.lan/api"), {
    _tag: "url",
    url: "https://proxy.lan/api",
  });
  // The URL the server checks and the engine is given is the one the parser reads.
  assert.deepStrictEqual(normalizeBaseUrl("HTTPS://Proxy.LAN:443/a/../api/v1/"), {
    _tag: "url",
    url: "https://proxy.lan/api",
  });
  for (const refused of [
    "ftp://proxy.lan",
    "https://user:secret@proxy.lan",
    "https://proxy.lan/?key=secret",
    // Empty delimiters the parser drops, after which a harness's `/v1` would land.
    "https://proxy.lan?",
    "https://proxy.lan/api#",
    "proxy.lan:8317",
  ]) {
    const normalized = normalizeBaseUrl(refused);
    assert.strictEqual(normalized._tag, "problem", refused);
    if (normalized._tag === "problem") assert.notInclude(normalized.problem, "secret");
  }
});

it("takes only a base URL in its base form from a client, as the CLI sends it", () => {
  assert.isUndefined(providerBaseUrlProblem("https://proxy.lan/api"));
  for (const refused of [
    "https://Proxy.lan",
    "https://proxy.lan:443",
    "https://proxy.lan/a/../b",
  ]) {
    assert.isDefined(providerBaseUrlProblem(refused), refused);
  }
});

it("refuses plain http to another machine, which would send the key in clear", () => {
  for (const remote of [
    "http://proxy.lan:8317",
    "http://192.168.1.20:8317",
    "http://example.com",
  ]) {
    const normalized = normalizeBaseUrl(remote);
    assert.strictEqual(normalized._tag, "problem", remote);
    if (normalized._tag === "problem") assert.include(normalized.problem, "https");
  }
});

it("runs each harness's own sign-in in J3 Bots' home for it, with only the variables a sign-in needs", () => {
  // The operator's shell points the harnesses at their own folders and endpoints.
  const kept = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/ada",
    LANG: "pt_BR.UTF-8",
    HTTPS_PROXY: "http://proxy.example:3128",
    TERM: "xterm-256color",
    BROWSER: "firefox",
  };
  const shell = {
    ...kept,
    CLAUDE_CONFIG_DIR: "/home/ada/.claude-work",
    CODEX_HOME: "/home/ada/.codex-work",
    ANTHROPIC_BASE_URL: "https://elsewhere.example",
    OPENAI_API_KEY: "not-for-bots",
  };
  assert.deepStrictEqual(
    signInCommand(
      "claude-code",
      "/usr/local/bin/claude",
      "/home/ada/.j3-bots/providers/claude-code",
      shell,
      false,
    ),
    {
      command: "/usr/local/bin/claude",
      args: ["auth", "login"],
      env: { ...kept, CLAUDE_CONFIG_DIR: "/home/ada/.j3-bots/providers/claude-code" },
    },
  );
  // Codex's code sign-in, for a machine reached over SSH.
  assert.deepStrictEqual(
    signInCommand(
      "codex",
      "/usr/local/bin/codex",
      "/home/ada/.j3-bots/providers/codex",
      shell,
      true,
    ),
    {
      command: "/usr/local/bin/codex",
      args: ["login", "--device-auth"],
      env: { ...kept, CODEX_HOME: "/home/ada/.j3-bots/providers/codex" },
    },
  );
});

it.layer(NodeServices.layer)("Codex's sign-in", (it) => {
  it.effect("replaces the credential file in J3 Bots' home only once a sign-in succeeded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "providers", "codex");
      yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
      const credential = path.join(home, "auth.json");
      // A copy of the operator's own sign-in, which Codex would revoke on a sign-in into it.
      yield* fs.writeFileString(credential, "copied\n");
      // A stand-in for Codex: it writes into the folder it is given, then ends as told.
      const harness = (name: string, status: number) =>
        Effect.gen(function* () {
          const file = path.join(root, name);
          yield* fs.writeFileString(
            file,
            `#!/bin/sh\n[ -e "$CODEX_HOME/auth.json" ] && exit 9\nprintf '${name}\\n' > "$CODEX_HOME/auth.json"\nexit ${status}\n`,
          );
          yield* fs.chmod(file, 0o755);
          return file;
        });
      const run = (executable: string) =>
        signIn({
          harness: "codex",
          executable,
          home,
          environment: { PATH: "/usr/bin:/bin" },
          deviceAuth: false,
        }).pipe(Effect.result);

      const failed = yield* run(yield* harness("failed", 1));
      assert.strictEqual(failed._tag, "Failure");
      assert.strictEqual(yield* fs.readFileString(credential), "copied\n");
      // The new folder is gone with the sign-in that used it.
      assert.deepStrictEqual(yield* fs.readDirectory(home), ["auth.json"]);

      const succeeded = yield* run(yield* harness("succeeded", 0));
      assert.strictEqual(succeeded._tag, "Success");
      assert.strictEqual(yield* fs.readFileString(credential), "succeeded\n");
      assert.deepStrictEqual(yield* fs.readDirectory(home), ["auth.json"]);

      // A credential file that links elsewhere is replaced, not what it points to.
      const elsewhere = path.join(root, "elsewhere.json");
      yield* fs.writeFileString(elsewhere, "mine\n");
      yield* fs.remove(credential);
      yield* fs.symlink(elsewhere, credential);
      assert.strictEqual((yield* run(yield* harness("again", 0)))._tag, "Success");
      assert.strictEqual(yield* fs.readFileString(elsewhere), "mine\n");
      assert.strictEqual(yield* fs.readFileString(credential), "again\n");
    }).pipe(Effect.scoped),
  );
});
