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
import Migration0022 from "./migrations/0022_roster_sections.ts";
import Migration0023 from "./migrations/0023_update_channel.ts";
import Migration0024 from "./migrations/0024_browser_help.ts";
import Migration0025 from "./migrations/0025_bot_browser.ts";
import Migration0026 from "./migrations/0026_credential_requests.ts";
import Migration0027 from "./migrations/0027_bot_vault.ts";
import Migration0028 from "./migrations/0028_connector_cards.ts";
import Migration0029 from "./migrations/0029_connectors.ts";
import Migration0030 from "./migrations/0030_held_tool_calls.ts";
import Migration0031 from "./migrations/0031_teammate_pairs.ts";
import Migration0032 from "./migrations/0032_rooms_without_host.ts";
import Migration0033 from "./migrations/0033_room_relays.ts";
import Migration0034 from "./migrations/0034_room_rounds.ts";
import Migration0035 from "./migrations/0035_room_views.ts";
import Migration0036 from "./migrations/0036_harness_updates.ts";
import Migration0037 from "./migrations/0037_secret_asks.ts";
import Migration0040 from "./migrations/0040_bots_manage_mcp_and_skills.ts";
import Migration0041 from "./migrations/0041_visibility.ts";
import Migration0042 from "./migrations/0042_connectors_as_served.ts";
import Migration0043 from "./migrations/0043_connector_apps.ts";
import Migration0044 from "./migrations/0044_local_device.ts";
import Migration0045 from "./migrations/0045_requested_openings.ts";
import Migration0046 from "./migrations/0046_refusal_engine_start.ts";
import Migration0047 from "./migrations/0047_browser_help_pushes.ts";
import Migration0048 from "./migrations/0048_stop_reach.ts";
import Migration0049 from "./migrations/0049_engine_edges.ts";
import Migration0050 from "./migrations/0050_engine_instance.ts";
import Migration0051 from "./migrations/0051_first_spoke.ts";
import Migration0052 from "./migrations/0052_connector_asks.ts";
import Migration0053 from "./migrations/0053_work_images.ts";
import Migration0054 from "./migrations/0054_suggested_replies.ts";
import Migration0055 from "./migrations/0055_turn_work.ts";
import Migration0056 from "./migrations/0056_retries_and_ignored_stops.ts";
import Migration0057 from "./migrations/0057_engine_release.ts";
import Migration0058 from "./migrations/0058_bot_effort.ts";
import Migration0059 from "./migrations/0059_engine_notices.ts";
import Migration0060 from "./migrations/0060_routine_steps.ts";
import Migration0061 from "./migrations/0061_reactions.ts";
import Migration0062 from "./migrations/0062_routine_events.ts";
import Migration0063 from "./migrations/0063_connector_app_entries.ts";
import Migration0064 from "./migrations/0064_voice.ts";
import Migration0065 from "./migrations/0065_telemetry.ts";
import Migration0066 from "./migrations/0066_bot_maker.ts";
import Migration0067 from "./migrations/0067_voice_provider.ts";

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
  "22_roster_sections": Migration0022,
  "23_update_channel": Migration0023,
  "24_browser_help": Migration0024,
  "25_bot_browser": Migration0025,
  "26_credential_requests": Migration0026,
  "27_bot_vault": Migration0027,
  "28_connector_cards": Migration0028,
  "29_connectors": Migration0029,
  "30_held_tool_calls": Migration0030,
  "31_teammate_pairs": Migration0031,
  "32_rooms_without_host": Migration0032,
  "33_room_relays": Migration0033,
  "34_room_rounds": Migration0034,
  "35_room_views": Migration0035,
  "36_harness_updates": Migration0036,
  "37_secret_asks": Migration0037,
  "40_bots_manage_mcp_and_skills": Migration0040,
  "41_visibility": Migration0041,
  "42_connectors_as_served": Migration0042,
  "43_connector_apps": Migration0043,
  "44_local_device": Migration0044,
  "45_requested_openings": Migration0045,
  "46_refusal_engine_start": Migration0046,
  "47_browser_help_pushes": Migration0047,
  "48_stop_reach": Migration0048,
  "49_engine_edges": Migration0049,
  "50_engine_instance": Migration0050,
  "51_first_spoke": Migration0051,
  "52_connector_asks": Migration0052,
  "53_work_images": Migration0053,
  "54_suggested_replies": Migration0054,
  "55_turn_work": Migration0055,
  "56_retries_and_ignored_stops": Migration0056,
  "57_engine_release": Migration0057,
  "58_bot_effort": Migration0058,
  "59_engine_notices": Migration0059,
  "60_routine_steps": Migration0060,
  "61_reactions": Migration0061,
  "62_routine_events": Migration0062,
  "63_connector_app_entries": Migration0063,
  "64_voice": Migration0064,
  "65_telemetry": Migration0065,
  "66_bot_maker": Migration0066,
  "67_voice_provider": Migration0067,
});

const Recorded = Schema.Struct({ migration_id: Schema.Int, name: Schema.String });

const ForeignKeys = Schema.Struct({ foreign_keys: Schema.Int });
const Violation = Schema.Struct({ table: Schema.String, parent: Schema.String });

/**
 * Applies, in one transaction, every migration of `loader` the database has
 * not recorded yet. They run with foreign keys off, as SQLite's rebuild of a
 * table needs: dropping a table that rows reference must not delete or
 * change those rows. Before the transaction commits, every reference must
 * name a row that exists, or nothing is applied. Foreign keys are back as the
 * connection had them once it ends. Refused first, with nothing applied:
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
  const [enforced] = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: ForeignKeys,
    execute: () => sql`PRAGMA foreign_keys`,
  })(undefined).pipe(Effect.orDie);
  // A pragma that changes nothing inside a transaction, so set before it.
  yield* sql`PRAGMA foreign_keys = OFF`;
  // The migrator's own transaction nests in this one, which commits only
  // once the references hold.
  const applied = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const applied = yield* SqliteMigrator.run({ loader });
        const broken = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Violation,
          execute: () => sql`PRAGMA foreign_key_check`,
        })(undefined).pipe(Effect.orDie);
        if (broken.length > 0) {
          return yield* new Migrator.MigrationError({
            kind: "Failed",
            message: `The migrations left rows that reference rows that do not exist (${[
              ...new Set(broken.map(({ table, parent }) => `${table} → ${parent}`)),
            ].join(", ")}), so none was applied`,
          });
        }
        return applied;
      }),
    )
    .pipe(
      Effect.ensuring(
        enforced?.foreign_keys === 1
          ? sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie)
          : Effect.void,
      ),
    );
  if (applied.length > 0) {
    yield* Effect.logInfo("Applied database migrations").pipe(
      Effect.annotateLogs({ migrations: applied.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return applied;
});

/** The migrations this release knows, by id. */
export const knownMigrations = Effect.map(migrations, (all) => all.map(([id]) => id));

/** Applies every migration of this server the database has not recorded yet. */
export const runMigrations = () => migrate(migrations);

/**
 * The migrations through `last`, as the release that ended with it applied
 * them: a test writes the database such a release left, then upgrades it.
 */
export const migrationsThrough = (last: number): Migrator.Loader =>
  Effect.map(migrations, (all) => all.filter(([id]) => id <= last));
