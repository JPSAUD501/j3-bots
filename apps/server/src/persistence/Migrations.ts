import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Effect from "effect/Effect";
import Migration0001 from "./migrations/0001_initial.ts";

/**
 * Migrations go forward only. Add one by appending an entry with the next id;
 * never edit or renumber one that has shipped.
 */
const migrations = SqliteMigrator.fromRecord({
  "1_initial": Migration0001,
});

/** Applies, in one transaction, every migration the database has not recorded yet. */
export const runMigrations = Effect.fn("runMigrations")(function* () {
  const applied = yield* SqliteMigrator.run({ loader: migrations });
  if (applied.length > 0) {
    yield* Effect.logInfo("Applied database migrations").pipe(
      Effect.annotateLogs({ migrations: applied.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return applied;
});
