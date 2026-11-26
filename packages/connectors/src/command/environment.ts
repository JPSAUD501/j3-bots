// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Redacted from "effect/Redacted";

/**
 * The environment a command connector's process starts with: the few of the
 * server's own variables a program needs to start and find its files, and
 * the variables the operator gave it, from the secrets. Nothing else of the
 * server's reaches it: not a provider key, not J3 Bots' own settings, not
 * whatever the shell that started the server exported.
 */

/** The server's variables a command is given on Linux and macOS: where programs are, the home folder, the language, the temporary folder. */
const POSIX_ALLOWED = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"] as const;

/**
 * Their Windows counterparts, with what Windows' own programs and launchers
 * such as `npx.cmd` need to start: the system folders, the command
 * interpreter, the extensions a program may have, and the user's profile
 * folders, where npm and Python keep their caches.
 */
const WINDOWS_ALLOWED = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "TEMP",
  "TMP",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
] as const;

/** A variable the operator gave the command, with its value from the secrets. */
export interface CommandVariable {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

/**
 * The command's environment on `platform`: the allowed variables of
 * `server`, under the names it has them by, then `given`, which replace any
 * of the same name. Windows compares names without case, as it reads them.
 */
export const commandEnvironment = (
  platform: NodeJS.Platform,
  server: Readonly<Record<string, string | undefined>>,
  given: ReadonlyArray<CommandVariable>,
): Record<string, string> => {
  const windows = platform === "win32";
  const fold = (name: string) => (windows ? name.toUpperCase() : name);
  const allowed = new Set<string>(windows ? WINDOWS_ALLOWED : POSIX_ALLOWED);
  const overridden = new Set(given.map((variable) => fold(variable.name)));
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(server)) {
    if (value !== undefined && allowed.has(fold(name)) && !overridden.has(fold(name))) {
      environment[name] = value;
    }
  }
  for (const variable of given) environment[variable.name] = Redacted.value(variable.value);
  return environment;
};

/** The search path in `environment`: `Path` as Windows often spells it, or `PATH`. */
export const searchPath = (
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string>>,
): string | undefined =>
  platform === "win32"
    ? Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1]
    : environment["PATH"];
