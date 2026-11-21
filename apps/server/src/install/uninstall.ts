// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { HOME_ENTRIES, homeLayout } from "../home/entries.ts";
import { holdLock } from "../home/Home.ts";
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
  startsInstall,
  VERSIONS,
} from "./layout.ts";
import { UPDATE_LOCK } from "./snapshot.ts";

// `j3-bots uninstall`: undoes `scripts/install.sh`. It stops and removes the
// service when the service runs this install, then removes the j3-bots command
// and what install.sh put in the install folder, and with `deleteData` what
// the server wrote in the data directory. It removes nothing it did not write.
// Refusals come first and change nothing. It holds the home's update lock
// throughout, so it never runs while an update or a rollback does.

/** Why nothing was removed. */
class UninstallRefused extends Schema.TaggedError<UninstallRefused>()("UninstallRefused", {
  reason: Schema.Literals(["checkout", "unpacked", "no-systemd", "server-running", "busy"]),
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
      case "server-running":
        return `A J3 Bots server that this uninstall does not stop is running for ${this.subject}. Stop it, then run this again. Nothing was removed.`;
      case "busy":
        return `\`j3-bots update\` or \`j3-bots update --rollback\` is running for ${this.subject}. Wait for it to end, then run this again. Nothing was removed.`;
    }
  }
}

/** What an uninstall would remove, found before anything is. */
export interface UninstallPlan {
  /** The install folder: what install.sh put in `versions/`, and the record of the command. */
  readonly install: string;
  /**
   * The service's unit, when one is installed: `own` when it runs this
   * install, which removes it; otherwise it runs another J3 Bots, and is kept.
   */
  readonly service: Option.Option<{ readonly unitFile: string; readonly own: boolean }>;
  /** The data directory: the one this install's service runs with, else this shell's. */
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
      service: Option.none(),
      home: yield* ServerConfig.resolveHome,
    } satisfies UninstallPlan;
  }
  const unit = yield* fs.readFileString(unitFile);
  if (!(yield* startsInstall(Unit.execStartOf(unit), install.value))) {
    return {
      install: install.value,
      service: Option.some({ unitFile, own: false }),
      home: yield* ServerConfig.resolveHome,
    } satisfies UninstallPlan;
  }
  if (!(yield* systemd.available)) {
    return yield* new UninstallRefused({ reason: "no-systemd", subject: "" });
  }
  const home = Unit.environmentOf(unit).get("J3_HOME");
  return {
    install: install.value,
    service: Option.some({ unitFile, own: true }),
    home: home ?? (yield* ServerConfig.resolveHome),
  } satisfies UninstallPlan;
});

/** What an uninstall removed. */
interface Uninstalled {
  readonly serviceRemoved: boolean;
  /**
   * The recorded command, and what became of it: `removed`; `kept`, as
   * install.sh did not write it; `missing`, there was none at the path.
   */
  readonly launcher: Option.Option<{
    readonly path: string;
    readonly state: "removed" | "kept" | "missing";
  }>;
  /** Whether the install folder is gone: it is kept when it holds something else. */
  readonly installRemoved: boolean;
  /** What became of the data directory, when its deletion was asked for. */
  readonly data: Option.Option<DataDeletion>;
}

/**
 * The data directory after what the server wrote in it was deleted:
 * `deleted` with it; `web-kept`, holding the operator's web client in `web`;
 * `kept`, holding other files; `link-kept`, a link whose folder had them,
 * both kept; `not-j3`, no server ever took it, so nothing in it was deleted;
 * `absent`, there was none.
 */
export type DataDeletion = "deleted" | "web-kept" | "kept" | "link-kept" | "not-j3" | "absent";

/** Removes `folder` if it is a folder that holds nothing, and says whether it did. */
const removeIfEmpty = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const left = yield* fs.readDirectory(folder).pipe(Effect.option);
  if (Option.isNone(left) || left.value.length > 0) return false;
  // Empty, as checked: `recursive` is what lets `rm` take a folder at all.
  yield* fs.remove(folder, { recursive: true });
  return true;
});

/** Whether a server took `home`: it holds the server's lock or its database. */
const serverTook = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (
    (yield* fs.exists(path.join(home, HOME_ENTRIES.lock))) ||
    (yield* fs.exists(path.join(home, HOME_ENTRIES.database)))
  );
});

/**
 * Holds `<home>/backups/update.lock`, the lock an update or a rollback holds
 * from start to end, for the scope, or fails while one holds it. A home no
 * server took has nothing for an update to copy, and is left as it is.
 */
const holdUpdates = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* serverTook(home))) return;
  const backups = path.join(home, HOME_ENTRIES.backups);
  yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
  yield* holdLock(
    path.join(backups, UPDATE_LOCK),
    () => new UninstallRefused({ reason: "busy", subject: home }),
  );
});

/**
 * Deletes what the server writes in the data directory `home`, and `home` if
 * that empties it. Only from a folder a server took: one with its lock or its
 * database.
 */
const deleteOwnData = Effect.fnUntraced(function* (
  home: string,
): Effect.fn.Return<DataDeletion, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(home).pipe(Effect.option);
  if (Option.isNone(info)) return "absent";
  if (!(yield* serverTook(home))) return "not-j3";
  for (const entry of homeLayout(path, home).written([])) {
    // A link among them goes, not what it points to.
    yield* fs.remove(entry, { recursive: true, force: true });
  }
  if (info.value.type === "SymbolicLink") return "link-kept";
  if (yield* removeIfEmpty(home)) return "deleted";
  return (yield* fs.exists(path.join(home, HOME_ENTRIES.web))) ? "web-kept" : "kept";
});

/** Removes what `plan` found, and with `deleteData` J3 Bots' data. */
export const uninstall = Effect.fn("install.uninstall")(function* (
  found: UninstallPlan,
  options: { readonly deleteData: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const systemd = yield* Systemd;
  yield* holdUpdates(found.home);

  // The unit to stop and remove: only one that runs this install.
  const ownUnit = Option.flatMap(found.service, ({ unitFile, own }) =>
    own ? Option.some(unitFile) : Option.none(),
  );

  if (options.deleteData) {
    // This install's service stops with it; any other server would keep writing.
    const { owner } = yield* socketOwner(path.join(found.home, HOME_ENTRIES.adminSocket));
    if (owner !== "nobody" && !(owner === "service" && Option.isSome(ownUnit))) {
      return yield* new UninstallRefused({ reason: "server-running", subject: found.home });
    }
  }

  if (Option.isSome(ownUnit)) {
    yield* systemd.disableAndStop(Unit.UNIT_NAME);
    yield* fs.remove(ownUnit.value);
    yield* systemd.reload;
  }

  const recorded = yield* recordedLauncher(found.install);
  let launcher: Uninstalled["launcher"] = Option.none();
  if (Option.isSome(recorded)) {
    const state = Option.isNone(yield* fs.lstat(recorded.value).pipe(Effect.option))
      ? "missing"
      : (yield* isOwnLauncher(recorded.value, found.install))
        ? "removed"
        : "kept";
    if (state === "removed") yield* fs.remove(recorded.value);
    launcher = Option.some({ path: recorded.value, state });
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
    serviceRemoved: Option.isSome(ownUnit),
    launcher,
    installRemoved,
    data,
  } satisfies Uninstalled;
}, Effect.scoped);
