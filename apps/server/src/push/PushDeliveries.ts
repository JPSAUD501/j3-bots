// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId, Language, LANGUAGES } from "@j3-bots/contracts";
import { createI18n, type I18n, notificationText } from "@j3-bots/i18n";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { timeText } from "../persistence/columns.ts";
import type { Recipients } from "../presence/Presence.ts";
import { Signals } from "../turns/Signals.ts";

/**
 * How long a push may wait to be handed to the push service. Past that, what
 * it says is old, and the roster shows the entry unread anyway.
 */
const SEND_WINDOW = Duration.hours(1);

const Name = Schema.Struct({ name: Schema.String });

const Registered = Schema.Struct({ device_id: DeviceId, language: Language });
const decodeRegistered = Schema.decodeUnknownEffect(Registered);

/**
 * The pushes to make (`docs/architecture/server.md`, Notifications). Each
 * device to push an entry's notification to gets one delivery, written in the
 * transaction that adds the entry and worded then, in the language the device
 * registered with: the push says what the operator's settings allowed at that
 * moment, a preview included only if they allowed previews, and keeps the
 * same words without the preview for a send made after previews were turned
 * off. The delivery worker (`PushWorker`) sends them.
 */
export class PushDeliveries extends Context.Service<
  PushDeliveries,
  {
    /**
     * Writes a delivery for each device to push of `recipients`, through the
     * current transaction, and nudges the worker once it commits. None for a
     * bot or room that has no name to show, nor for a registration that cannot
     * be read. Fails only with a defect: the entry's append keeps it from
     * costing the entry (`Entries`).
     */
    readonly record: (recipients: Recipients) => Effect.Effect<void>;
  }
>()("@j3-bots/server/push/PushDeliveries") {}

export const layer = Layer.effect(
  PushDeliveries,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* Ids;
    const signals = yield* Signals;
    const catalogs = new Map<Language, I18n>(
      LANGUAGES.map((language) => [language, createI18n(language)]),
    );

    const botName = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Name,
      execute: (id) => sql`SELECT name FROM bots WHERE id = ${id}`,
    });
    const roomName = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Name,
      execute: (id) => sql`SELECT name FROM rooms WHERE id = ${id}`,
    });

    const record = Effect.fn("PushDeliveries.record")(function* (recipients: Recipients) {
      if (recipients.push.length === 0) return;
      const { notification } = recipients;
      const bot = yield* botName(notification.botId);
      const { target } = notification;
      const room = target._tag === "room" ? yield* roomName(target.roomId) : Option.none();
      const names = {
        botName: () => Option.getOrNull(Option.map(bot, ({ name }) => name)),
        roomName: () => Option.getOrNull(Option.map(room, ({ name }) => name)),
      };
      const now = yield* DateTime.now;
      const at = timeText(now);
      const deadline = timeText(DateTime.addDuration(now, SEND_WINDOW));
      // Read one by one, so a registration that cannot be read is skipped alone.
      const registrations = yield* sql`
        SELECT device_id, language FROM push_registrations
        WHERE ${sql.in("device_id", recipients.push)}
      `;
      let written = false;
      for (const row of registrations) {
        const registered = yield* decodeRegistered(row).pipe(Effect.option);
        const catalog = Option.flatMap(registered, ({ language }) =>
          Option.fromNullishOr(catalogs.get(language)),
        );
        if (Option.isNone(registered) || Option.isNone(catalog)) {
          yield* Effect.logWarning("A push registration cannot be read; it is not pushed to").pipe(
            Effect.annotateLogs({
              entryId: notification.entryId,
              deviceId: typeof row["device_id"] === "string" ? row["device_id"] : null,
            }),
          );
          continue;
        }
        const text = notificationText(notification, names, catalog.value);
        if (text === null) continue;
        const plain =
          notification.preview === null && notification.browserHelp === null
            ? text
            : notificationText(
                { ...notification, preview: null, browserHelp: null },
                names,
                catalog.value,
              );
        if (plain === null) continue;
        yield* sql`
          INSERT INTO push_deliveries (
            id, entry_id, device_id, status, title, body, plain_body, due_at, deadline_at,
            created_at
          ) VALUES (
            ${yield* ids.make("push")}, ${notification.entryId}, ${registered.value.device_id},
            'pending', ${text.title}, ${text.body}, ${plain.body}, ${at}, ${deadline}, ${at}
          )
        `;
        if (!written) yield* sql.afterCommit(signals.push.fire);
        written = true;
      }
    }, Effect.orDie);

    return PushDeliveries.of({ record });
  }),
);
