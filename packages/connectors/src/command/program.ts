// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Whether a file may be run is node:fs's access check, on the platform's own paths.
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { CommandFailed } from "../errors.ts";
import { searchPath } from "./environment.ts";

/**
 * The program a command connector runs, by its full path. No shell looks it
 * up: a name is found on the search path the command itself is given, and a
 * path is taken from the folder the command runs in. On Windows a name may
 * leave out its extension (`npx` for `npx.cmd`), which is found as Windows'
 * command interpreter would, through `PATHEXT`. A folder of the search path
 * that is not absolute is skipped: it would name a different folder for
 * every process that reads it.
 */

const WINDOWS_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";

/** Whether `file` is a file this user may run; on Windows, one that exists. */
const runnable = (platform: NodeJS.Platform, file: string): Promise<boolean> =>
  NodeFs.stat(file)
    .then((stat) =>
      !stat.isFile()
        ? false
        : platform === "win32"
          ? true
          : NodeFs.access(file, NodeFs.constants.X_OK).then(
              () => true,
              () => false,
            ),
    )
    .catch(() => false);

/** The files `base` may be on `platform`: itself, or, on Windows with no known extension, with each one. */
const candidates = (
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string>>,
  base: string,
): ReadonlyArray<string> => {
  if (platform !== "win32") return [base];
  const pathExt =
    Object.entries(environment).find(([name]) => name.toUpperCase() === "PATHEXT")?.[1] ??
    WINDOWS_EXTENSIONS;
  const extensions = pathExt
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  return extensions.includes(NodePath.win32.extname(base).toLowerCase())
    ? [base]
    : extensions.map((extension) => `${base}${extension}`);
};

/**
 * Whether Windows would hand `executable` with `args` to its command
 * interpreter, which reads its own syntax in the arguments: a batch file,
 * such as the `npx.cmd` npm installs, is run through `cmd.exe`, whatever
 * quoting the arguments were given. An argument with a character it treats
 * as more than text (a quote, `%` and `!` expansion, `^` escapes, `&` `|` `<`
 * `>` and parentheses, a control character) could run something the
 * operator never saw, so such a start is refused.
 */
export const interpreterReads = (
  platform: NodeJS.Platform,
  executable: string,
  args: ReadonlyArray<string>,
): boolean =>
  platform === "win32" &&
  /\.(bat|cmd)$/i.test(executable) &&
  args.some((arg) => /["%!^&|<>()]/.test(arg) || [...arg].some((c) => c.charCodeAt(0) < 0x20));

/**
 * The full path of `program` on `platform`, run from `cwd` with
 * `environment`, or `CommandFailed("not-found")`.
 */
export const resolveProgram = (input: {
  readonly platform: NodeJS.Platform;
  readonly program: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
}): Effect.Effect<string, CommandFailed> =>
  Effect.tryPromise({
    try: async () => {
      const { platform, program, environment } = input;
      const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
      const named = !/[\\/]/.test(program) && !(platform === "win32" && /^[a-z]:/i.test(program));
      const folders = named
        ? (searchPath(platform, environment) ?? "")
            .split(path.delimiter)
            .filter((folder) => folder !== "" && path.isAbsolute(folder))
        : [input.cwd];
      for (const folder of folders) {
        for (const file of candidates(platform, environment, path.resolve(folder, program))) {
          if (await runnable(platform, file)) return file;
        }
      }
      return null;
    },
    catch: () => new CommandFailed({ reason: "not-found" }),
  }).pipe(
    Effect.filterOrFail(
      (found): found is string => found !== null,
      () => new CommandFailed({ reason: "not-found" }),
    ),
  );
