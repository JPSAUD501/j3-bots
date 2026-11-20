// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The reservation is an SQLite lock, which only node:sqlite takes.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Socket from "../admin/socket.ts";
import { DEFAULTS_TEXT, load, ServerConfig } from "../config.ts";
import { HOME_ENTRIES } from "./entries.ts";

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
  reason: Schema.Literals(["not-a-folder", "not-owned", "open-to-others"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-folder":
        return `${this.home} is not a folder. Move it away, or set J3_HOME to another folder.`;
      case "not-owned":
        return `${this.home} belongs to another user, so this user cannot keep it private. ${this.fix}`;
      case "open-to-others":
        return `Other users on this machine can open ${this.home}, which holds the database, the engine's credential and the admin socket. ${this.fix}`;
    }
  }

  /** The command that repairs it, for the operator to run. */
  get fix(): string {
    switch (this.reason) {
      case "not-a-folder":
        return "Set J3_HOME to a folder.";
      case "not-owned":
        return `Give it to this user: \`sudo chown -R "$(id -un)": ${shellWord(this.home)} && chmod 700 ${shellWord(this.home)}\`.`;
      case "open-to-others":
        return `Run \`chmod 700 ${shellWord(this.home)}\`.`;
    }
  }
}

/**
 * Whether `home` is a folder owned by this user that no group and no other
 * user can open. A home that does not exist yet passes: the server creates it
 * private.
 */
export const checkPrivate = Effect.fn("Home.checkPrivate")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home).pipe(Effect.option);
  if (Option.isNone(info)) return;
  if (info.value.type !== "Directory") {
    return yield* new HomeNotPrivate({ home, reason: "not-a-folder" });
  }
  const user = process.getuid?.();
  if (user !== undefined && Option.isSome(info.value.uid) && info.value.uid.value !== user) {
    return yield* new HomeNotPrivate({ home, reason: "not-owned" });
  }
  if ((info.value.mode & 0o077) !== 0) {
    return yield* new HomeNotPrivate({ home, reason: "open-to-others" });
  }
});

/** Random bytes in a temporary file's name: never guessed ahead of the write. */
const TEMPORARY_NAME_BYTES = 12;

/**
 * Publishes `text` at `file`, whole, unless something is already there: it is
 * written to a new file of a random name in the same folder first, which then
 * takes the name only if it is free. A full disk or a crash never leaves a
 * partial file at `file`, and an existing one is never replaced.
 */
const publishNew = Effect.fn("Home.publishNew")(function* (file: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const suffix = Hex.encode(yield* random.randomBytes(TEMPORARY_NAME_BYTES));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.j3-writing`);
  yield* fs.writeFileString(temporary, text, { flag: "wx", mode: 0o600 }).pipe(
    // A link, unlike a rename, fails rather than replace what is at `file`.
    Effect.andThen(
      fs.link(temporary, file).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      ),
    ),
    Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
  );
});

/**
 * The configuration for a server about to start, with its home ready. Nothing
 * is written until both pass their checks: the configuration, as `load`
 * checks it (where the home is included), and the home's privacy. Then the
 * home is created, readable by the operator only, and on first run
 * `config.json` is published with every setting at its default. An existing
 * file is never rewritten.
 */
export const initialize = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* load;
  yield* checkPrivate(config.home);
  yield* fs.makeDirectory(config.home, { recursive: true, mode: 0o700 });
  yield* publishNew(config.configFile, DEFAULTS_TEXT).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  return config;
});

/** The configuration for a server about to start: `initialize`, as a layer. */
export const configLayer = Layer.effect(ServerConfig, initialize);

/** Another server already uses this home. */
class ServerAlreadyRunning extends Schema.TaggedError<ServerAlreadyRunning>()(
  "ServerAlreadyRunning",
  { home: Schema.String },
) {
  override get message(): string {
    return `A J3 Bots server is already running for ${this.home}. Stop it before starting another.`;
  }
}

/** Something in the home is in the way of the reservation or the admin socket. */
class HomeBlocked extends Schema.TaggedError<HomeBlocked>()("HomeBlocked", {
  path: Schema.String,
  reason: Schema.Literals(["lock-unusable", "not-a-socket"]),
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
    }
  }

  /** How to clear it, for the operator to do. */
  get fix(): string {
    switch (this.reason) {
      case "lock-unusable":
        return "Check that this user can write to the folder that holds it.";
      case "not-a-socket":
        return `Move it out of the way (\`mv ${shellWord(this.path)} ${shellWord(`${this.path}.old`)}\`), then try again.`;
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
 * Takes the home for this process, before anything else touches it: checks
 * that it is private, holds an exclusive lock on `<home>/server.lock` for as
 * long as the scope lives, and then removes an admin socket a stopped server
 * left behind.
 *
 * The lock is SQLite's, which the kernel releases when its process ends, so a
 * server that crashed never leaves the home held, and two servers that start
 * at once cannot both take it. Holding it, the server is the only one that
 * may remove or create the admin socket.
 */
export const reserve = Effect.gen(function* () {
  const { home, adminSocket } = yield* ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* checkPrivate(home);

  const lockFile = path.join(home, LOCK_FILE);
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(lockFile, { timeout: 0 });
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
        isBusy(error)
          ? new ServerAlreadyRunning({ home })
          : new HomeBlocked({ path: lockFile, reason: "lock-unusable" }),
    }),
    (database) => Effect.sync(() => database.close()),
  );

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
