// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PROVIDER_HOMES } from "../home/entries.ts";

/** A harness the engine runs bots on, with a home of its own in `<J3_HOME>/providers`. */
export type Harness = (typeof PROVIDER_HOMES)[number];

export interface HarnessFacts {
  readonly name: string;
  /** What it is called on `PATH`. */
  readonly executable: string;
  /** Where its maker says how to install it. */
  readonly installPage: string;
  /** The variable that names its configuration folder, which the engine sets to its J3-owned home. */
  readonly homeVariable: string;
  /** Its own interactive sign-in, as arguments to `executable`. */
  readonly signIn: ReadonlyArray<string>;
}

export const HARNESSES: Readonly<Record<Harness, HarnessFacts>> = {
  "claude-code": {
    name: "Claude Code",
    executable: "claude",
    installPage: "https://code.claude.com/docs/en/setup",
    homeVariable: "CLAUDE_CONFIG_DIR",
    // The command the engine names for a signed-out Claude Code instance.
    signIn: ["auth", "login"],
  },
  codex: {
    name: "Codex",
    executable: "codex",
    installPage: "https://developers.openai.com/codex/cli",
    homeVariable: "CODEX_HOME",
    signIn: ["login"],
  },
};
