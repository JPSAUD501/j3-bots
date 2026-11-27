// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { windowsNameKey } from "@j3-bots/processes";
import * as Probe from "./probe.ts";

// The PATH a new terminal of the operator's would have, for the server the
// app runs, so it finds `claude` and `codex` where the operator installed
// them. An app started from a desktop entry, a dock or the Start menu gets
// the system's bare PATH, without what the shell profile adds (nvm, fnm,
// ~/.local/bin, Homebrew). So the login shell is asked, as T3 Code's desktop
// asks it (MIT; re-implemented from `apps/desktop/src/shell/DesktopShellEnvironment.ts`,
// read at bc0f04d): an interactive login shell prints PATH between two
// markers, whatever else its profile prints; on Windows, PowerShell with the
// operator's profile and without it. Folders where the harnesses' own
// installers put them are added after, for a profile that does not.

const START = "__J3_BOTS_PATH_START__";
const END = "__J3_BOTS_PATH_END__";

/** How long a shell may take to print its PATH, its profile included. */
const PROBE_DEADLINE = Duration.seconds(10);

/**
 * The value between the markers in a shell's output, or none: a profile may
 * print before and after, and a shell that failed prints no markers.
 */
export const betweenMarkers = (output: string): Option.Option<string> => {
  const start = output.indexOf(START);
  if (start === -1) return Option.none();
  const from = start + START.length;
  const end = output.indexOf(END, from);
  if (end === -1) return Option.none();
  const value = output
    .slice(from, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
  return value.length > 0 ? Option.some(value) : Option.none();
};

/**
 * `paths` merged into one PATH for `platform`, in order, each folder once:
 * Windows compares folders without case and drops blank entries; elsewhere a
 * folder is kept as written.
 */
export const mergePaths = (platform: NodeJS.Platform, paths: ReadonlyArray<string>): string => {
  const separator = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const merged: Array<string> = [];
  for (const path of paths) {
    for (const entry of path.split(separator)) {
      const folder = platform === "win32" ? entry.trim() : entry;
      if (folder.length === 0) continue;
      const key = platform === "win32" ? windowsNameKey(folder) : folder;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(folder);
    }
  }
  return merged.join(separator);
};

/** Where the harnesses' installers and the usual Node managers put commands, for `home`. */
export const knownFolders = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): ReadonlyArray<string> => {
  if (platform === "win32") {
    const appData = env["APPDATA"];
    const localAppData = env["LOCALAPPDATA"];
    return [
      ...(appData === undefined ? [] : [`${appData}\\npm`]),
      ...(localAppData === undefined
        ? []
        : [
            `${localAppData}\\Programs\\nodejs`,
            `${localAppData}\\Volta\\bin`,
            `${localAppData}\\pnpm`,
          ]),
      `${home}\\.local\\bin`,
      `${home}\\.bun\\bin`,
      `${home}\\scoop\\shims`,
    ];
  }
  return [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.npm-global/bin`,
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
    "/usr/local/bin",
    ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
  ];
};

/** What a shell printed, or nothing when it did not start, failed or took too long. */
const outputOf = (command: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  Probe.outputOf(command, args, { deadline: PROBE_DEADLINE, env });

const unixProbe = `printf '%s' '${START}'; printf '%s' "$PATH"; printf '%s' '${END}'`;
const windowsProbe = `Write-Output '${START}'; Write-Output $env:PATH; Write-Output '${END}'`;

/** The PATH `shell`, started as an interactive login shell, sets up. */
const loginShellPath = (shell: string, env: Record<string, string>) =>
  outputOf(shell, ["-ilc", unixProbe], env).pipe(Effect.map(Option.flatMap(betweenMarkers)));

/** The PATH PowerShell sets up, with the operator's profile or without it. */
const powerShellPath = Effect.fn("ShellPath.powerShellPath")(function* (
  env: Record<string, string>,
  profile: boolean,
) {
  const args = [
    "-NoLogo",
    ...(profile ? [] : ["-NoProfile"]),
    "-NonInteractive",
    "-Command",
    windowsProbe,
  ];
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    const found = (yield* outputOf(command, args, env)).pipe(Option.flatMap(betweenMarkers));
    if (Option.isSome(found)) return found;
  }
  return Option.none<string>();
});

export interface ProbeOptions {
  readonly platform: NodeJS.Platform;
  /** The app's own environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** The operator's login shell, as the system names it (`os.userInfo().shell`). */
  readonly loginShell: string | null;
}

/** The variables of `env` that hold a value. */
const defined = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) kept[name] = value;
  return kept;
};

/**
 * The PATH the server runs with: the login shell's (on Windows, PowerShell's
 * with the profile, then without), then the folders of `knownFolders`, then
 * the app's own PATH.
 */
export const probePath = Effect.fn("ShellPath.probePath")(function* (options: ProbeOptions) {
  const env = defined(options.env);
  const own = env["PATH"] ?? env["Path"] ?? "";
  const known = knownFolders(options.platform, options.env, options.home);
  const separator = options.platform === "win32" ? ";" : ":";
  if (options.platform === "win32") {
    const [profile, noProfile] = yield* Effect.all(
      [powerShellPath(env, true), powerShellPath(env, false)],
      { concurrency: 2 },
    );
    return mergePaths("win32", [
      ...Option.toArray(profile),
      known.join(separator),
      ...Option.toArray(noProfile),
      own,
    ]);
  }
  const shells = [...new Set([env["SHELL"], options.loginShell ?? undefined])].filter(
    (shell): shell is string => shell !== undefined && shell.length > 0,
  );
  for (const shell of shells) {
    const found = yield* loginShellPath(shell, env);
    if (Option.isSome(found))
      return mergePaths(options.platform, [found.value, known.join(separator), own]);
  }
  yield* Effect.logWarning("No login shell gave its PATH; the server runs with the app's own");
  return mergePaths(options.platform, [known.join(separator), own]);
});
