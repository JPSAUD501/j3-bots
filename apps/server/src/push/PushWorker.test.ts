// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  CommandId,
  type DeviceId,
  type EntryTarget,
  PushToken,
} from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
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
import { PushRejected, PushUnavailable, PushUnregistered } from "./PushSender.ts";
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
        _tag: "after",
        before: (message) =>
          auth.revoke(message.data.deviceId === phone ? tablet : phone).pipe(Effect.orDie),
        answer: "take",
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
    yield* service.answer([
      { _tag: "after", before: () => TestClock.adjust("2 hours"), answer: "take" },
    ]);
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

it.effect(
  "words a send by the settings as its claim leaves them: no preview, or no send, once turned off",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* SettingsService;
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      yield* settings.update({
        commandId: CommandId.make("notifications-on"),
        changes: { notifications: { enabled: true, previews: true } },
      });
      // A change to the settings that commits with the claim, as one committed
      // between the pass reading the delivery and claiming its send.
      const changeWithClaim = (change: string) =>
        sql.unsafe(`
          CREATE TRIGGER change_with_claim AFTER UPDATE OF attempts ON push_deliveries
          BEGIN UPDATE settings SET ${change} WHERE id = 1; END
        `);

      yield* changeWithClaim("notification_previews = 0");
      yield* says(scout.id, "The launch codes are 1234");
      yield* deliverPending;
      assert.deepStrictEqual(
        (yield* sends).map((message) => message.body),
        ["Sent you a message"],
      );

      yield* sql`DROP TRIGGER change_with_claim`;
      yield* changeWithClaim("notifications_enabled = 0");
      yield* says(scout.id, "The build is green");
      yield* deliverPending;
      assert.strictEqual((yield* sends).length, 1);
      // Only the first entry's delivery is left, waiting for its receipt.
      assert.deepStrictEqual(yield* deliveries, [{ status: "accepted", attempts: 1 }]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "adds a bot's entry when who hears of it cannot be worked out, logging why by the failure's tag",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const entries = yield* Entries;
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      // Settings that cannot be read.
      yield* sql`UPDATE settings SET time_zone = '' WHERE id = 1`;

      logged.length = 0;
      const entry = yield* says(scout.id, "Done");

      const target: EntryTarget = { _tag: "conversation", botId: scout.id };
      assert.deepStrictEqual(
        (yield* entries.latest(target, 1)).map(({ id }) => id),
        [entry.id],
      );
      const changed = yield* sql`SELECT 1 FROM changes WHERE entity_id = ${entry.id}`;
      assert.lengthOf(changed, 1);
      const handled = logged.filter((line) =>
        line.includes("The notification of an entry could not be handled"),
      );
      assert.lengthOf(handled, 1);
      assert.include(handled[0], `"entryId":"${entry.id}"`);
      assert.include(handled[0], `"failure":"SchemaError"`);
      assert.deepStrictEqual(yield* deliveries, []);
    }).pipe(Effect.provide(Layer.provideMerge(TestDomain.layer, recordLogs))),
);

it.effect(
  "stops sending for the pass when the service does not answer, sparing the others' attempts but not the receipts",
  () =>
    Effect.gen(function* () {
      const service = yield* TestPushService;
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      yield* pushDevice("Tablet");
      yield* says(scout.id, "Done");
      yield* deliverPending;
      assert.deepStrictEqual(yield* deliveries, [
        { status: "accepted", attempts: 1 },
        { status: "accepted", attempts: 1 },
      ]);

      // Both receipts are due when the service stops answering sends.
      yield* TestClock.adjust(RECEIPT_DELAY);
      yield* service.answer([new PushUnavailable({ reason: "timed out" })]);
      yield* says(scout.id, "The build is green");
      yield* deliverPending;

      assert.strictEqual((yield* sends).length, 3);
      // The receipts were read; of the sends, one began, the other waits unspent.
      assert.sameDeepMembers(
        [...(yield* deliveries)],
        [
          { status: "pending", attempts: 1 },
          { status: "pending", attempts: 0 },
        ],
      );
      // It waits as long as the send that was not answered.
      yield* deliverPending;
      assert.strictEqual((yield* sends).length, 3);
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;
      assert.strictEqual((yield* sends).length, 5);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds every send, one written since included, until the service may be tried again, across a restart",
  () =>
    Effect.gen(function* () {
      const service = yield* TestPushService;
      yield* service.answer([new PushUnavailable({ reason: "HTTP 429" })]);
      const scoutId = yield* Effect.gen(function* () {
        const scout = yield* createBot("Scout");
        yield* pushDevice("Phone");
        yield* says(scout.id, "Done");
        yield* deliverPending;
        return scout.id;
      }).pipe(Effect.provide(Domain.layer));

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        yield* says(scoutId, "The build is green");
        yield* deliverPending;
        assert.strictEqual((yield* sends).length, 1);
        yield* TestClock.adjust(sendBackoff(1));
        yield* deliverPending;
      }).pipe(Effect.provide(Domain.layer));

      assert.strictEqual((yield* sends).length, 3);
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "stops sending once a pass spent its time, and the next reads a receipt come due before sending more",
  () =>
    Effect.gen(function* () {
      const service = yield* TestPushService;
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone");
      yield* says(scout.id, "Done");
      yield* deliverPending;
      assert.deepStrictEqual(yield* deliveries, [{ status: "accepted", attempts: 1 }]);

      // Five sends of 29 seconds each, starting a minute before the receipt is due.
      for (const name of ["Tablet", "Laptop", "Watch", "Television"]) yield* pushDevice(name);
      yield* TestClock.adjust(Duration.subtract(RECEIPT_DELAY, Duration.minutes(1)));
      yield* service.answer(
        Array.from({ length: 5 }, () => ({
          _tag: "after" as const,
          before: () => TestClock.adjust("29 seconds"),
          answer: "take" as const,
        })),
      );
      yield* says(scout.id, "The build is green");
      yield* deliverPending;
      yield* deliverPending;

      assert.strictEqual((yield* sends).length, 6);
      // Asked once the first pass stopped, after three of the five sends.
      assert.deepStrictEqual(yield* service.receiptsAsked, [4]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps a registration made again in the millisecond a send to the one before it began",
  () =>
    Effect.gen(function* () {
      const service = yield* TestPushService;
      const devices = yield* Devices;
      const scout = yield* createBot("Scout");
      const phone = yield* pushDevice("Phone");
      // The app registers again, with the same token, while each send is on
      // its way; the clock does not move.
      const registerAgain = (n: number) => () =>
        devices
          .registerPush({
            commandId: CommandId.make(`register-again-${n}`),
            deviceId: phone,
            registration: {
              provider: "expo",
              token: PushToken.make("ExponentPushToken[fixture-Phone]"),
              platform: "android",
              language: "en",
            },
          })
          .pipe(Effect.orDie);
      yield* service.answer([
        { _tag: "after", before: registerAgain(1), answer: new PushUnregistered() },
        { _tag: "after", before: registerAgain(2), answer: new PushRejected({ reason: "test" }) },
      ]);

      yield* says(scout.id, "Done");
      yield* deliverPending;
      yield* says(scout.id, "The build is green");
      yield* deliverPending;

      assert.strictEqual((yield* sends).length, 2);
      assert.deepStrictEqual(
        (yield* devices.paired).map(({ id, pushRegistered }) => [id, pushRegistered]),
        [[phone, true]],
      );
      assert.strictEqual(yield* failuresOf(phone), 0);
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
    yield* service.answer([new PushUnavailable({ reason: "HTTP 503" })]);
    const scout = yield* createBot("Scout");
    const phone = yield* pushDevice("Phone");
    yield* pushDevice("Tablet");
    yield* says(scout.id, "Done");
    yield* deliverPending;
    yield* sql`
      UPDATE push_deliveries SET attempts = 'unreadable', generation = 'fictional'
      WHERE device_id = ${phone}
    `;

    yield* TestClock.adjust("2 hours");
    yield* deliverPending;
    assert.deepStrictEqual(yield* deliveries, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);
