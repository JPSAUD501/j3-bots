// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { engineFolders } from "./PrivateFiles.ts";

// The engine's own browser from before J3 Bots ran its own (decision 0110):
// its profiles, where the sign-ins the bots made then are, and the browser
// that wrote them. The server moves those sign-ins into its own once, then
// removes both. Nothing else here knows where the engine kept them.
//
// - The profiles: `server-browser/profiles/<profile>/` in the engine's state
//   folder, `userdata` (**Read** at `bc0f04d`,
//   `apps/server/src/preview/ServerBrowser.ts`, `profilesDir`, and
//   `apps/server/src/config.ts`, `stateDir`).
// - The browser: `tools/chrome-headless-shell/<platform>/<version>/` under the
//   engine's data folder (**Read** at `bc0f04d`,
//   `apps/server/src/preview/PreviewBrowser.ts`). Its platform is Chrome for
//   Testing's name for the build: `linux64` and `linux-arm64` are **Read**
//   there; `mac-arm64`, `mac-x64` and `win64`, and the `.exe` on Windows, are
//   **Assumed** to follow Chrome for Testing the same way.

/** The engine's browser of before, as it is on the disk. */
export interface OldEngineBrowser {
  /** Each profile folder it kept. */
  readonly profiles: ReadonlyArray<string>;
  /** The browser that wrote them, the newest it kept, if one is there. */
  readonly executable: Option.Option<string>;
}

const BUILDS: Partial<Record<NodeJS.Platform, Partial<Record<string, string>>>> = {
  linux: { x64: "linux64", arm64: "linux-arm64" },
  darwin: { x64: "mac-x64", arm64: "mac-arm64" },
  win32: { x64: "win64" },
};

/** Chromium versions, the newest first. */
const newestFirst = (a: string, b: string) => {
  const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10));
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const browserRoot = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).userdata, "server-browser");

/** The engine's browser of before, for the engine's data folder `home`. */
export const oldEngineBrowser = Effect.fn("engine.oldBrowser")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders = (folder: string) =>
    fs.readDirectory(folder).pipe(
      Effect.flatMap((names) =>
        Effect.filter(names, (name) =>
          fs.stat(path.join(folder, name)).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          ),
        ),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const profilesFolder = path.join(browserRoot(path, home), "profiles");
  const profiles = (yield* folders(profilesFolder)).map((name) => path.join(profilesFolder, name));

  const build = BUILDS[process.platform]?.[process.arch];
  let executable = Option.none<string>();
  if (build !== undefined) {
    const builds = path.join(home, "tools", "chrome-headless-shell", build);
    const name =
      process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
    for (const version of [...(yield* folders(builds))].sort(newestFirst)) {
      const candidate = path.join(builds, version, name);
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        executable = Option.some(candidate);
        break;
      }
    }
  }
  return { profiles, executable } satisfies OldEngineBrowser;
});

/**
 * Removes the engine's browser of before, once its sign-ins are moved: its
 * profiles and the browser itself, which the engine starts no more.
 */
export const removeOldEngineBrowser = Effect.fn("engine.removeOldBrowser")(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(browserRoot(path, home), { recursive: true, force: true });
  yield* fs.remove(path.join(home, "tools", "chrome-headless-shell"), {
    recursive: true,
    force: true,
  });
});
