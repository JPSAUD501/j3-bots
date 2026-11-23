// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// What the engine's headless browser needs from a Linux host, found the way
// the engine's own `t3 browser setup` finds it (**Read** at `59651c1`,
// `apps/server/src/preview/PreviewBrowserHost.ts` and
// `apps/server/src/cli/browser.ts`). Nothing here changes the host: the fix is
// that setup command, run once as root.

/** Set on Ubuntu 23.10 and later: unprivileged user namespaces, which Chrome's sandbox uses, need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** The profile the engine's setup writes for its browser. */
const APPARMOR_PROFILE = "/etc/apparmor.d/t3-chrome-headless-shell";

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

/** What stands between this host and the engine's browser, on Linux. */
export interface BrowserHostNeeds {
  /**
   * AppArmor restricts unprivileged user namespaces and the engine's profile
   * is not on disk, so Chrome's sandbox cannot start. A profile on disk that
   * the kernel has not loaded only shows when the browser starts.
   */
  readonly sandboxBlocked: boolean;
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
   * The command, by word, that allows the sandbox and installs the libraries
   * and fonts. It runs as root, and changes nothing that is already in place.
   */
  readonly setup: ReadonlyArray<string>;
}

/** The downloaded browser, if any: `tools/chrome-headless-shell/<platform>/<version>/` under the engine's data directory. */
const installedBrowser = Effect.fn("engine.installedBrowser")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(home, "tools", "chrome-headless-shell");
  const list = (folder: string) =>
    fs.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const platform of yield* list(root)) {
    for (const version of yield* list(path.join(root, platform))) {
      const executable = path.join(root, platform, version, "chrome-headless-shell");
      if (yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(executable);
      }
    }
  }
  return Option.none<string>();
});

/**
 * What the engine's browser needs from this Linux host, for the engine
 * executable `executable` and its data directory `home`.
 */
export const inspectBrowserHost = Effect.fn("engine.inspectBrowserHost")(function* (input: {
  readonly home: string;
  readonly executable: string;
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
  const browser = yield* installedBrowser(input.home);
  const missingLibraries = yield* Option.match(browser, {
    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
    onSome: Effect.fnUntraced(function* (executable) {
      // `--version` first: ldd can name a library that the loader still
      // finds, as NixOS's nix-ld provides.
      const loaderError = LOADER_ERROR.exec(yield* output(executable, ["--version"], true))?.[1];
      if (loaderError === undefined) return [];
      const listed = [
        ...(yield* output("ldd", [executable], true)).matchAll(MISSING_LIBRARY),
      ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
      return listed.length > 0 ? listed : [loaderError];
    }),
  });
  // Without fontconfig there is no `fc-match`, which counts as no font.
  const font = yield* output("fc-match", ["--format=%{file}", "sans-serif"], false);
  return {
    sandboxBlocked:
      restricted && !(yield* fs.exists(APPARMOR_PROFILE).pipe(Effect.orElseSucceed(() => false))),
    downloaded: Option.isSome(browser),
    missingLibraries,
    noFonts: font.trim() === "",
    setup: [input.executable, "browser", "setup", "--base-dir", input.home],
  } satisfies BrowserHostNeeds;
});
