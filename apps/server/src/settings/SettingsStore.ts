// SPDX-License-Identifier: AGPL-3.0-or-later
import { Label, PositiveInt, type Settings, TimeZone } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, timeText } from "../persistence/columns.ts";

const SettingsRow = Schema.Struct({
  operator_name: Schema.NullOr(Label),
  time_zone: TimeZone,
  hop_limit: PositiveInt,
  fan_out_limit: PositiveInt,
  concurrent_turns: PositiveInt,
  notifications_enabled: Flag,
  notification_previews: Flag,
});

/** The `settings` table's one row. */
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings>;
    readonly save: (settings: Settings, at: DateTime.Utc) => Effect.Effect<void>;
  }
>()("@j3-bots/server/settings/SettingsStore") {}

export const layer = Layer.effect(
  SettingsStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = SqlSchema.findOne({
      Request: Schema.Void,
      Result: SettingsRow,
      execute: () => sql`
        SELECT operator_name, time_zone, hop_limit, fan_out_limit, concurrent_turns,
          notifications_enabled, notification_previews
        FROM settings WHERE id = 1
      `,
    });
    return SettingsStore.of({
      get: read(undefined).pipe(
        Effect.orDie,
        Effect.map((row) => ({
          operatorName: row.operator_name,
          timeZone: row.time_zone,
          budgets: {
            hops: row.hop_limit,
            fanOut: row.fan_out_limit,
            concurrentTurns: row.concurrent_turns,
          },
          notifications: {
            enabled: row.notifications_enabled,
            previews: row.notification_previews,
          },
        })),
      ),
      save: Effect.fn("SettingsStore.save")(function* (settings: Settings, at: DateTime.Utc) {
        yield* sql`
          UPDATE settings SET
            operator_name = ${settings.operatorName},
            time_zone = ${settings.timeZone},
            hop_limit = ${settings.budgets.hops},
            fan_out_limit = ${settings.budgets.fanOut},
            concurrent_turns = ${settings.budgets.concurrentTurns},
            notifications_enabled = ${settings.notifications.enabled ? 1 : 0},
            notification_previews = ${settings.notifications.previews ? 1 : 0},
            updated_at = ${timeText(at)}
          WHERE id = 1
        `;
      }, Effect.orDie),
    });
  }),
);
