// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import type { Installation } from "../installation.ts";
import { socketOwner } from "../service/owner.ts";
import * as Unit from "../service/unit.ts";
import { Systemd } from "../system/Systemd.ts";
import {
  installedVersions,
  installFolder,
  isOwnLauncher,
  LAUNCHER_RECORD,
  recordedLauncher,
  VERSIONS,
} from "./layout.ts";

// `j3-bots uninstall`: undoes `scripts/install.sh`. It stops and removes the
// service, then removes the j3-bots command and what install.sh put in the
// install folder, and with `deleteData` J3 Bots' entries in the data
// directory. It removes nothing it did not write. Refusals come first and
// change nothing.

/** Why nothing was removed. */
class UninstallRefused extends Schema.TaggedError<UninstallRefused>()("UninstallRefused", {
  reason: Schema.Literals(["checkout", "unpacked", "no-systemd", "server-outside"]),
  /** The folder the refusal is about: the release, the data directory. */
  subject: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "checkout":
        return "This j3-bots runs from a checkout, which install.sh did not install, so there is nothing for it to remove. `j3-bots service uninstall` removes the service; the checkout and the data directory are yours to delete.";
      case "unpacked":
        return `This release in ${this.subject} was not installed by install.sh, so there is nothing for it to remove. \`j3-bots service uninstall\` removes the service; the release and the data directory are yours to delete.`;
      case "no-systemd":
        return "The service is installed, but there is no systemd user manager to stop it with. Log in to a systemd session as this user (not with sudo), then run this again. Nothing was removed.";
      case "server-outside":
        return `A J3 Bots server outside the service is running for ${this.subject}. Stop it, then run this again. Nothing was removed.`;
    }
  }
}

/** What an uninstall would remove, found before anything is. */
export interface UninstallPlan {
  /** The install folder: what install.sh put in `versions/`, and the record of the command. */
  readonly install: string;
  /** The service's unit, when it is installed. */
  readonly unitFile: Option.Option<string>;
  /** The data directory: the one the service runs with, else this shell's. */
  readonly home: string;
}

/** What `installation`, the copy that runs, would remove. */
export const plan = Effect.fn("install.plan")(function* (installation: Installation) {
  const fs = yield* FileSystem.FileSystem;
  const systemd = yield* Systemd;
  const install = yield* installFolder(installation);
  if (Option.isNone(install)) {
    const { layout } = installation;
    return yield* layout._tag === "release"
      ? new UninstallRefused({ reason: "unpacked", subject: layout.root })
      : new UninstallRefused({ reason: "checkout", subject: "" });
  }
  const unitFile = yield* Unit.unitPath;
  if (!(yield* fs.exists(unitFile))) {
    return {
      install: install.value,
      unitFile: Option.none(),
      home: yield* ServerConfig.resolveHome,
    } satisfies UninstallPlan;
  }
  if (!(yield* systemd.available)) {
    return yield* new UninstallRefused({ reason: "no-systemd", subject: "" });
  }
  const home = yield* Unit.installedHome(unitFile);
  return {
    install: install.value,
    unitFile: Option.some(unitFile),
    home: Option.isSome(home) ? home.value : yield* ServerConfig.resolveHome,
  } satisfies UninstallPlan;
});

/** What an uninstall removed. */
interface Uninstalled {
  readonly serviceRemoved: boolean;
  /** The recorded command, and whether it was removed: one install.sh did not write is kept. */
  readonly launcher: Option.Option<{ readonly path: string; readonly removed: boolean }>;
  /** Whether the install folder is gone: it is kept when it holds something else. */
  readonly installRemoved: boolean;
  /** What became of the data directory, when its deletion was asked for. */
  readonly data: Option.Option<DataDeletion>;
}

/**
 * The data directory after J3 Bots' entries in it were deleted: `deleted`
 * with them; `kept`, holding other files; `link-kept`, a link whose folder
 * had them, both kept; `absent`, there was none.
 */
export type DataDeletion = "deleted" | "kept" | "link-kept" | "absent";

/** Removes `folder` if it is a folder that holds nothing, and says whether it did. */
const removeIfEmpty = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const left = yield* fs.readDirectory(folder).pipe(Effect.option);
  if (Option.isNone(left) || left.value.length > 0) return false;
  // Empty, as checked: `recursive` is what lets `rm` take a folder at all.
  yield* fs.remove(folder, { recursive: true });
  return true;
});

/** Deletes J3 Bots' entries in the data directory `home`, and `home` if that empties it. */
const deleteOwnData = Effect.fnUntraced(function* (
  home: string,
): Effect.fn.Return<DataDeletion, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(home).pipe(Effect.option);
  if (Option.isNone(info)) return "absent";
  for (const entry of Object.values(HOME_ENTRIES)) {
    // A link among them goes, not what it points to.
    yield* fs.remove(path.join(home, entry), { recursive: true, force: true });
  }
  if (info.value.type === "SymbolicLink") return "link-kept";
  return (yield* removeIfEmpty(home)) ? "deleted" : "kept";
});

/** Removes what `plan` found, and with `deleteData` J3 Bots' data. */
export const uninstall = Effect.fn("install.uninstall")(function* (
  found: UninstallPlan,
  options: { readonly deleteData: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const systemd = yield* Systemd;

  if (options.deleteData) {
    // The service's own server stops with it; another one would keep writing.
    const { owner } = yield* socketOwner(path.join(found.home, HOME_ENTRIES.adminSocket));
    if (owner === "other" || owner === "unknown") {
      return yield* new UninstallRefused({ reason: "server-outside", subject: found.home });
    }
  }

  if (Option.isSome(found.unitFile)) {
    yield* systemd.disableAndStop(Unit.UNIT_NAME);
    yield* fs.remove(found.unitFile.value);
    yield* systemd.reload;
  }

  const recorded = yield* recordedLauncher(found.install);
  let launcher: Uninstalled["launcher"] = Option.none();
  if (Option.isSome(recorded)) {
    const removed = yield* isOwnLauncher(recorded.value, found.install);
    if (removed) yield* fs.remove(recorded.value);
    launcher = Option.some({ path: recorded.value, removed });
  }

  for (const version of yield* installedVersions(found.install)) {
    yield* fs.remove(version, { recursive: true });
  }
  yield* removeIfEmpty(path.join(found.install, VERSIONS));
  // Last: without it, the folder is no longer an install.
  yield* fs.remove(path.join(found.install, LAUNCHER_RECORD), { force: true });
  const installRemoved = yield* removeIfEmpty(found.install);

  const data = options.deleteData
    ? Option.some(yield* deleteOwnData(found.home))
    : Option.none<DataDeletion>();

  return {
    serviceRemoved: Option.isSome(found.unitFile),
    launcher,
    installRemoved,
    data,
  } satisfies Uninstalled;
});
