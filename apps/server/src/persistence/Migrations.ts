// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Effect from "effect/Effect";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_operator_name.ts";
import Migration0003 from "./migrations/0003_turns.ts";
import Migration0004 from "./migrations/0004_routines.ts";
import Migration0005 from "./migrations/0005_sessions.ts";

/**
 * Migrations go forward only. Add one by appending an entry with the next id;
 * never edit or renumber one that has shipped.
 */
const migrations = SqliteMigrator.fromRecord({
  "1_initial": Migration0001,
  "2_operator_name": Migration0002,
  "3_turns": Migration0003,
  "4_routines": Migration0004,
  "5_sessions": Migration0005,
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
