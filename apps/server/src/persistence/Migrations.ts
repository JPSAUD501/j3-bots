// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_operator_name.ts";
import Migration0003 from "./migrations/0003_turns.ts";
import Migration0004 from "./migrations/0004_routines.ts";
import Migration0005 from "./migrations/0005_sessions.ts";
import Migration0006 from "./migrations/0006_notifications.ts";
import Migration0007 from "./migrations/0007_routine_runs.ts";
import Migration0008 from "./migrations/0008_teammate_messages.ts";
import Migration0009 from "./migrations/0009_room_turns.ts";
import Migration0010 from "./migrations/0010_push_registrations.ts";
import Migration0012 from "./migrations/0012_push_deliveries.ts";

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
  "6_notifications": Migration0006,
  "7_routine_runs": Migration0007,
  "8_teammate_messages": Migration0008,
  "9_room_turns": Migration0009,
  "10_push_registrations": Migration0010,
  "12_push_deliveries": Migration0012,
});

const Recorded = Schema.Struct({ migration_id: Schema.Int });

/**
 * Applies, in one transaction, every migration of `loader` the database has
 * not recorded yet. The migrator applies only those numbered past the last
 * one recorded, so a database that recorded one numbered later than a
 * migration it lacks is refused: that migration would never be applied.
 */
export const migrate = Effect.fn("migrate")(function* (loader: Migrator.Loader) {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (table !== undefined) {
    const recorded = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Recorded,
      execute: () => sql`SELECT migration_id FROM effect_sql_migrations`,
    })(undefined).pipe(Effect.orDie);
    const ids = new Set(recorded.map(({ migration_id }) => migration_id));
    const latest = Math.max(0, ...ids);
    const skipped = (yield* loader).filter(([id]) => id < latest && !ids.has(id));
    if (skipped.length > 0) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `The database recorded migration ${latest} but not ${skipped
          .map(([id, name]) => `${id}_${name}`)
          .join(", ")}, which would never be applied`,
      });
    }
  }
  const applied = yield* SqliteMigrator.run({ loader });
  if (applied.length > 0) {
    yield* Effect.logInfo("Applied database migrations").pipe(
      Effect.annotateLogs({ migrations: applied.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return applied;
});

/** Applies every migration of this server the database has not recorded yet. */
export const runMigrations = () => migrate(migrations);
