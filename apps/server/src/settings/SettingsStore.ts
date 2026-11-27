// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudVoiceModelId,
  Label,
  ModelChoice,
  PositiveInt,
  type Settings,
  TimeZone,
  UpdateChannel,
  VoiceLanguage,
  VoiceModelId,
  VoicePlace,
  type VoiceSettings,
  VoiceWords,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, json, timeText } from "../persistence/columns.ts";
import { TelemetryConfig } from "../telemetry/Telemetry.ts";

const SettingsRow = Schema.Struct({
  operator_name: Schema.NullOr(Label),
  time_zone: TimeZone,
  hop_limit: PositiveInt,
  fan_out_limit: PositiveInt,
  concurrent_turns: PositiveInt,
  notifications_enabled: Flag,
  notification_previews: Flag,
  update_channel: UpdateChannel,
  auto_update_harnesses: Flag,
  suggest_replies: Flag,
  voice_place: VoicePlace,
  voice_language: VoiceLanguage,
  voice_words_json: json(VoiceWords),
  voice_remove_fillers: Flag,
  voice_clean_up: Flag,
  voice_model: Schema.NullOr(VoiceModelId),
  voice_openrouter_model: Schema.NullOr(CloudVoiceModelId),
  telemetry: Flag,
  favorite_models_json: json(Schema.Array(ModelChoice)),
});

const encodeWords = Schema.encodeSync(json(VoiceWords));
const encodeFavorites = Schema.encodeSync(json(Schema.Array(ModelChoice)));

/** Dictation's preferences until the operator changes them, as the migration sets them. */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  place: "automatic",
  language: "auto",
  words: [],
  removeFillers: true,
  cleanUp: false,
  model: null,
  openRouterModel: null,
};

/** The `settings` table's one row. */
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings>;
    /** Writes every field; `zoneChosen` records that the operator chose the time zone. */
    readonly save: (
      settings: Settings,
      at: DateTime.Utc,
      options: { readonly zoneChosen: boolean },
    ) => Effect.Effect<void>;
    /**
     * Sets the time zone to `timeZone` unless the operator chose one or a
     * device already gave one, and records that it is set. True when it set it.
     */
    readonly adoptTimeZone: (timeZone: TimeZone, at: DateTime.Utc) => Effect.Effect<boolean>;
  }
>()("@j3-bots/server/settings/SettingsStore") {}

export const layer = Layer.effect(
  SettingsStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const heldOff = (yield* TelemetryConfig).environment.hold !== null;
    const read = SqlSchema.findOne({
      Request: Schema.Void,
      Result: SettingsRow,
      execute: () => sql`
        SELECT operator_name, time_zone, hop_limit, fan_out_limit, concurrent_turns,
          notifications_enabled, notification_previews, update_channel, auto_update_harnesses,
          suggest_replies, voice_place, voice_language, voice_words_json, voice_remove_fillers,
          voice_clean_up, voice_model, voice_openrouter_model, telemetry, favorite_models_json
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
          updateChannel: row.update_channel,
          autoUpdateHarnesses: row.auto_update_harnesses,
          suggestReplies: row.suggest_replies,
          voice: {
            place: row.voice_place,
            language: row.voice_language,
            words: row.voice_words_json,
            removeFillers: row.voice_remove_fillers,
            cleanUp: row.voice_clean_up,
            model: row.voice_model,
            openRouterModel: row.voice_openrouter_model,
          },
          telemetry: { enabled: row.telemetry, heldOff },
          favoriteModels: row.favorite_models_json,
        })),
      ),
      save: Effect.fn("SettingsStore.save")(function* (
        settings: Settings,
        at: DateTime.Utc,
        { zoneChosen }: { readonly zoneChosen: boolean },
      ) {
        const voice = settings.voice ?? DEFAULT_VOICE_SETTINGS;
        yield* sql`
          UPDATE settings SET
            operator_name = ${settings.operatorName},
            time_zone = ${settings.timeZone},
            time_zone_set = MAX(time_zone_set, ${zoneChosen ? 1 : 0}),
            hop_limit = ${settings.budgets.hops},
            fan_out_limit = ${settings.budgets.fanOut},
            concurrent_turns = ${settings.budgets.concurrentTurns},
            notifications_enabled = ${settings.notifications.enabled ? 1 : 0},
            notification_previews = ${settings.notifications.previews ? 1 : 0},
            update_channel = ${settings.updateChannel},
            auto_update_harnesses = ${settings.autoUpdateHarnesses ? 1 : 0},
            suggest_replies = ${settings.suggestReplies === false ? 0 : 1},
            voice_place = ${voice.place},
            voice_language = ${voice.language},
            voice_words_json = ${encodeWords(voice.words)},
            voice_remove_fillers = ${voice.removeFillers ? 1 : 0},
            voice_clean_up = ${voice.cleanUp ? 1 : 0},
            voice_model = ${voice.model},
            voice_openrouter_model = ${voice.openRouterModel},
            telemetry = ${settings.telemetry?.enabled === false ? 0 : 1},
            favorite_models_json = ${encodeFavorites(settings.favoriteModels ?? [])},
            updated_at = ${timeText(at)}
          WHERE id = 1
        `;
      }, Effect.orDie),
      adoptTimeZone: Effect.fn("SettingsStore.adoptTimeZone")(function* (
        timeZone: TimeZone,
        at: DateTime.Utc,
      ) {
        const set = yield* sql`
          UPDATE settings SET time_zone = ${timeZone}, time_zone_set = 1, updated_at = ${timeText(at)}
          WHERE id = 1 AND time_zone_set = 0
          RETURNING id
        `;
        return set.length > 0;
      }, Effect.orDie),
    });
  }),
);
