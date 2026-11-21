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
  /** The file in that folder where its own sign-in keeps what it gets. */
  readonly credentialFile: string;
  /** Its own interactive sign-in, as arguments to `executable`. */
  readonly signIn: ReadonlyArray<string>;
  /**
   * The argument that makes its sign-in show a code to enter in a browser on
   * any machine instead of waiting for the browser to call back to this one,
   * when it has such a sign-in.
   */
  readonly deviceAuth: string | undefined;
}

export const HARNESSES: Readonly<Record<Harness, HarnessFacts>> = {
  "claude-code": {
    name: "Claude Code",
    executable: "claude",
    installPage: "https://code.claude.com/docs/en/setup",
    homeVariable: "CLAUDE_CONFIG_DIR",
    credentialFile: ".credentials.json",
    // The command the engine names for a signed-out Claude Code instance.
    signIn: ["auth", "login"],
    deviceAuth: undefined,
  },
  codex: {
    name: "Codex",
    executable: "codex",
    installPage: "https://developers.openai.com/codex/cli",
    homeVariable: "CODEX_HOME",
    credentialFile: "auth.json",
    signIn: ["login"],
    deviceAuth: "--device-auth",
  },
};
