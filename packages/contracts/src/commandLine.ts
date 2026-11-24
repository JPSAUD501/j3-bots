// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";

// The rules a command connector's command line keeps (`CommandLine`), which
// the server enforces and a client's form checks before it sends one.

/**
 * Whether a command connector runs a package at the exact version the
 * operator saw (`docs/architecture/security.md`, "Connectors started by
 * command"). `npx` and `uvx` fetch a package by name each time they start it:
 * named with no version, a tag such as `latest` or a range, the code that
 * runs is whatever the registry gives that day, not what the operator
 * confirmed. So a command run through one of them must name every package it
 * fetches at an exact version.
 *
 * The check reads the launcher's own options. One it does not know may take
 * a value, so which word is the package cannot be told: the command is
 * refused rather than guessed at. `npx` stops reading its options at the
 * package, so what follows is the package's own; `npm exec` reads options
 * after it too, so through `npm exec` the package must follow a `--`. npm
 * takes any prefix of a command only it has for the command, so a word that
 * could be `exec`, `init` or `create` (which runs a package of its own) is
 * refused, as is an option before npm's command. uv's own options are read
 * wherever they come before its command. A launcher's settings from the
 * environment (`npm_config_*`, `UV_*`) can choose another package or
 * registry, so a variable of the operator's by such a name is refused too.
 * Other programs are run as they are given.
 */

/** Why a command is refused. */
export type PinRefusal =
  /** A package named with no version, a tag, a range, or from somewhere other than the registry. */
  | "floating"
  /** An option the check does not know, or no package at all: which package runs cannot be told. */
  | "unclear"
  /** `npx -c`: a shell line, which can fetch anything. */
  | "shell";

/** The launchers the check reads, by the program's name. */
type Launcher = "npm-exec" | "uv-run";

const npm = {
  /** Options that take the next word as their value, unless given as `--name=value`. */
  valued: new Set(["-p", "--package", "--registry", "--cache", "--userconfig", "--loglevel"]),
  /** Options that take no value. */
  flags: new Set([
    "-y",
    "--yes",
    "--no",
    "-q",
    "--quiet",
    "-s",
    "--silent",
    "--prefer-offline",
    "--prefer-online",
    "--offline",
  ]),
  shell: new Set(["-c", "--call"]),
  packages: new Set(["-p", "--package"]),
};

/** uv's own options, which it reads before and after its command. */
const UV_GLOBAL = {
  valued: ["--cache-dir", "--color", "--directory", "--project", "--config-file"],
  flags: [
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--offline",
    "-n",
    "--no-cache",
    "--native-tls",
    "--no-progress",
    "--no-python-downloads",
    "--no-config",
    "--isolated",
  ],
};

const uv = {
  valued: new Set([
    ...UV_GLOBAL.valued,
    "--from",
    "--with",
    "-p",
    "--python",
    "-i",
    "--index",
    "--default-index",
    "--index-url",
    "--extra-index-url",
    "-f",
    "--find-links",
    "--index-strategy",
    "--cache-dir",
    "--color",
    "--resolution",
    "--prerelease",
    "--python-preference",
    "--exclude-newer",
  ]),
  flags: new Set(UV_GLOBAL.flags),
  shell: new Set<string>(),
  packages: new Set(["--from", "--with"]),
};

/**
 * An npm package at an exact version: `name@1.2.3` or `@scope/name@1.2.3`,
 * with an optional pre-release and build, each as semver writes it, since
 * npm takes what is not a valid version for a tag. Not a tag, a range, an
 * alias, a URL, a git repository or a path.
 */
const NPM_PINNED =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;

/**
 * A Python package at an exact version: `name==1.2.3` or `name@1.2.3`, with
 * optional extras, and a version of PEP 440's characters with no wildcard.
 * Not `===`, a range, a URL or a path.
 */
const PYTHON_PINNED =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\[[a-z0-9._,\s-]+\])?(?:==|@)\d[0-9a-z.!+-]*$/i;

/**
 * The name of the file `program` runs, whatever its folder and, on Windows,
 * its extension: its path read as the system reads it, `.` and `..` and
 * all, and without the trailing dots and spaces Windows drops.
 */
const programName = (program: string): string => {
  const segments: Array<string> = [];
  for (const segment of program.split(/[\\/]/)) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return (segments.at(-1) ?? "")
    .replace(/[. ]+$/, "")
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|com|ps1)$/, "");
};

/** npm's commands that run a package other than through `exec`'s own arguments. */
const NPM_RUNS = ["exec", "init", "create", "innit"];

/** uv's arguments after its own leading options: its command first; none when one is not known. */
const uvCommand = (args: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> => {
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? "";
    if (!word.startsWith("-")) return Option.some(args.slice(at));
    const equals = word.indexOf("=");
    const option = equals < 0 ? word : word.slice(0, equals);
    if (UV_GLOBAL.flags.includes(option) && equals < 0) continue;
    if (!UV_GLOBAL.valued.includes(option)) return Option.none();
    if (equals < 0) at++;
  }
  return Option.some([]);
};

interface Launched {
  readonly launcher: Launcher;
  /** The arguments the launcher reads. */
  readonly args: ReadonlyArray<string>;
  /** Whether it reads options after the package too, so the package must follow `--`. */
  readonly optionsAfterPackage: boolean;
}

/**
 * The launcher `program` and `args` run; none for any other program, and
 * `unclear` when which command npm or uv runs cannot be told: an option
 * before npm's command, which may take the next word as its value, a word
 * npm could read as a command that runs a package, or an option of uv's own
 * the check does not know.
 */
const launcherOf = (
  program: string,
  args: ReadonlyArray<string>,
): Option.Option<Launched> | "unclear" => {
  const name = programName(program);
  if (name === "npx") {
    return Option.some({ launcher: "npm-exec", args, optionsAfterPackage: false });
  }
  if (name === "npm") {
    const command = args[0] ?? "";
    if (command === "exec" || command === "x") {
      return Option.some({ launcher: "npm-exec", args: args.slice(1), optionsAfterPackage: true });
    }
    const couldRun = command.length >= 2 && NPM_RUNS.some((run) => run.startsWith(command));
    return command.startsWith("-") || couldRun ? "unclear" : Option.none();
  }
  if (name === "uvx") return Option.some({ launcher: "uv-run", args, optionsAfterPackage: false });
  if (name === "uv") {
    const command = uvCommand(args);
    if (Option.isNone(command)) return "unclear";
    const [first, second] = command.value;
    if (first !== "tool") return Option.none();
    if (second === "run") {
      return Option.some({
        launcher: "uv-run",
        args: command.value.slice(2),
        optionsAfterPackage: false,
      });
    }
    return second?.startsWith("-") === true ? "unclear" : Option.none();
  }
  return Option.none();
};

/** Whether a variable named `name` is one of the launcher's settings, which can choose what it fetches. */
const launcherSetting = (launcher: Launcher, name: string): boolean =>
  launcher === "npm-exec" ? /^npm_config_/i.test(name) : /^uv_/i.test(name);

/**
 * The packages a launcher's arguments fetch: those its package options name,
 * and the first word that is not an option, which is the package itself
 * unless npm's `--package` or uv's `--from` named it, when it is a program
 * that package gives. uv's `--with` adds packages beside it, several to a
 * word, separated by commas.
 */
const packagesOf = ({
  launcher,
  args,
  optionsAfterPackage,
}: Launched): Option.Option<ReadonlyArray<string>> | "shell" => {
  const known = launcher === "npm-exec" ? npm : uv;
  const named: Array<string> = [];
  let firstIsProgram = false;
  const withFirst = (word: string | undefined) =>
    word === undefined ? Option.none() : Option.some(firstIsProgram ? named : [...named, word]);
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? "";
    if (word === "--") return withFirst(args[at + 1]);
    if (!word.startsWith("-") || word === "-") {
      // Options after it would be the launcher's, and could name another package.
      return optionsAfterPackage ? Option.none() : withFirst(word);
    }
    const equals = word.indexOf("=");
    const option = equals < 0 ? word : word.slice(0, equals);
    if (known.shell.has(option)) return "shell";
    if (known.flags.has(option) && equals < 0) continue;
    if (!known.valued.has(option)) return Option.none();
    const value = equals < 0 ? args[++at] : word.slice(equals + 1);
    if (value === undefined) return Option.none();
    if (known.packages.has(option)) {
      named.push(...(option === "--with" ? value.split(",") : [value]));
      if (option !== "--with") firstIsProgram = true;
    }
  }
  // Options alone: the packages they name, by their own program.
  return firstIsProgram ? Option.some(named) : Option.none();
};

const pinned = (launcher: Launcher, spec: string): boolean =>
  (launcher === "npm-exec" ? NPM_PINNED : PYTHON_PINNED).test(spec.trim());

/**
 * Whether `program` with `args`, and the operator's variables named
 * `variables`, runs only packages at an exact version: none when it does,
 * or when it runs no launcher the check reads; otherwise why it is refused.
 */
export const pinRefusal = (
  program: string,
  args: ReadonlyArray<string>,
  variables: ReadonlyArray<string> = [],
): Option.Option<PinRefusal> => {
  const found = launcherOf(program, args);
  if (found === "unclear") return Option.some("unclear");
  if (Option.isNone(found)) return Option.none();
  const { launcher } = found.value;
  if (variables.some((name) => launcherSetting(launcher, name))) return Option.some("unclear");
  const packages = packagesOf(found.value);
  if (packages === "shell") return Option.some("shell");
  if (Option.isNone(packages)) return Option.some("unclear");
  return packages.value.every((spec) => pinned(launcher, spec))
    ? Option.none()
    : Option.some("floating");
};

/**
 * The variables the server reads to find and start the program: the search
 * path and, on Windows, the system folder its launcher is found in and what
 * starts a batch file. The operator gives none of them: their values can
 * change with no new confirmation, and would choose which program runs.
 */
const RESERVED = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "PSMODULEPATH"]);

/** Whether a command may not be given a variable named `name`, in any case. */
export const reservedVariable = (name: string): boolean => RESERVED.has(name.toUpperCase());
