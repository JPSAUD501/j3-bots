// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The reservation is an SQLite lock, which only node:sqlite takes.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };
import * as Socket from "../admin/socket.ts";
import { DEFAULTS_TEXT, load, ServerConfig } from "../config.ts";
import { publishFile } from "../files.ts";
import { unfinishedRollback } from "../install/snapshot.ts";
import { HOME_ENTRIES } from "./entries.ts";
import {
  type AclVerdict,
  createPrivateFolder,
  judgeAcl,
  powerShellWord,
  readFolderAcl,
  repairCommand,
} from "./windowsAcl.ts";

// The home holds the database, the bots' files, the engine's credential and
// the admin socket, which takes no token because only the operator's user can
// reach it. So the home must be the operator's alone, and one server at a
// time may use it.

/** A path as one shell word. */
export const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** The home is not a folder only this user can open. */
export class HomeNotPrivate extends Schema.TaggedError<HomeNotPrivate>()("HomeNotPrivate", {
  home: Schema.String,
  reason: Schema.Literals([
    "not-a-folder",
    "not-owned",
    "open-to-others",
    "closed-to-owner",
    "unverifiable",
    "unreadable",
  ]),
  /**
   * On Windows, the `icacls` command, for PowerShell, that makes the home
   * private, which names the accounts to remove: a mode does not say who may
   * open a folder there.
   */
  windowsRepair: Schema.optionalKey(Schema.String),
  /**
   * For `unverifiable`, what Windows said instead of who may open the home;
   * for `unreadable`, what the system said instead of what the home is.
   */
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-folder":
        return `${this.home} is not a folder. Move it away, or set J3_HOME to another folder.`;
      case "not-owned":
        return `${this.home} belongs to another user, so this user cannot keep it private. ${this.fix}`;
      case "open-to-others":
        return `Other users on this machine can open ${this.home}, which holds the database, the engine's credential and the admin socket. ${this.fix}`;
      case "closed-to-owner":
        return `This user's own permissions on ${this.home} do not let it read, write and open the files there. ${this.fix}`;
      case "unverifiable":
        return `Windows did not say who may open ${this.home} (${this.detail ?? "no answer"}), so the server cannot tell that it is private. ${this.fix}`;
      case "unreadable":
        return `The system did not let this user look at ${this.home} (${this.detail ?? "no answer"}), so the server cannot tell that it is private. ${this.fix}`;
    }
  }

  /** The command that repairs it, for the operator to run on this system. */
  get fix(): string {
    if (this.reason === "unreadable") {
      return `Check that ${this.home} and every folder it is in are folders this user can open.`;
    }
    if (process.platform === "win32") {
      const repair = this.windowsRepair ?? `icacls ${powerShellWord(this.home)} /inheritance:r`;
      const takeOwnership = `takeown /F ${powerShellWord(this.home)} /R`;
      switch (this.reason) {
        case "not-a-folder":
          return "Set J3_HOME to a folder.";
        case "not-owned":
          return `In PowerShell, take it as this user (\`${takeOwnership}\`), then run \`${repair}\`.`;
        case "open-to-others":
        case "closed-to-owner":
          return `In PowerShell, run \`${repair}\`.`;
        case "unverifiable":
          return `Check that Windows PowerShell runs for this user. If it runs and Windows denied this user access to the folder, the folder may belong to another user: in PowerShell, take it as this user (\`${takeOwnership}\`).`;
      }
    }
    switch (this.reason) {
      case "not-a-folder":
        return "Set J3_HOME to a folder.";
      case "not-owned":
        return `Give it to this user: \`sudo chown -R "$(id -un)": ${shellWord(this.home)} && chmod 700 ${shellWord(this.home)}\`.`;
      case "open-to-others":
      case "closed-to-owner":
      case "unverifiable":
        return `Run \`chmod 700 ${shellWord(this.home)}\`.`;
    }
  }
}

/**
 * Whether `home` is a folder owned by this user, which this user may read,
 * write and search and no group and no other user can open. A home that does
 * not exist yet passes: the server creates it private. One the system would
 * not show is refused (`unreadable`), never taken for missing. On Windows,
 * who may open it is its access list, which `windowsAcl.ts` reads and judges.
 */
export const checkPrivate = Effect.fn("Home.checkPrivate")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.mapError(
      (error) =>
        new HomeNotPrivate({
          home,
          reason: "unreadable",
          detail: Predicate.isError(error.cause) ? error.cause.message : error.message,
        }),
    ),
  );
  if (Option.isNone(info)) return;
  yield* checkPrivateInfo(home, info.value);
});

/** `checkPrivate` of what a stat of `home` found. */
const checkPrivateInfo = Effect.fn("Home.checkPrivateInfo")(function* (
  home: string,
  info: FileSystem.File.Info,
) {
  if (info.type !== "Directory") {
    return yield* new HomeNotPrivate({ home, reason: "not-a-folder" });
  }
  if (process.platform === "win32") return yield* checkPrivateOnWindows(home);
  const user = process.getuid?.();
  if (user !== undefined && Option.isSome(info.uid) && info.uid.value !== user) {
    return yield* new HomeNotPrivate({ home, reason: "not-owned" });
  }
  if ((info.mode & 0o077) !== 0) {
    return yield* new HomeNotPrivate({ home, reason: "open-to-others" });
  }
  if ((info.mode & 0o700) !== 0o700) {
    return yield* new HomeNotPrivate({ home, reason: "closed-to-owner" });
  }
});

/** Which folder a path named when it was looked at: its device and inode. */
export interface FolderIdentity {
  readonly dev: bigint;
  readonly ino: Option.Option<bigint>;
}

/**
 * Checks that the existing `home` is private, as `checkPrivate` does, and says
 * which folder that was, from the same look at it, so that `checkUnchanged`
 * can tell later whether the path still names that folder.
 */
export const identifyPrivate = Effect.fn("Home.identifyPrivate")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home);
  yield* checkPrivateInfo(home, info);
  return { dev: info.dev, ino: info.ino } satisfies FolderIdentity;
});

/**
 * Fails unless `home` still names the folder `identifyPrivate` found, and it
 * is still private: nothing moved, replaced or opened it since.
 */
export const checkUnchanged = Effect.fn("Home.checkUnchanged")(function* (
  home: string,
  before: FolderIdentity,
) {
  const now = yield* identifyPrivate(home);
  // Bigints compare by value.
  if (now.dev !== before.dev || Option.getOrNull(now.ino) !== Option.getOrNull(before.ino)) {
    return yield* new HomeBlocked({ path: home, reason: "home-replaced" });
  }
});

const checkPrivateOnWindows = Effect.fnUntraced(function* (home: string) {
  const acl = yield* readFolderAcl(home).pipe(
    Effect.mapError(
      (error) => new HomeNotPrivate({ home, reason: "unverifiable", detail: error.detail }),
    ),
  );
  const verdict: AclVerdict = judgeAcl(acl);
  if (verdict !== "private") {
    return yield* new HomeNotPrivate({
      home,
      reason: verdict,
      windowsRepair: repairCommand(home, acl),
    });
  }
});

/**
 * Creates `home`, and the folders it is in, if missing, private from its
 * first moment: on Windows with its access list in place
 * (`createPrivateFolder`), elsewhere mode 0700. Then checks it, as
 * `checkPrivate` checks an existing home: one another process made since the
 * server last looked is left as that process made it, and refused unless
 * private.
 */
const createHome = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Folders made for it are as closed as the home: one others could write in
  // would let them put another home in its place.
  yield* fs.makeDirectory(path.dirname(home), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    // A folder already there is left as it is.
    yield* createPrivateFolder(home).pipe(
      Effect.mapError(
        (error) => new HomeNotPrivate({ home, reason: "unverifiable", detail: error.detail }),
      ),
    );
  } else {
    const created = yield* fs.makeDirectory(home, { mode: 0o700 }).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );
    // The mode it was made with is masked by the process's umask.
    if (created) yield* fs.chmod(home, 0o700);
  }
  yield* checkPrivate(home);
});

/** The home exists, but this user cannot create files in it. */
class HomeNotWritable extends Schema.TaggedError<HomeNotWritable>()("HomeNotWritable", {
  home: Schema.String,
  reason: Schema.Literals(["read-only", "other"]),
  /** What the system reported, for a reason this module does not name. */
  detail: Schema.String,
}) {
  /** The problem, without the fix. */
  get summary(): string {
    switch (this.reason) {
      case "read-only":
        return `${this.home} is on a file system mounted read-only, so the server cannot keep its database there.`;
      case "other":
        return `The server cannot write to ${this.home}: ${this.detail}`;
    }
  }

  override get message(): string {
    return this.fix === undefined ? this.summary : `${this.summary} ${this.fix}`;
  }

  /** What repairs it, for the operator to do, when this module knows. */
  get fix(): string | undefined {
    switch (this.reason) {
      case "read-only":
        // A disk that reports errors is remounted read-only, as SD cards often are.
        return "Check the disk for errors, and the system journal (`journalctl -k`) for why it was mounted read-only.";
      case "other":
        return undefined;
    }
  }
}

/**
 * Why the system refused to let this user write to the home. `checkPrivate`
 * has already found it this user's own, with mode 0700, so a permission
 * refusal here comes from what chmod cannot change, such as an immutable flag,
 * a security module or a network file system: the system's message says which.
 */
const writeRefusal = (error: PlatformError.PlatformError): HomeNotWritable["reason"] => {
  const { cause } = error;
  return Predicate.hasProperty(cause, "code") && cause.code === "EROFS" ? "read-only" : "other";
};

/**
 * Whether this user can create files in `home`. A home that does not exist
 * yet passes, as in `checkPrivate`.
 */
export const checkWritable = Effect.fn("Home.checkWritable")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.access(home, { writable: true }).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new HomeNotWritable({
          home,
          reason: writeRefusal(error),
          detail: Predicate.isError(error.cause) ? error.cause.message : error.message,
        }),
      ),
    ),
  );
});

/** A rollback has not finished, so the home is not one this release may run on. */
class RollbackUnfinished extends Schema.TaggedError<RollbackUnfinished>()("RollbackUnfinished", {
  home: Schema.String,
  release: Schema.String,
  snapshot: Schema.String,
}) {
  override get message(): string {
    return `A rollback of ${this.home} to J3 Bots ${this.release}, from ${this.snapshot}, has not finished, so no server may start on it. Run \`j3-bots update --rollback\`, which finishes it.`;
  }
}

/**
 * Refuses `home` while a rollback has not finished: it holds the data of
 * another release, or part of a snapshot. Only the release the rollback ends
 * on may start, and only once the snapshot is back whole.
 */
const checkNoUnfinishedRollback = Effect.fn("Home.checkNoUnfinishedRollback")(function* (
  home: string,
) {
  const rollback = yield* unfinishedRollback(home);
  if (Option.isNone(rollback)) return;
  const { snapshot, mark } = rollback.value;
  if (mark.stage !== "restored" || mark.release !== packageJson.version) {
    return yield* new RollbackUnfinished({
      home,
      release: mark.release,
      snapshot: snapshot.folder,
    });
  }
});

/**
 * The configuration for a server about to start, with its home ready. Nothing
 * is written until all pass their checks: the configuration, as `load`
 * checks it (where the home is included), the home's privacy and
 * writability, and that no rollback of it has been left unfinished, whose
 * `config.json` may be the one moved aside. Then the home is created,
 * readable by the operator only, and on first run, with no `config.json`
 * yet, one is published whole with every setting at its default. An existing
 * file is never rewritten, and a start that finds one writes nothing there.
 */
export const initialize = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* load;
  yield* checkPrivate(config.home);
  yield* checkWritable(config.home);
  yield* checkNoUnfinishedRollback(config.home);
  yield* createHome(config.home);
  if (!(yield* fs.exists(config.configFile))) {
    // Two first starts may both get here: the publication keeps the first file.
    yield* publishFile(config.configFile, DEFAULTS_TEXT, 0o600);
  }
  return config;
});

/** The configuration for a server about to start: `initialize`, as a layer. */
export const configLayer = Layer.effect(ServerConfig, initialize);

/** Another server, or an update copying or putting back its files, already holds this home. */
class ServerAlreadyRunning extends Schema.TaggedError<ServerAlreadyRunning>()(
  "ServerAlreadyRunning",
  { home: Schema.String },
) {
  override get message(): string {
    return `A J3 Bots server, or \`j3-bots update\` copying its databases, already holds ${this.home}. Stop that server, or wait for the update to end, before starting another.`;
  }
}

/** Something in the home is in the way of the reservation or the admin socket, or the home changed under it. */
class HomeBlocked extends Schema.TaggedError<HomeBlocked>()("HomeBlocked", {
  path: Schema.String,
  reason: Schema.Literals(["lock-unusable", "not-a-socket", "home-replaced"]),
}) {
  override get message(): string {
    return `${this.summary} ${this.fix}`;
  }

  /** What is in the way. */
  get summary(): string {
    switch (this.reason) {
      case "lock-unusable":
        return `${this.path}, which keeps a second server off this home, cannot be opened.`;
      case "not-a-socket":
        return `${this.path} is where the admin socket goes, but something else is there.`;
      case "home-replaced":
        return `${this.path} is no longer the folder the server checked before it created the admin socket there: something moved or replaced it in the meantime.`;
    }
  }

  /** How to clear it, for the operator to do. */
  get fix(): string {
    switch (this.reason) {
      case "lock-unusable":
        return "Check that this user can write to the folder that holds it.";
      case "not-a-socket":
        return `Move it out of the way (\`mv ${shellWord(this.path)} ${shellWord(`${this.path}.old`)}\`), then try again.`;
      case "home-replaced":
        return "Find what moves or replaces the data directory and stop it, then start the server again.";
    }
  }
}

/** Fails when something that is not a socket is where the admin socket goes. */
export const checkSocketPath = Effect.fn("Home.checkSocketPath")(function* (adminSocket: string) {
  if ((yield* Socket.probe(adminSocket)) === "not-a-socket") {
    return yield* new HomeBlocked({ path: adminSocket, reason: "not-a-socket" });
  }
});

const LOCK_FILE = HOME_ENTRIES.lock;
const SQLITE_BUSY = 5;

const isBusy = (error: unknown) =>
  Predicate.hasProperty(error, "errcode") && error.errcode === SQLITE_BUSY;

/**
 * Holds an exclusive lock on `file` for as long as the scope lives, or fails
 * with `held()` at once while another process holds it. The lock is SQLite's,
 * which the kernel releases when its process ends, so a process that crashed
 * never leaves it held, and two that take it at once cannot both get it.
 */
export const holdLock = <E>(file: string, held: () => E) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(file, { timeout: 0 });
        try {
          // No journal file: the lock never writes, and a crash then leaves nothing beside it.
          database.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
        } catch (error) {
          database.close();
          throw error;
        }
        return database;
      },
      catch: (error) =>
        isBusy(error) ? held() : new HomeBlocked({ path: file, reason: "lock-unusable" }),
    }),
    (database) => Effect.sync(() => database.close()),
  );

/**
 * Holds `<home>/server.lock`, which one server holds while it runs, and an
 * update while it copies the databases or puts them back.
 */
export const holdHome = Effect.fn("Home.holdHome")(function* (home: string) {
  const path = yield* Path.Path;
  yield* holdLock(path.join(home, LOCK_FILE), () => new ServerAlreadyRunning({ home }));
});

/**
 * Takes the home for this process, before anything else touches it: checks
 * that it is private, holds `<home>/server.lock` for as long as the scope
 * lives (`holdHome`), refuses it while a rollback has not finished, and then
 * removes an admin socket a stopped server left behind, on a system that has
 * one (`hasAdminSocket`).
 *
 * Holding the lock, the server is the only one that may remove or create the
 * admin socket, and no update copies or puts back the databases under it.
 */
export const reserve = Effect.gen(function* () {
  const { home, adminSocket } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* checkPrivate(home);
  yield* holdHome(home);
  // Again under the lock: a rollback may have started since `initialize`.
  yield* checkNoUnfinishedRollback(home);
  if (!Socket.hasAdminSocket(process.platform)) return;

  const socket = yield* Socket.probe(adminSocket);
  switch (socket) {
    case "absent":
      return;
    case "live":
      // A server that does not take the lock, such as an older release.
      return yield* new ServerAlreadyRunning({ home });
    case "not-a-socket":
      return yield* new HomeBlocked({ path: adminSocket, reason: "not-a-socket" });
    case "stale":
      yield* fs.remove(adminSocket);
  }
});

/** `reserve` for the server's lifetime, built before the database and the engine. */
export const layer = Layer.effectDiscard(reserve);
