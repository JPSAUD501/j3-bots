// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";

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
 * refused rather than guessed at. Other programs are run as they are given.
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

const uv = {
  valued: new Set([
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
  flags: new Set([
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--isolated",
    "--offline",
    "-n",
    "--no-cache",
    "--native-tls",
    "--no-progress",
    "--no-python-downloads",
  ]),
  shell: new Set<string>(),
  packages: new Set(["--from", "--with"]),
};

/**
 * An npm package at an exact version: `name@1.2.3` or `@scope/name@1.2.3`,
 * with an optional pre-release and build. Not a tag, a range, an alias, a
 * URL, a git repository or a path.
 */
const NPM_PINNED =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;

/**
 * A Python package at an exact version: `name==1.2.3` or `name@1.2.3`, with
 * optional extras, and a version of PEP 440's characters with no wildcard.
 * Not `===`, a range, a URL or a path.
 */
const PYTHON_PINNED =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\[[a-z0-9._,\s-]+\])?(?:==|@)\d[0-9a-z.!+-]*$/i;

/** The program's name, whatever its folder and, on Windows, its extension. */
const programName = (program: string): string =>
  (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");

/** The launcher `program` and `args` run, and the arguments it reads; none for any other program. */
const launcherOf = (
  program: string,
  args: ReadonlyArray<string>,
): Option.Option<{ readonly launcher: Launcher; readonly args: ReadonlyArray<string> }> => {
  const name = programName(program);
  if (name === "npx") return Option.some({ launcher: "npm-exec", args });
  if (name === "npm" && (args[0] === "exec" || args[0] === "x")) {
    return Option.some({ launcher: "npm-exec", args: args.slice(1) });
  }
  if (name === "uvx") return Option.some({ launcher: "uv-run", args });
  if (name === "uv" && args[0] === "tool" && args[1] === "run") {
    return Option.some({ launcher: "uv-run", args: args.slice(2) });
  }
  return Option.none();
};

/**
 * The packages a launcher's arguments fetch: those its package options name,
 * and the first word that is not an option, which is the package itself
 * unless npm's `--package` or uv's `--from` named it, when it is a program
 * that package gives. uv's `--with` adds packages beside it, several to a
 * word, separated by commas.
 */
const packagesOf = (
  launcher: Launcher,
  args: ReadonlyArray<string>,
): Option.Option<ReadonlyArray<string>> | "shell" => {
  const known = launcher === "npm-exec" ? npm : uv;
  const named: Array<string> = [];
  let firstIsProgram = false;
  const withFirst = (word: string | undefined) =>
    word === undefined ? Option.none() : Option.some(firstIsProgram ? named : [...named, word]);
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? "";
    if (word === "--") return withFirst(args[at + 1]);
    if (!word.startsWith("-") || word === "-") return withFirst(word);
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
 * Whether `program` with `args` runs only packages at an exact version: none
 * when it does, or when it runs no launcher the check reads; otherwise why
 * it is refused.
 */
export const pinRefusal = (
  program: string,
  args: ReadonlyArray<string>,
): Option.Option<PinRefusal> => {
  const found = launcherOf(program, args);
  if (Option.isNone(found)) return Option.none();
  const { launcher } = found.value;
  const packages = packagesOf(launcher, found.value.args);
  if (packages === "shell") return Option.some("shell");
  if (Option.isNone(packages)) return Option.some("unclear");
  return packages.value.every((spec) => pinned(launcher, spec))
    ? Option.none()
    : Option.some("floating");
};
