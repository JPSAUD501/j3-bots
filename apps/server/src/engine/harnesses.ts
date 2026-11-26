// SPDX-License-Identifier: AGPL-3.0-or-later
import { signInHarnesses } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PROVIDER_HOMES } from "../home/entries.ts";
import { readCurrent } from "../harnesses/layout.ts";
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
  /**
   * The log its own sign-in keeps in its configuration folder, when it keeps
   * one: what its maker asks for when a sign-in does not work. A sign-in in a
   * new folder (`revokesStoredSignIn`) adds it to the one in the J3-owned
   * home, however it ends.
   */
  readonly signInLog: string | undefined;
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
    signInLog: undefined,
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
    // Codex 0.171.0: `init_login_file_logging` in `codex-rs/cli/src/login.rs`
    // appends to `codex-login.log` in its log folder, `log` in `CODEX_HOME`.
    signInLog: "log/codex-login.log",
  },
};

/**
 * `searchPath` with each folder of `more` it lacks added after its own, in
 * order: on Windows, a folder's case does not tell two apart, and quotes
 * around it are not part of it.
 */
export const withFolders = (searchPath: string, more: string, platform: string): string => {
  const separator = platform === "win32" ? ";" : ":";
  const key = (folder: string) =>
    platform === "win32"
      ? folder
          .trim()
          .replace(/^"+|"+$/g, "")
          .toLowerCase()
      : folder;
  const folders = searchPath.split(separator).filter((folder) => folder !== "");
  const seen = new Set(folders.map(key));
  for (const folder of more.split(separator)) {
    if (folder === "" || seen.has(key(folder))) continue;
    seen.add(key(folder));
    folders.push(folder);
  }
  return folders.join(separator);
};

/**
 * Where the operator's own `harness` is, looked up as the engine finds it:
 * on the installed service's `PATH` (`servicePath`), else on this shell's,
 * which `j3-bots serve` passes on, with, on Windows, the folders installers
 * have added to the user's `PATH` since (`Host.installersPath`), which the
 * engine also reads again. Also the `PATH` it was looked up on, which a
 * harness started for J3 Bots gets.
 */
export const findOnPath = Effect.fn("findOnPath")(function* (
  harness: Harness,
  servicePath: Option.Option<string>,
) {
  const host = yield* Host;
  const searchPath = Option.isSome(servicePath)
    ? servicePath.value
    : withFolders(host.searchPath, yield* host.installersPath, host.platform);
  const executable = yield* host.findExecutable(HARNESSES[harness].executable, searchPath);
  return { searchPath, executable };
});

/**
 * The harness the engine runs `harness` on for the server's home `home`:
 * J3 Bots' own copy when it installed one (`harnesses/layout.ts`), else the
 * operator's, found as `findOnPath` finds it. Also the `PATH` the
 * operator's is looked up on, which a harness started for J3 Bots gets.
 */
export const findHarness = Effect.fn("findHarness")(function* (
  harness: Harness,
  servicePath: Option.Option<string>,
  home: string,
) {
  const own = yield* readCurrent(home, harness);
  const onPath = yield* findOnPath(harness, servicePath);
  return Option.match(own, {
    onNone: () => onPath,
    onSome: (copy) => ({ searchPath: onPath.searchPath, executable: Option.some(copy.executable) }),
  });
});
