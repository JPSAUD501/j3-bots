// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ShellPath from "./shellPath.ts";

const START = "__J3_BOTS_PATH_START__";
const END = "__J3_BOTS_PATH_END__";

describe("reading the PATH a shell printed", () => {
  it("takes the value between the markers, whatever the profile printed around it", () => {
    const output = `Welcome back!\nnvm: using node 22\n${START}/home/ana/.nvm/bin:/usr/bin${END}\nlogout\n`;
    assert.deepStrictEqual(
      ShellPath.betweenMarkers(output),
      Option.some("/home/ana/.nvm/bin:/usr/bin"),
    );
  });

  it("takes PowerShell's value without the line breaks it writes around it", () => {
    const output = `${START}\r\nC:\\Windows\\system32;C:\\Users\\ana\\AppData\\Roaming\\npm\r\n${END}\r\n`;
    assert.deepStrictEqual(
      ShellPath.betweenMarkers(output),
      Option.some("C:\\Windows\\system32;C:\\Users\\ana\\AppData\\Roaming\\npm"),
    );
  });

  it("reads nothing from a shell that failed before it printed both markers, or printed none between", () => {
    assert.isTrue(Option.isNone(ShellPath.betweenMarkers("bash: no such file\n")));
    assert.isTrue(Option.isNone(ShellPath.betweenMarkers(`${START}/usr/bin`)));
    assert.isTrue(Option.isNone(ShellPath.betweenMarkers(`${START}${END}`)));
  });
});

describe("merging PATHs", () => {
  it("keeps each folder once, in the order first given, as written", () => {
    assert.strictEqual(
      ShellPath.mergePaths("linux", ["/home/ana/.local/bin:/usr/bin", "/usr/bin:/Usr/Bin::/bin"]),
      "/home/ana/.local/bin:/usr/bin:/Usr/Bin:/bin",
    );
  });

  it("compares folders without case on Windows, and drops blank entries", () => {
    assert.strictEqual(
      ShellPath.mergePaths("win32", ["C:\\Windows;C:\\Tools; ;", "c:\\windows;C:\\Other"]),
      "C:\\Windows;C:\\Tools;C:\\Other",
    );
  });
});

/** A login shell that prints a banner, adds `folder` to PATH as a profile would, then runs its command. */
const fakeShell = (folder: string, works = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-shell-" });
    const shell = path.join(directory, "shell");
    const body = works
      ? `echo 'Have a nice day'\nPATH='${folder}':"$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`
      : "echo 'profile error' >&2\nexit 1\n";
    yield* fs.writeFileString(shell, `#!/bin/sh\n${body}`, { mode: 0o700 });
    return shell;
  });

describe("asking the login shell for its PATH", () => {
  it.effect("takes the PATH the profile sets up, then adds the installers' folders", () =>
    Effect.gen(function* () {
      const shell = yield* fakeShell("/opt/harness/bin");
      const path = yield* ShellPath.probePath({
        platform: "linux",
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        home: "/home/ana",
        loginShell: null,
      });
      assert.deepStrictEqual(path.split(":"), [
        "/opt/harness/bin",
        "/usr/bin",
        "/bin",
        ...ShellPath.knownFolders("linux", {}, "/home/ana"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tries the system's login shell when $SHELL fails", () =>
    Effect.gen(function* () {
      const broken = yield* fakeShell("/never", false);
      const shell = yield* fakeShell("/opt/from-login-shell/bin");
      const path = yield* ShellPath.probePath({
        platform: "linux",
        env: { PATH: "/usr/bin:/bin", SHELL: broken },
        home: "/home/ana",
        loginShell: shell,
      });
      assert.strictEqual(path.split(":")[0], "/opt/from-login-shell/bin");
      assert.notInclude(path.split(":"), "/never");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the installers' folders and the app's PATH when no shell answers", () =>
    Effect.gen(function* () {
      const broken = yield* fakeShell("/never", false);
      const path = yield* ShellPath.probePath({
        platform: "linux",
        env: { PATH: "/usr/bin:/bin", SHELL: broken },
        home: "/home/ana",
        loginShell: "/no/such/shell",
      });
      const folders = path.split(":");
      assert.strictEqual(folders[0], "/home/ana/.local/bin");
      assert.deepStrictEqual(folders.slice(-2), ["/usr/bin", "/bin"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
