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
    reason: Schema.Literals([
      "not-owned",
      "writable-by-all",
      "writable-by-group",
      "too-many-links",
      "unverifiable",
    ]),
    /**
     * The install's own folder whose way passes through `folder`, when
     * `folder` is one a lookup of it looks in: an account that may change
     * `folder` could move what is on the way away and put its own there.
     */
    onWayTo: Schema.optionalKey(Schema.String),
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
    const to = this.onWayTo;
    if (to !== undefined) {
      const risk = "which could move what is on the way away and put its own in its place";
      switch (this.reason) {
        case "not-owned":
          return `${this.folder}, a folder on the way to ${to}, belongs to another account, ${risk}. Nothing was changed.`;
        case "writable-by-all":
          return `${this.folder}, a folder on the way to ${to}, can be written by every account, ${risk}. Take that away with \`chmod o-w ${this.folder}\`, then run this again. Nothing was changed.`;
        case "writable-by-group":
          return `${this.folder}, a folder on the way to ${to}, can be written by its group, which is not this user's own, ${risk}. Take that away with \`chmod g-w ${this.folder}\`, then run this again. Nothing was changed.`;
        case "too-many-links":
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
      case "too-many-links":
        return `The way to ${this.folder} goes through more links than a lookup follows. Nothing was changed.`;
      case "unverifiable":
        return `Windows did not say who may change ${this.folder} (${this.detail ?? "no answer"}), so what runs from it cannot be trusted. Check that Windows PowerShell runs, then run this again. Nothing was changed.`;
    }
  }
}

/** As many links as a lookup follows, as Linux's does at most. */
const MAX_LINKS = 40;

/**
 * Fails unless `folder` is this user's and no other account may write to it,
 * as install.sh checks the install folder, its `versions/` and the command's
 * folder: what is in them runs as this user. Its group may write when that is
 * this user's own group, as under umask 002.
 *
 * Every folder the way to it passes through, up from the root, must be this
 * user's or root's and written by no other account, unless it is sticky, as
 * /tmp is: an account that may write to one could move what it holds away
 * and put a folder or a link of its own there. The way is walked as a lookup
 * makes it, so a link on it is checked where it is and where it leads. On
 * Windows, where a mode means nothing, the folder's access list is judged
 * instead, and the folders on the way are not.
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
  const onWay = Effect.fnUntraced(function* (looked: string) {
    const parent = yield* fs.stat(looked);
    const exposed = (reason: "not-owned" | "writable-by-all" | "writable-by-group") =>
      new InstallFolderExposed({ folder: looked, reason, onWayTo: folder });
    if (uid !== undefined && !Option.contains(parent.uid, uid) && !Option.contains(parent.uid, 0)) {
      return yield* exposed("not-owned");
    }
    // Sticky: only the owner of what is in it may move that.
    if ((parent.mode & 0o1000) !== 0) return;
    if ((parent.mode & 0o002) !== 0) return yield* exposed("writable-by-all");
    if ((parent.mode & 0o020) !== 0 && gid !== undefined && !Option.contains(parent.gid, gid)) {
      return yield* exposed("writable-by-group");
    }
  });
  // Name by name from the root, as a lookup makes the way: `at` is a folder
  // with no link in its path, a link's target goes before what is left, and
  // `..` leaves the folder reached, not the name before it, which resolving
  // the path first would drop along with a link.
  const checked = new Set<string>();
  const full = path.isAbsolute(folder) ? folder : `${process.cwd()}${path.sep}${folder}`;
  let rest = full.split(path.sep);
  let at = path.parse(full).root;
  let links = 0;
  while (rest.length > 0) {
    const [name = "", ...after] = rest;
    rest = after;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      at = path.dirname(at);
      continue;
    }
    if (!checked.has(at)) {
      yield* onWay(at);
      checked.add(at);
    }
    const next = path.join(at, name);
    if ((yield* fs.lstat(next)).type === "SymbolicLink") {
      links += 1;
      if (links > MAX_LINKS) {
        return yield* new InstallFolderExposed({ folder, reason: "too-many-links" });
      }
      const target = yield* fs.readLink(next);
      if (path.isAbsolute(target)) at = path.parse(target).root;
      rest = [...target.split(path.sep), ...rest];
    } else {
      at = next;
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
