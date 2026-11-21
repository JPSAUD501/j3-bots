// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CommandId } from "@j3-bots/contracts";
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
