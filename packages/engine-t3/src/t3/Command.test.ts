// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { engineEnvironment } from "./Command.ts";

it("starts the engine with only what a process needs to run and reach the network", () => {
  assert.deepStrictEqual(
    engineEnvironment({
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
    }),
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
