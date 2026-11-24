// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { commandEnvironment } from "./environment.ts";

const SERVER = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/someone",
  LANG: "pt_BR.UTF-8",
  TMPDIR: "/tmp",
  ANTHROPIC_API_KEY: "sk-the-servers-own",
  J3_DATA_DIR: "/var/lib/j3",
  SSH_AUTH_SOCK: "/run/agent.sock",
  UNSET: undefined,
};

describe("commandEnvironment", () => {
  it("gives a command only the server's few allowed variables, and those the operator gave", () => {
    const environment = commandEnvironment("linux", SERVER, [
      { name: "GITHUB_TOKEN", value: Redacted.make("ghp_operator") },
    ]);
    assert.deepStrictEqual(environment, {
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      LANG: "pt_BR.UTF-8",
      TMPDIR: "/tmp",
      GITHUB_TOKEN: "ghp_operator",
    });
  });

  it("lets the operator's variable replace the server's of the same name", () => {
    const environment = commandEnvironment("linux", SERVER, [
      { name: "HOME", value: Redacted.make("/srv/sandbox") },
    ]);
    assert.strictEqual(environment["HOME"], "/srv/sandbox");
  });

  it("reads Windows' names without case, and gives what its launchers need to start", () => {
    const environment = commandEnvironment(
      "win32",
      {
        Path: "C:\\Windows\\system32",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
        HOME: "C:\\Users\\someone",
        OPENAI_API_KEY: "sk-the-servers-own",
      },
      [{ name: "path", value: Redacted.make("C:\\tools") }],
    );
    assert.deepStrictEqual(environment, {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
      path: "C:\\tools",
    });
  });
});
