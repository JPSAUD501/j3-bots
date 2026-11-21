// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The lock is an SQLite lock, which only node:sqlite takes.
import * as NodeSqlite from "node:sqlite";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The lock file could not be opened or locked, for a reason other than another holder. */
export class LockUnusable extends Schema.TaggedError<LockUnusable>()("LockUnusable", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {}

const SQLITE_BUSY = 5;

/** How often a lock another process holds is tried again. */
const RETRY = Duration.millis(250);

/** The lock on `file`, or none while another holds it. */
const attempt = (file: string) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { timeout: 0 });
      try {
        // No journal file: the lock never writes, and a crash then leaves nothing beside it.
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

const take = (file: string): Effect.Effect<NodeSqlite.DatabaseSync, LockUnusable> =>
  attempt(file).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.sleep(RETRY).pipe(Effect.andThen(take(file))),
      }),
    ),
  );

/**
 * Holds an exclusive lock on `file` for as long as the scope lives, waiting,
 * without blocking, while another process or connection holds it. The lock
 * is SQLite's, which the kernel releases when its process ends, so a process
 * cut off never leaves it held. The file stays once released: removed while
 * another waits on it, a new file at its name would let two hold the lock.
 */
export const holdExclusive = (file: string) =>
  Effect.acquireRelease(take(file), (database) => Effect.sync(() => database.close()));
