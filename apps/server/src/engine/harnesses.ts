// SPDX-License-Identifier: AGPL-3.0-or-later
import { signInHarnesses } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PROVIDER_HOMES } from "../home/entries.ts";
import { Host } from "../system/Host.ts";

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
  /**
   * The pages its sign-in sends the operator to, as origin and path, the
   * query left out: the only URLs a sign-in with no terminal hands a client.
   */
  readonly signInPages: ReadonlyArray<string>;
  /**
   * Its sign-in first revokes the sign-in already stored in its configuration
   * folder, even when it is then cancelled, so `provider login` runs it in a
   * new, empty folder and moves the credential file in only once it succeeded.
   */
  readonly revokesStoredSignIn: boolean;
}

export const HARNESSES: Readonly<Record<Harness, HarnessFacts>> = {
  "claude-code": {
    ...signInHarnesses["claude-code"],
    executable: "claude",
    homeVariable: "CLAUDE_CONFIG_DIR",
    credentialFile: ".credentials.json",
    // The command the engine names for a signed-out Claude Code instance.
    signIn: ["auth", "login"],
    deviceAuth: undefined,
    // Claude Code 2.1.330: `CLAUDE_AI_AUTHORIZE_URL` and `CONSOLE_AUTHORIZE_URL`
    // in its bundled JavaScript, and the page it printed on a test machine.
    signInPages: [
      "https://claude.com/cai/oauth/authorize",
      "https://claude.ai/oauth/authorize",
      "https://platform.claude.com/oauth/authorize",
    ],
    // Claude Code 2.1.328 replaces its stored sign-in only once the new one's
    // tokens arrived, without revoking it first.
    revokesStoredSignIn: false,
  },
  codex: {
    ...signInHarnesses.codex,
    executable: "codex",
    homeVariable: "CODEX_HOME",
    credentialFile: "auth.json",
    signIn: ["login"],
    deviceAuth: "--device-auth",
    // The page Codex 0.171.0 gave on a test machine.
    signInPages: ["https://auth.openai.com/oauth/authorize"],
    // Codex 0.170.0: `clear_existing_auth_before_login` in `codex-rs/cli/src/login.rs`.
    revokesStoredSignIn: true,
  },
};

/**
 * Where `harness` is, looked up as the engine finds it: on the installed
 * service's `PATH` (`servicePath`), else on this shell's, which `j3-bots
 * serve` passes on. Also the `PATH` it was looked up on, which a harness
 * started for J3 Bots gets.
 */
export const findHarness = Effect.fn("findHarness")(function* (
  harness: Harness,
  servicePath: Option.Option<string>,
) {
  const host = yield* Host;
  const searchPath = Option.getOrElse(servicePath, () => host.searchPath);
  const executable = yield* host.findExecutable(HARNESSES[harness].executable, searchPath);
  return { searchPath, executable };
});
