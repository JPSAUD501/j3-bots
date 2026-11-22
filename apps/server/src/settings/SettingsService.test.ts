// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId, TimeZone } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestDomain from "../testing/domain.ts";
import { SettingsService } from "./SettingsService.ts";

it.effect("changes only the notification switch a device sent", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    yield* settings.update({
      commandId: CommandId.make("previews-on"),
      changes: { notifications: { previews: true } },
    });
    // A device that still holds previews off turns notifications off.
    const saved = yield* settings.update({
      commandId: CommandId.make("off"),
      changes: { notifications: { enabled: false } },
    });

    assert.deepStrictEqual(saved.notifications, { enabled: false, previews: true });
    assert.deepStrictEqual((yield* settings.get).notifications, saved.notifications);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers a retry from a receipt written before notifications could be off", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const sql = yield* SqlClient.SqlClient;
    const save = settings.update({
      commandId: CommandId.make("previews-on"),
      changes: { notifications: { previews: true } },
    });
    yield* save;
    yield* sql`
      UPDATE command_receipts SET result_json = json_remove(result_json, '$.notifications.enabled')
      WHERE command_id = 'previews-on'
    `;

    assert.deepStrictEqual((yield* save).notifications, { enabled: true, previews: true });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes the time zone of the first device that gives one, and keeps it", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    assert.strictEqual((yield* settings.get).timeZone, "UTC");

    yield* settings.deviceTimeZone(TimeZone.make("America/Sao_Paulo"));
    yield* settings.deviceTimeZone(TimeZone.make("Europe/Lisbon"));

    assert.strictEqual((yield* settings.get).timeZone, "America/Sao_Paulo");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps the time zone the operator chose over any device's", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    // A save that only names the operator leaves the zone open to their device.
    yield* settings.update({ commandId: CommandId.make("name"), changes: { operatorName: "Ana" } });
    yield* settings.update({
      commandId: CommandId.make("zone"),
      changes: { timeZone: TimeZone.make("UTC") },
    });

    yield* settings.deviceTimeZone(TimeZone.make("America/Sao_Paulo"));

    assert.strictEqual((yield* settings.get).timeZone, "UTC");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("passes over a device's zone the server does not know, and takes the next one", () =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;

    yield* settings.deviceTimeZone(TimeZone.make("Mars/Olympus_Mons"));
    assert.strictEqual((yield* settings.get).timeZone, "UTC");
    yield* settings.deviceTimeZone(TimeZone.make("Asia/Tokyo"));

    assert.strictEqual((yield* settings.get).timeZone, "Asia/Tokyo");
  }).pipe(Effect.provide(TestDomain.layer)),
);
