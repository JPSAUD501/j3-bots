// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { chromeFolders, chromePlatformOf } from "./chrome.ts";

// What the server's own browser, Chrome for Testing (`chrome.ts`), needs from
// a Linux host: the checks T3 Code's `t3 browser setup` makes for its browser
// (**Read** at `bc0f04d`, `apps/server/src/preview/PreviewBrowserHost.ts` and
// `apps/server/src/cli/browser.ts`), made for this one. Nothing here changes
// the host. The fix is plain commands that run, as root, only system tools:
// never the browser or J3 Bots, files the service account can replace.

/** Set on Ubuntu 23.10 and later: unprivileged user namespaces, which Chrome's sandbox uses, need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/**
 * The profile that lets the server's browser make its sandbox, by path and
 * name: the sandbox counts as allowed once this file is on disk.
 */
const APPARMOR_PROFILE = "/etc/apparmor.d/j3-bots-chrome";

/**
 * Its content: only the browser J3 Bots downloads, at the path `chrome.ts`
 * keeps it at under any home, may make the user namespace its sandbox needs,
 * which any program may on a host without the restriction. It gives no other
 * right, and runs nothing as root.
 */
const APPARMOR_PROFILE_LINES = [
  "# Lets the J3 Bots server's browser use Chrome's sandbox.",
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "profile j3-bots-chrome /**/browser/chrome/*/chrome-linux*/chrome flags=(unconfined) {",
  "  userns,",
  "  include if exists <local/j3-bots-chrome>",
  "}",
];

/**
 * The Debian and Ubuntu packages the browser loads, as T3 Code's setup
 * installs them for its Chrome build: of each, the first name apt offers,
 * since Ubuntu 24.04 and Debian 13 renamed some (`t64`).
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
 *   profile is not on disk;
 * - `profile-unloaded`: the profile is on disk, yet the server found the
 *   sandbox blocked when it last started the browser: the kernel has not
 *   loaded it, as on a host restored from an image. Only root can read the
 *   loaded profiles, so only a start shows it;
 * - `unknown`: the server found the sandbox blocked on a host without the
 *   restriction, for a cause this check does not know.
 */
export type SandboxBlock = "none" | "no-profile" | "profile-unloaded" | "unknown";

/** What stands between this host and the server's browser, on Linux. */
export interface BrowserHostNeeds {
  readonly sandbox: SandboxBlock;
  /**
   * Whether the browser is downloaded yet: the server downloads it, about
   * 210 MB, the first time a tab opens on the server.
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
      // browser is built for 64-bit only.
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

/** The server's browser, if it is downloaded under the server's `home`. */
const installedBrowser = Effect.fn("browser.installedBrowser")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = chromePlatformOf(process.platform, process.arch);
  if (Option.isNone(platform)) return Option.none<string>();
  const { executable } = chromeFolders(path, home, platform.value);
  return (yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false)))
    ? Option.some(executable)
    : Option.none<string>();
});

/**
 * The packages `apt-cache policy` offers a version of, from what it printed
 * for several names in the C locale: each name heads its block, as
 * `<name>:`, and a block whose `Candidate:` is `(none)` is one apt cannot
 * install. A name apt does not know prints no block.
 */
export const offeredPackagesOf = (policy: string): ReadonlySet<string> => {
  const offered = new Set<string>();
  let current: string | undefined;
  for (const line of policy.split("\n")) {
    const heading = /^(\S+):$/.exec(line)?.[1];
    if (heading !== undefined) {
      current = heading;
      continue;
    }
    const candidate = /^\s+Candidate:\s*(\S+)/.exec(line)?.[1];
    if (current !== undefined && candidate !== undefined && candidate !== "(none)") {
      offered.add(current);
    }
  }
  return offered;
};

/**
 * What the server's browser needs from this Linux host, for the server's
 * `home`. `sandboxRefused`: the server found the sandbox blocked when it last
 * started the browser, which the files here may not show.
 */
export const inspectBrowserHost = Effect.fn("browser.inspectBrowserHost")(function* (input: {
  readonly home: string;
  readonly sandboxRefused: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // In the C locale, as the output is read for words a translation would change.
  const output = (command: string, args: ReadonlyArray<string>, includeStderr: boolean) =>
    spawner
      .string(
        ChildProcess.make(command, args, {
          stdin: "ignore",
          env: { LC_ALL: "C" },
          extendEnv: true,
        }),
        { includeStderr },
      )
      .pipe(
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
  // apt-cache reads the package lists without root, every name in one run.
  const debianLibraries = output("apt-cache", ["policy", ...DEBIAN_PACKAGES.flat()], false).pipe(
    Effect.map((policy) => {
      const offered = offeredPackagesOf(policy);
      return DEBIAN_PACKAGES.map((names) => names.find((name) => offered.has(name)) ?? names[0]);
    }),
  );
  const packageManager: PackageManager = (yield* exists("/usr/bin/apt-get"))
    ? { _tag: "apt-get", libraries: missingLibraries.length === 0 ? [] : yield* debianLibraries }
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
