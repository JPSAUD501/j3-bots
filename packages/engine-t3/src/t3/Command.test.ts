// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { engineEnvironment } from "./Command.ts";

it("starts the engine without the shell's harness and T3 Code configuration", () => {
  assert.deepStrictEqual(
    engineEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/sam",
      XDG_RUNTIME_DIR: "/run/user/1000",
      ANTHROPIC_AUTH_TOKEN: "key",
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "/home/sam/.claude",
      OPENAI_API_KEY: "key",
      CODEX_HOME: "/home/sam/.codex",
      T3CODE_HOME: "/home/sam/.t3",
      T3_BOOT_SERVICE_UNIT: "t3code.service",
      UNSET: undefined,
    }),
    { PATH: "/usr/bin", HOME: "/home/sam", XDG_RUNTIME_DIR: "/run/user/1000" },
  );
});
