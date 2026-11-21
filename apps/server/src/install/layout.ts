// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import { type Installation, RELEASE_MANIFEST } from "../installation.ts";

// Where `scripts/install.sh` puts J3 Bots on a host, outside the data
// directory (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
//
//   <install>/versions/<version>/   one unpacked release archive each
//   <install>/versions/.staging-*   where one is unpacked before it is moved into place
//   <install>/launcher              the path of the j3-bots command, one line;
//                                   a folder is an install only when it has one
//   <bin>/j3-bots                   the command, `launcherText` of one version
//
// `<install>` is `$XDG_DATA_HOME/j3-bots`, `~/.local/share/j3-bots` or
// `J3_INSTALL_DIR`, and `<bin>` is `~/.local/bin` or `J3_BIN_DIR`.

/** The folder of `<install>` that holds the releases, one folder per version. */
export const VERSIONS = "versions";

/** The file in `<install>` that names the j3-bots command install.sh wrote. */
export const LAUNCHER_RECORD = "launcher";

/** A folder install.sh unpacks a release into, in `versions/`: `mktemp -d .staging-XXXXXX`. */
const STAGING = /^\.staging-[A-Za-z0-9]{6}$/;

/**
 * The whole text of the command install.sh writes to run the release at
 * `release`, and `j3-bots update` after it: only a command that is exactly
 * this is the install's.
 */
const launcherText = (release: string) =>
  `#!/bin/sh\n# J3 Bots, installed by install.sh. \`j3-bots uninstall\` removes it.\nexec '${release}/bin/j3-bots' "$@"\n`;

/** The release a command written by `launcherText` runs. */
const LAUNCHED_RELEASE = /\nexec '([^'\n]+)\/bin\/j3-bots' "\$@"\n$/;

/**
 * The install folder of `installation`: the folder whose `versions/` holds
 * it, when install.sh recorded its command there. `None` for a checkout, and
 * for a release unpacked anywhere else.
 */
export const installFolder = Effect.fn("install.installFolder")(function* (
  installation: Installation,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { layout } = installation;
  if (layout._tag !== "release") return Option.none<string>();
  const versions = path.dirname(layout.root);
  if (path.basename(versions) !== VERSIONS) return Option.none<string>();
  const install = path.dirname(versions);
  const record = yield* fs.lstat(path.join(install, LAUNCHER_RECORD)).pipe(Effect.option);
  return Option.isSome(record) && record.value.type === "File"
    ? Option.some(install)
    : Option.none<string>();
});

/** The real path of `location`, or `location` itself where it does not resolve. */
const resolved = Effect.fnUntraced(function* (location: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(location).pipe(Effect.orElseSucceed(() => location));
});

/**
 * Whether `file` is a command install.sh wrote for the install at `install`:
 * a plain file, not a link, whose text is exactly `launcherText` of a version
 * in its `versions/`.
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
  const release = LAUNCHED_RELEASE.exec(text.value)?.[1];
  if (release === undefined || text.value !== launcherText(release)) return false;
  if (!path.isAbsolute(release)) return false;
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

/**
 * Whether a service whose `ExecStart=` is `command` runs the install at
 * `install`: its executable is the command install.sh recorded there, or its
 * executable or entry point is in a release in the install's `versions/`.
 * Anything else, such as a checkout's server, is another J3 Bots.
 */
export const startsInstall = Effect.fn("install.startsInstall")(function* (
  command: ReadonlyArray<string>,
  install: string,
) {
  const path = yield* Path.Path;
  const recorded = yield* recordedLauncher(install);
  const launcher = Option.isSome(recorded) ? yield* resolved(recorded.value) : undefined;
  const versions = yield* resolved(path.join(install, VERSIONS));
  for (const [index, word] of command.slice(0, 2).entries()) {
    if (!path.isAbsolute(word)) continue;
    const real = yield* resolved(word);
    if ((index === 0 && real === launcher) || real.startsWith(`${versions}/`)) return true;
  }
  return false;
});

/**
 * What install.sh put in `versions/` of the install at `install`: each folder
 * that holds a release (a `release.json`), and each staging folder an
 * interrupted run left. Anything else there is not its own.
 */
export const installedVersions = Effect.fn("install.installedVersions")(function* (
  install: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions = path.join(install, VERSIONS);
  const names = yield* fs.readDirectory(versions).pipe(Effect.orElseSucceed(() => []));
  const own: Array<string> = [];
  for (const name of names) {
    const entry = path.join(versions, name);
    const info = yield* fs.lstat(entry).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    if (STAGING.test(name) || (yield* fs.exists(path.join(entry, RELEASE_MANIFEST)))) {
      own.push(entry);
    }
  }
  return own;
});

/** A folder of the install that another account could change what runs from. */
class InstallFolderExposed extends Schema.TaggedError<InstallFolderExposed>()(
  "InstallFolderExposed",
  { folder: Schema.String, reason: Schema.Literals(["not-owned", "writable-by-all"]) },
) {
  override get message(): string {
    return this.reason === "not-owned"
      ? `${this.folder} belongs to another account, which could change what runs from it. Nothing was changed.`
      : `${this.folder} can be written by every account, which could change what runs from it. Take that away with \`chmod o-w ${this.folder}\`, then run this again. Nothing was changed.`;
  }
}

/**
 * Fails unless `folder` is this user's and not writable by every account, as
 * install.sh checks the install folder, its `versions/` and the command's
 * folder: what is in them runs as this user. Its group may write.
 */
export const checkOwnFolder = Effect.fn("install.checkOwnFolder")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(folder);
  const uid = process.getuid?.();
  if (uid !== undefined && !Option.contains(info.uid, uid)) {
    return yield* new InstallFolderExposed({ folder, reason: "not-owned" });
  }
  if ((info.mode & 0o002) !== 0) {
    return yield* new InstallFolderExposed({ folder, reason: "writable-by-all" });
  }
});

/**
 * Replaces `file` with `text` and gives it `mode`, whole: written to a new
 * file of a random name beside it, then renamed over it.
 */
const replaceWithMode = Effect.fnUntraced(function* (file: string, text: string, mode: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${Hex.encode(yield* random.randomBytes(6))}`,
  );
  yield* fs.writeFileString(temporary, text, { flag: "wx", mode }).pipe(
    // The mode the file is created with passes through the umask.
    Effect.andThen(fs.chmod(temporary, mode)),
    Effect.andThen(fs.rename(temporary, file)),
    Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
  );
}, Effect.provide(SecureRandom.layerWebCrypto));

/**
 * Points the install's command, `launcher`, at the release in `release`, as
 * install.sh writes it: the record of where the command is first, so the
 * command never exists without it, then the command, each replaced whole.
 */
export const writeLauncher = Effect.fn("install.writeLauncher")(function* (options: {
  readonly install: string;
  readonly launcher: string;
  readonly release: string;
}) {
  const path = yield* Path.Path;
  yield* checkOwnFolder(options.install);
  yield* checkOwnFolder(path.dirname(options.launcher));
  yield* replaceWithMode(
    path.join(options.install, LAUNCHER_RECORD),
    `${options.launcher}\n`,
    0o644,
  );
  yield* replaceWithMode(options.launcher, launcherText(options.release), 0o755);
});
