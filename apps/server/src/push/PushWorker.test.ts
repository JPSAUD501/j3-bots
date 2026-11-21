// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, type DeviceId, PushToken } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Bots } from "../bots/Bots.ts";
import { Devices } from "../devices/Devices.ts";
import * as Domain from "../domain.ts";
import { Entries } from "../entries/Entries.ts";
import { Presence } from "../presence/Presence.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import { TestPushService } from "../testing/push.ts";
import { until } from "../testing/turns.ts";
import { PushUnavailable } from "./PushSender.ts";
import { MAX_ATTEMPTS, PushWorker, RECEIPT_DELAY, sendBackoff } from "./PushWorker.ts";

/** Every line logged where `recordLogs` is provided, as JSON. */
const logged: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.map(Logger.formatJson, (line) => {
    logged.push(line);
  }),
]);

const createBot = (name: string) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    return yield* bots.create({ commandId: CommandId.make(`create-${name}`), draft: { name } });
  });

/** A device paired and registered for push, with a token of its own. */
const pushDevice = (name: string) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    const { deviceId } = yield* devices.pair({ code, name });
    yield* devices.registerPush({
      commandId: CommandId.make(`register-${deviceId}`),
      deviceId,
      registration: {
        provider: "expo",
        token: PushToken.make(`ExponentPushToken[fixture-${name}]`),
        platform: "android",
        language: "en",
      },
    });
    return deviceId;
  });

const says = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    return yield* entries.append({
      target: { _tag: "conversation", botId },
      entry: {
        _tag: "message",
        author: { _tag: "bot", botId },
        text,
        attachments: [],
        mentions: { _tag: "bots", ids: [] },
        delivery: { _tag: "delivered" },
        commandId: null,
      },
    });
  });

const deliverPending = Effect.gen(function* () {
  yield* (yield* PushWorker).deliverPending;
});

const sends = Effect.gen(function* () {
  return yield* (yield* TestPushService).sends;
});

/** The deliveries still followed. */
const deliveries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ status: Schema.String, attempts: Schema.Int }),
    execute: () => sql`SELECT status, attempts FROM push_deliveries ORDER BY created_at`,
  })(undefined);
});

const failuresOf = (deviceId: DeviceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly failures: number }>`
      SELECT failures FROM push_registrations WHERE device_id = ${deviceId}
    `;
    return rows[0]?.failures;
  });

it.effect(
  "pushes an entry once to each device with no socket open, across a restart, and none to a connected one",
  () =>
    Effect.gen(function* () {
      const { phone, entryId } = yield* Effect.gen(function* () {
        const presence = yield* Presence;
        const scout = yield* createBot("Scout");
        const phone = yield* pushDevice("Phone");
        const laptop = yield* pushDevice("Laptop");
        yield* presence.connect(laptop);
        const entry = yield* says(scout.id, "The build is green");
        yield* deliverPending;
        return { phone, entryId: entry.id };
      }).pipe(Effect.scoped, Effect.provide(Domain.layer));

      yield* Effect.gen(function* () {
        yield* deliverPending;
        yield* TestClock.adjust(RECEIPT_DELAY);
        yield* deliverPending;
        // The receipt said it was handed on: nothing is left to follow.
        assert.deepStrictEqual(yield* deliveries, []);
      }).pipe(Effect.provide(Domain.layer));

      const sent = yield* sends;
      assert.deepStrictEqual(
        sent.map((message) => [message.data.deviceId, message.data.entryId, message.title]),
        [[phone, entryId, "Scout"]],
      );
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "sends again with the same key after a crash between a send and its record, only once its backoff passed",
  () =>
    Effect.gen(function* () {
      const service = yield* TestPushService;
      yield* service.answer(["take-and-hang"]);
      yield* Effect.gen(function* () {
        const scout = yield* createBot("Scout");
        yield* pushDevice("Phone");
        yield* says(scout.id, "Done");
        // The service took it; the server stops before it hears so.
        yield* until(Effect.map(sends, (sent) => sent.length === 1));
      }).pipe(Effect.provide(Domain.layer));

      yield* Effect.gen(function* () {
        // The send was recorded as begun: not sent again at once.
        yield* deliverPending;
        assert.strictEqual((yield* sends).length, 1);
        yield* TestClock.adjust(sendBackoff(1));
        yield* deliverPending;
      }).pipe(Effect.provide(Domain.layer));

      // Sent again, with the key the service replaces a notification still shown by.
      const [first, second, ...more] = yield* sends;
      assert.isDefined(second);
      assert.strictEqual(second?.key, first?.key);
      assert.deepStrictEqual(more, []);
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("sends nothing to a device revoked while the pass was sending to another", () =>
  Effect.gen(function* () {
    const service = yield* TestPushService;
    const auth = yield* DeviceAuth;
    const scout = yield* createBot("Scout");
    const phone = yield* pushDevice("Phone");
    const tablet = yield* pushDevice("Tablet");
    // Whichever goes first, the other device is revoked while it is on its way.
    yield* service.answer([
      {
        _tag: "take-after",
        before: (message) =>
          auth.revoke(message.data.deviceId === phone ? tablet : phone).pipe(Effect.orDie),
      },
    ]);
    yield* says(scout.id, "Done");
    yield* deliverPending;
    yield* deliverPending;

    assert.strictEqual((yield* sends).length, 1);
    // The revoked device's delivery is gone; the other waits for its receipt.
    assert.deepStrictEqual(yield* deliveries, [{ status: "accepted", attempts: 1 }]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("never sends past a delivery's deadline, even when it passed during the pass", () =>
  Effect.gen(function* () {
    const service = yield* TestPushService;
    const scout = yield* createBot("Scout");
    yield* pushDevice("Phone");
    yield* pushDevice("Tablet");
    // The first send takes longer than the other's deadline leaves.
    yield* service.answer([{ _tag: "take-after", before: () => TestClock.adjust("2 hours") }]);
    yield* says(scout.id, "Done");
    yield* deliverPending;
    yield* deliverPending;

    assert.strictEqual((yield* sends).length, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "follows the settings at each send: no preview turned off since, nothing once notifications are off",
  () =>
    Effect.gen(function* () {
      const service = yield* TestPushService;
      const settings = yield* SettingsService;
      const notify = (enabled: boolean, previews: boolean, n: number) =>
        settings.update({
          commandId: CommandId.make(`notifications-${n}`),
          changes: { notifications: { enabled, previews } },
        });
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      yield* notify(true, true, 1);
      yield* service.answer([new PushUnavailable({ reason: "HTTP 503" })]);

      // Written with its preview; previews are off by its second send.
      yield* says(scout.id, "The launch codes are 1234");
      yield* deliverPending;
      yield* notify(true, false, 2);
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;
      const [first, second] = yield* sends;
      assert.strictEqual(first?.body, "The launch codes are 1234");
      assert.deepStrictEqual([second?.title, second?.body], ["Scout", "Sent you a message"]);
      assert.notInclude(JSON.stringify(second), "launch codes");

      // Written while notifications were on; they are off by its second send.
      yield* service.answer([new PushUnavailable({ reason: "HTTP 503" })]);
      yield* settings.update({
        commandId: CommandId.make("notifications-3"),
        changes: { notifications: { enabled: true, previews: false } },
      });
      yield* says(scout.id, "The build is green");
      yield* deliverPending;
      yield* notify(false, false, 4);
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;
      assert.strictEqual((yield* sends).length, 3);
      // Only the first entry's delivery is left, waiting for its receipt.
      assert.deepStrictEqual(yield* deliveries, [{ status: "accepted", attempts: 2 }]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("adds the entry and pushes the others when a device's registration cannot be read", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scout = yield* createBot("Scout");
    const phone = yield* pushDevice("Phone");
    const tablet = yield* pushDevice("Tablet");
    // A language this server no longer knows.
    yield* sql`UPDATE push_registrations SET language = 'tlh' WHERE device_id = ${phone}`;

    yield* says(scout.id, "Done");
    yield* deliverPending;

    assert.deepStrictEqual(
      (yield* sends).map((message) => message.data.deviceId),
      [tablet],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "logs a delivery it cannot read by its id and the failure's tag, not by the failure's text",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TestPushService;
      yield* service.answer([new PushUnavailable({ reason: "HTTP 503" })]);
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      yield* says(scout.id, "Done");
      yield* deliverPending;
      yield* sql`UPDATE push_deliveries SET attempts = 'unreadable'`;
      const [delivery] = yield* sql<{ readonly id: string }>`SELECT id FROM push_deliveries`;

      logged.length = 0;
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;

      const handled = logged.filter((line) => line.includes("A push could not be handled"));
      assert.lengthOf(handled, 1);
      assert.include(handled[0], `"deliveryId":"${delivery?.id}"`);
      assert.include(handled[0], `"failure":"SchemaError"`);
      assert.strictEqual((yield* sends).length, 1);
    }).pipe(Effect.provide(Layer.provideMerge(TestDomain.layer, recordLogs))),
);

it.effect("gives a delivery up once its sends run out", () =>
  Effect.gen(function* () {
    const service = yield* TestPushService;
    yield* service.answer(
      Array.from({ length: MAX_ATTEMPTS }, () => new PushUnavailable({ reason: "HTTP 503" })),
    );
    const scout = yield* createBot("Scout");
    const phone = yield* pushDevice("Phone");
    yield* says(scout.id, "Done");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      yield* deliverPending;
      yield* TestClock.adjust(sendBackoff(attempt));
    }
    yield* deliverPending;

    assert.strictEqual((yield* sends).length, MAX_ATTEMPTS);
    assert.deepStrictEqual(yield* deliveries, []);
    assert.strictEqual(yield* failuresOf(phone), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("drops a delivery whose deadline passed while the server was down", () =>
  Effect.gen(function* () {
    const service = yield* TestPushService;
    yield* service.answer([new PushUnavailable({ reason: "HTTP 503" })]);
    yield* Effect.gen(function* () {
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      yield* says(scout.id, "Done");
      yield* deliverPending;
      assert.deepStrictEqual(yield* deliveries, [{ status: "pending", attempts: 1 }]);
    }).pipe(Effect.provide(Domain.layer));

    yield* TestClock.adjust("2 hours");
    yield* Effect.gen(function* () {
      yield* deliverPending;
      assert.deepStrictEqual(yield* deliveries, []);
    }).pipe(Effect.provide(Domain.layer));
    assert.strictEqual((yield* sends).length, 1);
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("drops each delivery past its deadline, also next to one that cannot be read", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* TestPushService;
    yield* service.answer([
      new PushUnavailable({ reason: "HTTP 503" }),
      new PushUnavailable({ reason: "HTTP 503" }),
    ]);
    const scout = yield* createBot("Scout");
    const phone = yield* pushDevice("Phone");
    yield* pushDevice("Tablet");
    yield* says(scout.id, "Done");
    yield* deliverPending;
    yield* sql`
      UPDATE push_deliveries SET token = 'fictional unreadable token' WHERE device_id = ${phone}
    `;

    yield* TestClock.adjust("2 hours");
    yield* deliverPending;
    assert.deepStrictEqual(yield* deliveries, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);
