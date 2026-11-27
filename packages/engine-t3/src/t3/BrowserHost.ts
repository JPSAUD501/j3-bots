// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// What the engine's headless browser needs from a Linux host, found the way
// the engine's own `t3 browser setup` finds it (**Read** at `bc0f04d`,
// `apps/server/src/preview/PreviewBrowserHost.ts` and
// `apps/server/src/cli/browser.ts`). Nothing here changes the host. The fix is
// not that command: run as root, it would run the engine's executable, which
// the service account can replace. It is the same steps written as plain
// commands that run, as root, only system tools.

/** Set on Ubuntu 23.10 and later: unprivileged user namespaces, which Chrome's sandbox uses, need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/**
 * The profile the engine's setup writes for its browser, by path and name:
 * the engine counts the sandbox as allowed once this file is on disk.
 */
const APPARMOR_PROFILE = "/etc/apparmor.d/t3-chrome-headless-shell";

/**
 * Its content, as the engine's setup writes it (the engine's is under the MIT
 * license, as is its source): only the browser the engine downloads may make
 * the user namespace its sandbox needs, which any program may on a host
 * without the restriction. It gives no other right, and runs nothing as root.
 */
const APPARMOR_PROFILE_LINES = [
  "# Lets the J3 Bots engine's headless browser use Chrome's sandbox.",
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {",
  "  userns,",
  "  include if exists <local/t3-chrome-headless-shell>",
  "}",
];

/**
 * The Debian and Ubuntu packages the browser loads, as the engine's setup
 * installs them: of each, the first name apt offers, since Ubuntu 24.04 and
 * Debian 13 renamed some (`t64`).
 */
const DEBIAN_PACKAGES: ReadonlyArray<readonly [string, ...Array<string>]> = [
  ["libnss3"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
];

const DEBIAN_FONTS = ["fontconfig", "fonts-liberation"];
const FEDORA_FONTS = ["fontconfig", "liberation-sans-fonts"];

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;
/**
 * A library's file name. The browser is a file the service account can
 * replace, so a name it asks for is shown, or put in a command, only if it
 * has this shape.
 */
const LIBRARY_NAME = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*\.so(\.[0-9]+)*$/;

/**
 * Whether Chrome's sandbox can start, and if not, why:
 * - `no-profile`: AppArmor restricts unprivileged user namespaces and the
 *   engine's profile is not on disk;
 * - `profile-unloaded`: the profile is on disk, yet the engine found the
 *   sandbox blocked when it last started the browser: the kernel has not
 *   loaded it, as on a host restored from an image. Only root can read the
 *   loaded profiles, so only a start shows it;
 * - `unknown`: the engine found the sandbox blocked on a host without the
 *   restriction, for a cause this check does not know.
 */
export type SandboxBlock = "none" | "no-profile" | "profile-unloaded" | "unknown";

/** What stands between this host and the engine's browser, on Linux. */
export interface BrowserHostNeeds {
  readonly sandbox: SandboxBlock;
  /**
   * Whether the browser is downloaded yet: the engine downloads it, about
   * 130 MB, the first time a bot uses it.
   */
  readonly downloaded: boolean;
  /** The shared libraries the downloaded browser cannot load; none until it is downloaded. */
  readonly missingLibraries: ReadonlyArray<string>;
  /** Fontconfig finds no font, so pages render without text. */
  readonly noFonts: boolean;
  /**
   * The commands that fix it, one shell line each, for an administrator to
   * run once. Each runs as root, through sudo, only a system tool: `tee` and
   * `apparmor_parser` for the sandbox, apt-get or dnf for the libraries and
   * fonts. Nothing the service account can write runs as root. Empty when
   * nothing is missing, and for a sandbox blocked for an `unknown` cause.
   */
  readonly setup: ReadonlyArray<string>;
  /**
   * Libraries or fonts are missing on a host with neither apt-get nor dnf,
   * which `setup` cannot install: the administrator installs them with the
   * system's own package manager.
   */
  readonly packagesByHand: boolean;
}

/** One shell word, single-quoted unless it is plain. */
const word = (value: string) =>
  /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const line = (words: ReadonlyArray<string>) => words.map(word).join(" ");

/** How the host installs packages: apt-get, with the packages apt offers; dnf; or neither. */
type PackageManager =
  | { readonly _tag: "apt-get"; readonly libraries: ReadonlyArray<string> }
  | { readonly _tag: "dnf" }
  | { readonly _tag: "none" };

/** The library names a failed start of the browser reports: of `ldd`'s list, or else the loader's one. */
export const missingLibrariesOf = (loaderError: string, lddOutput: string) => {
  const listed = [...lddOutput.matchAll(MISSING_LIBRARY)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  return (listed.length > 0 ? listed : [loaderError]).filter((name) => LIBRARY_NAME.test(name));
};

/** The commands that fix what is missing (`BrowserHostNeeds.setup`). */
export const setupOf = (input: {
  readonly sandbox: SandboxBlock;
  readonly missingLibraries: ReadonlyArray<string>;
  readonly noFonts: boolean;
  readonly packageManager: PackageManager;
}): Pick<BrowserHostNeeds, "setup" | "packagesByHand"> => {
  const setup: Array<string> = [];
  if (input.sandbox === "no-profile") {
    setup.push(
      `printf '%s\\n' ${APPARMOR_PROFILE_LINES.map(word).join(" ")} | ${line(["sudo", "tee", APPARMOR_PROFILE])} > /dev/null`,
    );
  }
  if (input.sandbox === "no-profile" || input.sandbox === "profile-unloaded") {
    setup.push(line(["sudo", "apparmor_parser", "-r", APPARMOR_PROFILE]));
  }
  const libraries = input.missingLibraries.length > 0;
  if (!libraries && !input.noFonts) return { setup, packagesByHand: false };
  switch (input.packageManager._tag) {
    case "apt-get":
      setup.push(
        line(["sudo", "apt-get", "update"]),
        line([
          "sudo",
          "apt-get",
          "install",
          "-y",
          "--no-install-recommends",
          ...(libraries ? input.packageManager.libraries : []),
          ...(input.noFonts ? DEBIAN_FONTS : []),
        ]),
      );
      return { setup, packagesByHand: false };
    case "dnf":
      // dnf installs a library by the file name a package provides; the
      // engine's browser is built for 64-bit only.
      setup.push(
        line([
          "sudo",
          "dnf",
          "install",
          "-y",
          ...input.missingLibraries.map((name) => `${name}()(64bit)`),
          ...(input.noFonts ? FEDORA_FONTS : []),
        ]),
      );
      return { setup, packagesByHand: false };
    case "none":
      return { setup, packagesByHand: true };
  }
};

/** The profile `setupOf` writes, line by line. */
export const apparmorProfile = APPARMOR_PROFILE_LINES;

/**
 * The browser release the pinned engine runs: it starts exactly this version,
 * downloading it on first use, and keeps the one it replaced beside it
 * (**Read** at `bc0f04d`, `apps/server/src/preview/PreviewBrowser.ts`,
 * `VERSION` and `installedExecutable`). Moves with the pin
 * (docs/architecture/engine.md, "Upgrading the engine").
 */
const ENGINE_BROWSER_VERSION = "158.0.8127.88";

/**
 * The folder the engine keeps its Linux browser in for a processor
 * architecture, as Chrome for Testing names its builds; none for one the
 * browser has no build for (**Read** at `bc0f04d`,
 * `apps/server/src/preview/PreviewBrowser.ts`, `chromePlatform`).
 */
export const browserPlatformOf = (arch: string): string | undefined =>
  arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : undefined;

/**
 * The browser the engine runs, if it is downloaded:
 * `tools/chrome-headless-shell/<platform>/<version>/` under the engine's data
 * directory, for this machine's architecture. Another version there is one
 * the engine kept from before, which it no longer starts.
 */
const installedBrowser = Effect.fn("engine.installedBrowser")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = browserPlatformOf(process.arch);
  if (platform === undefined) return Option.none<string>();
  const executable = path.join(
    home,
    "tools",
    "chrome-headless-shell",
    platform,
    ENGINE_BROWSER_VERSION,
    "chrome-headless-shell",
  );
  return (yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false)))
    ? Option.some(executable)
    : Option.none<string>();
});

/**
 * What the engine's browser needs from this Linux host, for the engine's data
 * directory `home`. `sandboxRefused`: the engine found the sandbox blocked
 * when it last started the browser, which the files here may not show.
 */
export const inspectBrowserHost = Effect.fn("engine.inspectBrowserHost")(function* (input: {
  readonly home: string;
  readonly sandboxRefused: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = (command: string, args: ReadonlyArray<string>, includeStderr: boolean) =>
    spawner.string(ChildProcess.make(command, args, { stdin: "ignore" }), { includeStderr }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ""),
    );

  const restricted = yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const browser = yield* installedBrowser(input.home);
  const missingLibraries = yield* Option.match(browser, {
    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
    onSome: Effect.fnUntraced(function* (executable) {
      // `--version` first: ldd can name a library that the loader still
      // finds, as NixOS's nix-ld provides.
      const loaderError = LOADER_ERROR.exec(yield* output(executable, ["--version"], true))?.[1];
      if (loaderError === undefined) return [];
      return missingLibrariesOf(loaderError, yield* output("ldd", [executable], true));
    }),
  });
  // Without fontconfig there is no `fc-match`, which counts as no font.
  const noFonts =
    (yield* output("fc-match", ["--format=%{file}", "sans-serif"], false)).trim() === "";
  const sandbox: SandboxBlock = restricted
    ? !(yield* exists(APPARMOR_PROFILE))
      ? "no-profile"
      : input.sandboxRefused
        ? "profile-unloaded"
        : "none"
    : input.sandboxRefused
      ? "unknown"
      : "none";
  // apt-cache reads the package lists without root.
  const offered = (name: string) =>
    output("apt-cache", ["policy", name], false).pipe(
      Effect.map((policy) => {
        const candidate = /Candidate:\s*(\S+)/.exec(policy)?.[1];
        return candidate !== undefined && candidate !== "(none)";
      }),
    );
  const packageManager: PackageManager = (yield* exists("/usr/bin/apt-get"))
    ? {
        _tag: "apt-get",
        libraries:
          missingLibraries.length === 0
            ? []
            : yield* Effect.forEach(DEBIAN_PACKAGES, (names) =>
                Effect.findFirst(names, offered).pipe(Effect.map(Option.getOrElse(() => names[0]))),
              ),
      }
    : (yield* exists("/usr/bin/dnf"))
      ? { _tag: "dnf" }
      : { _tag: "none" };
  return {
    sandbox,
    downloaded: Option.isSome(browser),
    missingLibraries,
    noFonts,
    ...setupOf({ sandbox, missingLibraries, noFonts, packageManager }),
  } satisfies BrowserHostNeeds;
});
