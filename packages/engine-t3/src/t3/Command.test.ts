// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { engineEnvironment } from "./Command.ts";

it("starts the engine with only what a process needs to run and reach the network", () => {
  assert.deepStrictEqual(
    engineEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/sam",
        LANG: "pt_BR.UTF-8",
        LC_TIME: "pt_BR.UTF-8",
        XDG_RUNTIME_DIR: "/run/user/1000",
        https_proxy: "http://proxy.lan:3128",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/lan.pem",
        ANTHROPIC_AUTH_TOKEN: "key",
        CLAUDE_CONFIG_DIR: "/home/sam/.claude",
        OPENAI_API_KEY: "key",
        CODEX_HOME: "/home/sam/.codex",
        T3CODE_HOME: "/home/sam/.t3",
        NODE_OPTIONS: "--require /home/sam/hook.js",
        GITHUB_TOKEN: "token",
        UNSET: undefined,
      },
      "linux",
    ),
    {
      PATH: "/usr/bin",
      HOME: "/home/sam",
      LANG: "pt_BR.UTF-8",
      LC_TIME: "pt_BR.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      https_proxy: "http://proxy.lan:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/lan.pem",
    },
  );
});

it("on Windows, passes what a program there needs to start, whatever the case of its name", () => {
  assert.deepStrictEqual(
    engineEnvironment(
      {
        Path: "C:\\Windows\\system32;C:\\Users\\sam\\.local\\bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        USERPROFILE: "C:\\Users\\sam",
        APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
        TEMP: "C:\\Users\\sam\\AppData\\Local\\Temp",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        https_proxy: "http://proxy.lan:3128",
        ANTHROPIC_AUTH_TOKEN: "key",
        CLAUDE_CONFIG_DIR: "C:\\Users\\sam\\.claude",
        CODEX_HOME: "C:\\Users\\sam\\.codex",
        NODE_OPTIONS: "--require C:\\Users\\sam\\hook.js",
        HOME: "C:\\Users\\sam",
      },
      "win32",
    ),
    {
      Path: "C:\\Windows\\system32;C:\\Users\\sam\\.local\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      USERPROFILE: "C:\\Users\\sam",
      APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
      TEMP: "C:\\Users\\sam\\AppData\\Local\\Temp",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      https_proxy: "http://proxy.lan:3128",
    },
  );
});
