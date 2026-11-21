// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { Installation } from "../installation.ts";

// Where `scripts/install.sh` puts J3 Bots on a host, outside the data
// directory (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
//
//   <install>/versions/<version>/   one unpacked release archive each
//   <install>/launcher              the path of the j3-bots command, one line
//   <bin>/j3-bots                   the command, which runs one of the versions:
//                                     #!/bin/sh
//                                     # <a comment>
//                                     exec '<install>/versions/<version>/bin/j3-bots' "$@"
//
// `<install>` is `$XDG_DATA_HOME/j3-bots`, `~/.local/share/j3-bots` or
// `J3_INSTALL_DIR`, and `<bin>` is `~/.local/bin` or `J3_BIN_DIR`.

/** The folder of `<install>` that holds the releases, one folder per version. */
export const VERSIONS = "versions";

/** The file in `<install>` that names the j3-bots command install.sh wrote. */
export const LAUNCHER_RECORD = "launcher";

/**
 * The whole text of the command install.sh writes: three lines, a comment in
 * the middle, and the release it runs in the last.
 */
const LAUNCHER = /^#!\/bin\/sh\n# [^\n]*\nexec '([^'\n]+)\/bin\/j3-bots' "\$@"\n$/;

/**
 * The install folder of `installation`: the folder whose `versions/` holds
 * it. `None` for a checkout, and for a release unpacked anywhere else.
 */
export const installFolder = Effect.fn("install.installFolder")(function* (
  installation: Installation,
) {
  const path = yield* Path.Path;
  const { layout } = installation;
  if (layout._tag !== "release") return Option.none<string>();
  const versions = path.dirname(layout.root);
  return path.basename(versions) === VERSIONS
    ? Option.some(path.dirname(versions))
    : Option.none<string>();
});

/** The real path of `location`, or `location` itself where it does not resolve. */
const resolved = Effect.fnUntraced(function* (location: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(location).pipe(Effect.orElseSucceed(() => location));
});

/**
 * Whether `file` is a command install.sh wrote for the install at `install`:
 * a plain file, not a link, that runs a version in its `versions/`.
 */
export const isOwnLauncher = Effect.fn("install.isOwnLauncher")(function* (
  file: string,
  install: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return false;
  const text = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(text)) return false;
  const release = LAUNCHER.exec(text.value)?.[1];
  if (release === undefined || !path.isAbsolute(release)) return false;
  const version = path.basename(release);
  if (version === "" || version === "." || version === "..") return false;
  return (
    (yield* resolved(path.dirname(release))) === (yield* resolved(path.join(install, VERSIONS)))
  );
});

/** The command the install at `install` recorded, if it recorded one. */
export const recordedLauncher = Effect.fn("install.recordedLauncher")(function* (install: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(install, LAUNCHER_RECORD)).pipe(Effect.option);
  return Option.flatMap(text, (recorded) => {
    const launcher = recorded.trim();
    return path.isAbsolute(launcher) ? Option.some(launcher) : Option.none();
  });
});
