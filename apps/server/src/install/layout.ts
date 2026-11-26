// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import { judgeWriteAcl, readFolderAcl, repairCommand } from "../home/windowsAcl.ts";
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

/** The release folder the command at `file` runs, when install.sh or an update wrote it. */
export const launchedRelease = Effect.fn("install.launchedRelease")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.option);
  return Option.flatMap(text, (launcher) => {
    const release = LAUNCHED_RELEASE.exec(launcher)?.[1];
    return release !== undefined && launcher === launcherText(release)
      ? Option.some(release)
      : Option.none();
  });
});

/**
 * The release folder in the install's `versions/` that a service whose
 * `ExecStart=` is `command` runs: the one its Node or its server bundle is
 * in. `None` when neither is in a release there, as for a unit that starts
 * the command install.sh recorded.
 */
export const startedRelease = Effect.fn("install.startedRelease")(function* (
  command: ReadonlyArray<string>,
  install: string,
) {
  const path = yield* Path.Path;
  const versions = yield* resolved(path.join(install, VERSIONS));
  for (const word of command.slice(0, 2)) {
    if (!path.isAbsolute(word)) continue;
    const real = yield* resolved(word);
    if (!real.startsWith(`${versions}/`)) continue;
    const version = real.slice(versions.length + 1).split("/")[0];
    if (version !== undefined && version !== "") {
      return Option.some(path.join(install, VERSIONS, version));
    }
  }
  return Option.none<string>();
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
  {
    folder: Schema.String,
    reason: Schema.Literals(["not-owned", "writable-by-all", "writable-by-group", "unverifiable"]),
    /**
     * The install's own folder that `folder` holds, when `folder` is one above
     * it: an account that may change `folder` could move it away.
     */
    holds: Schema.optionalKey(Schema.String),
    /**
     * On Windows, the `icacls` command that leaves the folder to this user,
     * SYSTEM and the Administrators: a mode does not say who may write there.
     */
    windowsRepair: Schema.optionalKey(Schema.String),
    /** For `unverifiable`, what Windows said instead of who may change the folder. */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const holds = this.holds;
    if (holds !== undefined) {
      const risk = `which could move ${holds} away and put a folder of its own in its place`;
      switch (this.reason) {
        case "not-owned":
          return `${this.folder}, a folder ${holds} is in, belongs to another account, ${risk}. Nothing was changed.`;
        case "writable-by-all":
          return `${this.folder}, a folder ${holds} is in, can be written by every account, ${risk}. Take that away with \`chmod o-w ${this.folder}\`, then run this again. Nothing was changed.`;
        case "writable-by-group":
          return `${this.folder}, a folder ${holds} is in, can be written by its group, which is not this user's own, ${risk}. Take that away with \`chmod g-w ${this.folder}\`, then run this again. Nothing was changed.`;
        case "unverifiable":
          break;
      }
    }
    switch (this.reason) {
      case "not-owned":
        return `${this.folder} belongs to another account, which could change what runs from it. Nothing was changed.`;
      case "writable-by-all":
        return this.windowsRepair === undefined
          ? `${this.folder} can be written by every account, which could change what runs from it. Take that away with \`chmod o-w ${this.folder}\`, then run this again. Nothing was changed.`
          : `${this.folder} can be written by other accounts, which could change what runs from it. In PowerShell, run \`${this.windowsRepair}\`, then run this again. Nothing was changed.`;
      case "writable-by-group":
        return `${this.folder} can be written by its group, which is not this user's own, so other accounts could change what runs from it. Take that away with \`chmod g-w ${this.folder}\`, then run this again. Nothing was changed.`;
      case "unverifiable":
        return `Windows did not say who may change ${this.folder} (${this.detail ?? "no answer"}), so what runs from it cannot be trusted. Check that Windows PowerShell runs, then run this again. Nothing was changed.`;
    }
  }
}

/**
 * Fails unless `folder` is this user's and no other account may write to it,
 * as install.sh checks the install folder, its `versions/` and the command's
 * folder: what is in them runs as this user. Its group may write when that is
 * this user's own group, as under umask 002.
 *
 * Every folder above it, up to the root, on the path as given and on the one
 * its links lead to, must be this user's or root's and written by no other
 * account, unless it is sticky, as /tmp is: an account that may write to one
 * could move `folder` away and put its own in its place. On Windows, where a
 * mode means nothing, the folder's access list is judged instead, and the
 * folders above it are not.
 */
export const checkOwnFolder = Effect.fn("install.checkOwnFolder")(function* (folder: string) {
  if (process.platform === "win32") return yield* checkOwnFolderOnWindows(folder);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const info = yield* fs.stat(folder);
  if (uid !== undefined && !Option.contains(info.uid, uid)) {
    return yield* new InstallFolderExposed({ folder, reason: "not-owned" });
  }
  if ((info.mode & 0o002) !== 0) {
    return yield* new InstallFolderExposed({ folder, reason: "writable-by-all" });
  }
  if ((info.mode & 0o020) !== 0 && gid !== undefined && !Option.contains(info.gid, gid)) {
    return yield* new InstallFolderExposed({ folder, reason: "writable-by-group" });
  }
  const resolved = yield* fs.realPath(folder);
  for (const start of new Set([folder, resolved])) {
    for (let below = start, above = path.dirname(start); above !== below;) {
      const parent = yield* fs.stat(above);
      if (
        uid !== undefined &&
        !Option.contains(parent.uid, uid) &&
        !Option.contains(parent.uid, 0)
      ) {
        return yield* new InstallFolderExposed({
          folder: above,
          reason: "not-owned",
          holds: folder,
        });
      }
      // Sticky: only the owner of a folder in it may move that folder.
      if ((parent.mode & 0o1000) === 0) {
        if ((parent.mode & 0o002) !== 0) {
          return yield* new InstallFolderExposed({
            folder: above,
            reason: "writable-by-all",
            holds: folder,
          });
        }
        if ((parent.mode & 0o020) !== 0 && gid !== undefined && !Option.contains(parent.gid, gid)) {
          return yield* new InstallFolderExposed({
            folder: above,
            reason: "writable-by-group",
            holds: folder,
          });
        }
      }
      below = above;
      above = path.dirname(above);
    }
  }
});

const checkOwnFolderOnWindows = Effect.fnUntraced(function* (folder: string) {
  const acl = yield* readFolderAcl(folder).pipe(
    Effect.mapError(
      (error) => new InstallFolderExposed({ folder, reason: "unverifiable", detail: error.detail }),
    ),
  );
  switch (judgeWriteAcl(acl)) {
    case "own":
      return;
    case "not-owned":
      return yield* new InstallFolderExposed({ folder, reason: "not-owned" });
    case "writable-by-others":
      return yield* new InstallFolderExposed({
        folder,
        reason: "writable-by-all",
        windowsRepair: repairCommand(folder, acl),
      });
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
