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
import Migration0011 from "./migrations/0011_push_deliveries.ts";
import Migration0012 from "./migrations/0012_room_integrity.ts";
import Migration0013 from "./migrations/0013_bot_avatar_colors.ts";
import Migration0014 from "./migrations/0014_no_engine_dismissals.ts";
import Migration0015 from "./migrations/0015_refused_openings.ts";
import Migration0016 from "./migrations/0016_refused_permission_modes.ts";
import Migration0017 from "./migrations/0017_device_time_zone.ts";
import Migration0018 from "./migrations/0018_default_models.ts";
import Migration0019 from "./migrations/0019_held_messages.ts";
import Migration0020 from "./migrations/0020_pips_avatars.ts";
import Migration0021 from "./migrations/0021_missed_routines.ts";

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
  "11_push_deliveries": Migration0011,
  "12_room_integrity": Migration0012,
  "13_bot_avatar_colors": Migration0013,
  "14_no_engine_dismissals": Migration0014,
  "15_refused_openings": Migration0015,
  "16_refused_permission_modes": Migration0016,
  "17_device_time_zone": Migration0017,
  "18_default_models": Migration0018,
  "19_held_messages": Migration0019,
  "20_pips_avatars": Migration0020,
  "21_missed_routines": Migration0021,
});

const Recorded = Schema.Struct({ migration_id: Schema.Int, name: Schema.String });

/**
 * Applies, in one transaction, every migration of `loader` the database has
 * not recorded yet. Refused first, with nothing applied:
 *
 * - a database that records a migration `loader` does not have: a newer
 *   release of J3 Bots wrote it, and this one cannot know what it changed;
 * - a database that recorded one numbered later than a migration it lacks:
 *   the migrator applies only those numbered past the last one recorded, so
 *   that migration would never be applied.
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
      execute: () => sql`SELECT migration_id, name FROM effect_sql_migrations`,
    })(undefined).pipe(Effect.orDie);
    const known = yield* loader;
    const knownIds = new Set(known.map(([id]) => id));
    const unknown = recorded.filter(({ migration_id }) => !knownIds.has(migration_id));
    if (unknown.length > 0) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `The database records ${unknown
          .map(({ migration_id, name }) => `${migration_id}_${name}`)
          .join(
            ", ",
          )}, which this release of J3 Bots does not know: a newer release migrated it. Run that release, or put back the database from before it with \`j3-bots update --rollback\``,
      });
    }
    const ids = new Set(recorded.map(({ migration_id }) => migration_id));
    const latest = Math.max(0, ...ids);
    const skipped = known.filter(([id]) => id < latest && !ids.has(id));
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

/**
 * The migrations through `last`, as the release that ended with it applied
 * them: a test writes the database such a release left, then upgrades it.
 */
export const migrationsThrough = (last: number): Migrator.Loader =>
  Effect.map(migrations, (all) => all.filter(([id]) => id <= last));
