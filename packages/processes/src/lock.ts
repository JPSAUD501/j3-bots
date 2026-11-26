// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The lock is an SQLite lock, which only node:sqlite takes.
import * as NodeSqlite from "node:sqlite";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// A lock one process at a time holds on a file: SQLite's exclusive lock, which
// the kernel releases when its process ends, so a process cut off never
// leaves it held, and two that take it at once cannot both get it. The file
// stays once released: removed while another waits on it, a new file at its
// name would let two hold the lock. No journal is kept: the lock never writes,
// and a crash leaves nothing beside it.

/** The lock file could not be opened or locked, for a reason other than another holder. */
export class LockUnusable extends Schema.TaggedError<LockUnusable>()("LockUnusable", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {}

const SQLITE_BUSY = 5;

/** How often a lock another process holds is tried again, by `holdLockWaiting`. */
const RETRY = Duration.millis(250);

/** The lock on `file`, or none while another holds it. */
const attempt = (file: string) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { timeout: 0 });
      try {
        database.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
        return Option.some(database);
      } catch (error) {
        database.close();
        if (Predicate.hasProperty(error, "errcode") && error.errcode === SQLITE_BUSY) {
          return Option.none();
        }
        throw error;
      }
    },
    catch: (cause) => new LockUnusable({ file, cause }),
  });

const release = (database: NodeSqlite.DatabaseSync) => Effect.sync(() => database.close());

/**
 * Holds the lock on `file` for as long as the scope lives, or fails with
 * `held()` at once while another process holds it.
 */
export const holdLock = <E>(file: string, held: () => E) =>
  Effect.acquireRelease(
    attempt(file).pipe(
      Effect.flatMap(
        Option.match({
          onSome: (database) => Effect.succeed(database),
          onNone: () => Effect.fail(held()),
        }),
      ),
    ),
    release,
  ).pipe(Effect.asVoid);

/**
 * Holds the lock on `file` for as long as the scope lives, waiting, without
 * blocking, while another process holds it. `waiting` runs once, when the
 * lock is first found held, so whoever waits is told why nothing happens: the
 * wait lasts as long as the other holder, whose process ending ends it.
 */
export const holdLockWaiting = (file: string, waiting: Effect.Effect<void>) => {
  const retry: Effect.Effect<NodeSqlite.DatabaseSync, LockUnusable> = attempt(file).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (database) => Effect.succeed(database),
        onNone: () => Effect.sleep(RETRY).pipe(Effect.andThen(retry)),
      }),
    ),
  );
  const first = attempt(file).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (database) => Effect.succeed(database),
        onNone: () => waiting.pipe(Effect.andThen(Effect.sleep(RETRY)), Effect.andThen(retry)),
      }),
    ),
  );
  return Effect.acquireRelease(first, release).pipe(Effect.asVoid);
};
