// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, type DeviceId, PushToken } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { Devices } from "../devices/Devices.ts";
import * as Domain from "../domain.ts";
import { Entries } from "../entries/Entries.ts";
import { Presence } from "../presence/Presence.ts";
import * as TestDomain from "../testing/domain.ts";
import { TestPushService } from "../testing/push.ts";
import { until } from "../testing/turns.ts";
import { PushUnavailable } from "./PushSender.ts";
import { MAX_ATTEMPTS, PushWorker, RECEIPT_DELAY, sendBackoff } from "./PushWorker.ts";

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
  "sends again with the same key after a crash between a send and its record, so the device shows it once",
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

      const [first, second] = yield* sends;
      assert.strictEqual(second?.key, first?.key);
      assert.strictEqual((yield* service.shown).length, 1);
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
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
