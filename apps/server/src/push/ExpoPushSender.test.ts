// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  CommandId,
  type DeviceId,
  type Language,
  PushData,
  type PushPlatform,
  PushToken,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { Devices } from "../devices/Devices.ts";
import * as Domain from "../domain.ts";
import { Entries } from "../entries/Entries.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import * as ExpoPushSender from "./ExpoPushSender.ts";
import { PushReceiptId, PushSender } from "./PushSender.ts";
import { PushWorker, RECEIPT_DELAY, sendBackoff } from "./PushWorker.ts";

/** A message as it reached Expo, its data as the app decodes it. */
const Sent = Schema.Struct({
  to: Schema.String,
  title: Schema.String,
  body: Schema.String,
  data: PushData,
  tag: Schema.optional(Schema.String),
  collapseId: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String),
});
type Sent = typeof Sent.Type;
const decodeSends = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Sent)));
const decodeAsked = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ids: Schema.Array(Schema.String) })),
);

/** How Expo answers: an HTTP status and a JSON body. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const taken = (id: string) => ({ status: "ok", id });

const refused = (error: string) => ({
  status: "error",
  message: "fictional message that would quote the token",
  details: { error },
});

const notRegistered = {
  status: "error",
  message: "fictional message that would quote the token",
  details: { error: "DeviceNotRegistered" },
};

/**
 * Expo's push API as the network delivers it: every request is recorded, and
 * answered as the test says, by default taking each message and reporting
 * each receipt handed on.
 */
class ExpoWire extends Context.Service<
  ExpoWire,
  {
    /** Every message sent, in order. */
    readonly sends: Array<Sent>;
    /** How many messages each request to send carried, in order. */
    readonly requests: Array<number>;
    readonly asked: Array<ReadonlyArray<string>>;
    /** The answer to the `n`th request to send, from its messages; `undefined` answers each message. */
    send: (messages: ReadonlyArray<Sent>, n: number) => Answer | undefined;
    /** The ticket of the `n`th message sent; `undefined` takes it. */
    ticket: (message: Sent, n: number) => unknown;
    /** The receipt of `id`; `undefined` reports it handed on. */
    receipt: (id: string) => unknown;
    /** The answer to the `n`th request for receipts; `undefined` answers each id. */
    asking: (n: number) => Answer | undefined;
  }
>()("@j3-bots/server/push/ExpoPushSender.test/ExpoWire") {}

const wire = Layer.effectContext(
  Effect.sync(() => {
    const state = ExpoWire.of({
      sends: [],
      requests: [],
      asked: [],
      send: () => undefined,
      ticket: () => undefined,
      receipt: () => undefined,
      asking: () => undefined,
    });
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const answer = ((): Answer => {
          if (url.pathname === "/--/api/v2/push/send") {
            const messages = decodeSends(text);
            state.requests.push(messages.length);
            const tickets = messages.map((message) => {
              state.sends.push(message);
              const n = state.sends.length;
              return state.ticket(message, n) ?? taken(`receipt-${n}`);
            });
            return (
              state.send(messages, state.requests.length) ?? {
                status: 200,
                body: { data: tickets },
              }
            );
          }
          const { ids } = decodeAsked(text);
          state.asked.push(ids);
          const asking = state.asking(state.asked.length);
          if (asking !== undefined) return asking;
          return {
            status: 200,
            body: {
              data: Object.fromEntries(
                ids.map((id) => [id, state.receipt(id) ?? { status: "ok" }]),
              ),
            },
          };
        })();
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
    return Context.make(ExpoWire, state).pipe(Context.add(HttpClient.HttpClient, client));
  }),
);

const createBot = (name: string) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    return yield* bots.create({ commandId: CommandId.make(`create-${name}`), draft: { name } });
  });

const pushDevice = (name: string, language: Language = "en", platform: PushPlatform = "android") =>
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
        platform,
        language,
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

const register = (deviceId: DeviceId, name: string, n: number) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    yield* devices.registerPush({
      commandId: CommandId.make(`register-again-${n}`),
      deviceId,
      registration: {
        provider: "expo",
        token: PushToken.make(`ExponentPushToken[fixture-${name}]`),
        platform: "android",
        language: "en",
      },
    });
  });

const failuresOf = (deviceId: DeviceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly failures: number }>`
      SELECT failures FROM push_registrations WHERE device_id = ${deviceId}
    `;
    return rows[0]?.failures;
  });

const pending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly id: string }>`SELECT id FROM push_deliveries`;
});

/** Every line logged where `recordLogs` is provided, as JSON. */
const logged: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.map(Logger.formatJson, (line) => {
    logged.push(line);
  }),
]);

const pushOn = (deviceId: DeviceId) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const [listed] = (yield* devices.list(deviceId)).filter((device) => device.id === deviceId);
    return listed?.pushRegistered;
  });

const previews = (on: boolean, n: number) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    yield* settings.update({
      commandId: CommandId.make(`previews-${n}`),
      changes: { notifications: { enabled: true, previews: on } },
    });
  });

/** The domain sending through Expo's API, over `wire`. */
const domain = Domain.layer.pipe(
  Layer.provideMerge(TestDomain.machineWith(ExpoPushSender.layer)),
  Layer.provideMerge(wire),
);

it.effect("sends again after a 5xx, then reads the receipt and lets the delivery go", () =>
  Effect.gen(function* () {
    const expo = yield* ExpoWire;
    expo.send = (_, n) => (n === 1 ? { status: 503, body: {} } : undefined);
    const scout = yield* createBot("Scout");
    yield* pushDevice("Phone");
    yield* says(scout.id, "Done");
    yield* deliverPending;
    assert.strictEqual(expo.sends.length, 1);

    yield* TestClock.adjust(sendBackoff(1));
    yield* deliverPending;
    const [first, second] = expo.sends;
    // The same message, tagged with its delivery so a repeat replaces it on the phone.
    assert.deepStrictEqual(second, first);
    assert.isString(second?.tag);
    assert.isUndefined(second?.collapseId);
    // In the Android channel the app made for a bot's messages.
    assert.strictEqual(second?.channelId, "message");
    assert.deepStrictEqual(second?.to, "ExponentPushToken[fixture-Phone]");
    // A tap opens the conversation it is about.
    assert.deepStrictEqual(second?.data.target, { _tag: "conversation", botId: scout.id });

    yield* TestClock.adjust(RECEIPT_DELAY);
    yield* deliverPending;
    assert.deepStrictEqual(expo.asked, [["receipt-2"]]);
    yield* TestClock.adjust(RECEIPT_DELAY);
    yield* deliverPending;
    // Handed on: nothing is asked about it again.
    assert.strictEqual(expo.asked.length, 1);
  }).pipe(Effect.provide(domain)),
);

it.effect("sends to an iPhone with the delivery as its collapse id, in no Android channel", () =>
  Effect.gen(function* () {
    const expo = yield* ExpoWire;
    const scout = yield* createBot("Scout");
    yield* pushDevice("iPhone", "en", "ios");
    yield* says(scout.id, "Done");
    yield* deliverPending;
    const [sent] = expo.sends;
    assert.isString(sent?.collapseId);
    assert.isUndefined(sent?.tag);
    assert.isUndefined(sent?.channelId);
  }).pipe(Effect.provide(domain)),
);

it.effect(
  "ends the registration of a device Expo says it no longer reaches, from a ticket or a receipt",
  () =>
    Effect.gen(function* () {
      const expo = yield* ExpoWire;
      const scout = yield* createBot("Scout");
      const phone = yield* pushDevice("Phone");
      const tablet = yield* pushDevice("Tablet");
      expo.ticket = (message, n) =>
        message.to === "ExponentPushToken[fixture-Phone]" ? notRegistered : taken(`tablet-${n}`);
      expo.receipt = (id) => (id.startsWith("tablet-") ? notRegistered : undefined);

      yield* says(scout.id, "Done");
      yield* deliverPending;
      // Both in one request, each answered by its own ticket.
      assert.deepStrictEqual(expo.requests, [2]);
      assert.isFalse(yield* pushOn(phone));
      assert.isTrue(yield* pushOn(tablet));

      yield* TestClock.adjust(RECEIPT_DELAY);
      yield* deliverPending;
      assert.isFalse(yield* pushOn(tablet));

      // Neither is pushed to again.
      yield* says(scout.id, "Anyone there?");
      yield* deliverPending;
      assert.strictEqual(expo.sends.length, 2);
    }).pipe(Effect.provide(domain)),
);

it.effect(
  "words a push as the settings were when the entry was added, with no text of it while previews are off",
  () =>
    Effect.gen(function* () {
      const expo = yield* ExpoWire;
      const scout = yield* createBot("Scout");
      yield* pushDevice("Phone", "pt-BR");
      // The first send fails, so the second comes after previews are on.
      expo.send = (_, n) => (n === 1 ? { status: 502, body: {} } : undefined);

      yield* says(scout.id, "The launch codes are 1234");
      yield* deliverPending;
      yield* previews(true, 1);
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;
      yield* says(scout.id, "The build is green");
      yield* deliverPending;

      assert.deepStrictEqual(
        expo.sends.map(({ title, body }) => [title, body]),
        [
          ["Scout", "Enviou uma mensagem"],
          ["Scout", "Enviou uma mensagem"],
          ["Scout", "The build is green"],
        ],
      );
      assert.notInclude(JSON.stringify(expo.sends.slice(0, 2)), "launch codes");
    }).pipe(Effect.provide(domain)),
);

it.effect(
  "keeps a registration made again after a send when that send's receipt says the device is gone or failed",
  () =>
    Effect.gen(function* () {
      const expo = yield* ExpoWire;
      const scout = yield* createBot("Scout");
      const phone = yield* pushDevice("Phone");
      const tablet = yield* pushDevice("Tablet");
      expo.ticket = (message, n) =>
        taken(message.to === "ExponentPushToken[fixture-Phone]" ? `phone-${n}` : `tablet-${n}`);
      expo.receipt = (id) => (id.startsWith("phone-") ? notRegistered : refused("MessageTooBig"));

      yield* says(scout.id, "Done");
      yield* deliverPending;
      // Both register again, with the same tokens, before the receipts are read.
      yield* TestClock.adjust("1 minute");
      yield* register(phone, "Phone", 1);
      yield* register(tablet, "Tablet", 2);
      yield* TestClock.adjust(RECEIPT_DELAY);
      yield* deliverPending;

      assert.deepStrictEqual(yield* pending, []);
      assert.isTrue(yield* pushOn(phone));
      assert.strictEqual(yield* failuresOf(tablet), 0);
    }).pipe(Effect.provide(domain)),
);

it.effect(
  "sends again when Expo's ticket says too many went to the device, and drops a receipt that says so",
  () =>
    Effect.gen(function* () {
      const expo = yield* ExpoWire;
      const scout = yield* createBot("Scout");
      const phone = yield* pushDevice("Phone");
      expo.ticket = (_, n) => (n === 1 ? refused("MessageRateExceeded") : undefined);
      expo.receipt = () => refused("MessageRateExceeded");

      yield* says(scout.id, "Done");
      yield* deliverPending;
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;
      assert.strictEqual(expo.sends.length, 2);

      yield* TestClock.adjust(RECEIPT_DELAY);
      yield* deliverPending;
      // Its words are gone, so it is not sent again, and the device is not counted as failing.
      assert.deepStrictEqual(yield* pending, []);
      assert.strictEqual(expo.sends.length, 2);
      assert.strictEqual(yield* failuresOf(phone), 0);
    }).pipe(Effect.provide(domain)),
);

it.effect("logs an error Expo does not document by a fixed reason, never by what Expo sent", () =>
  Effect.gen(function* () {
    const expo = yield* ExpoWire;
    const scout = yield* createBot("Scout");
    yield* pushDevice("Phone");
    expo.ticket = () => refused("Fictional ExponentPushToken[fixture-Phone]");

    yield* says(scout.id, "Done");
    yield* deliverPending;

    const lines = logged.join("\n");
    assert.include(lines, "A push was not delivered");
    assert.include(lines, "undocumented error");
    assert.notInclude(lines, "fixture-Phone");
  }).pipe(Effect.provide(Layer.provideMerge(domain, recordLogs))),
);

it.effect(
  "gives up each push of a request Expo refuses as a whole, and none Expo answered for fewer",
  () =>
    Effect.gen(function* () {
      const expo = yield* ExpoWire;
      const scout = yield* createBot("Scout");
      const phone = yield* pushDevice("Phone");
      const tablet = yield* pushDevice("Tablet");

      // Fewer tickets than messages: none can be told apart, so both wait.
      expo.send = () => ({ status: 200, body: { data: [taken("receipt-1")] } });
      yield* says(scout.id, "Done");
      yield* deliverPending;
      assert.lengthOf(yield* pending, 2);
      assert.strictEqual(yield* failuresOf(phone), 0);

      expo.send = () => ({ status: 401, body: { errors: [{ code: "UNAUTHORIZED" }] } });
      yield* TestClock.adjust(sendBackoff(1));
      yield* deliverPending;
      assert.deepStrictEqual(expo.requests, [2, 2]);
      assert.deepStrictEqual(yield* pending, []);
      assert.strictEqual(yield* failuresOf(phone), 1);
      assert.strictEqual(yield* failuresOf(tablet), 1);
    }).pipe(Effect.provide(domain)),
);

it.effect("sends each push alone when Expo refuses a request for apps of two projects", () =>
  Effect.gen(function* () {
    const expo = yield* ExpoWire;
    const scout = yield* createBot("Scout");
    const phone = yield* pushDevice("Phone");
    yield* pushDevice("Tablet");
    expo.send = (messages) =>
      messages.length > 1
        ? { status: 400, body: { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] } }
        : undefined;

    yield* says(scout.id, "Done");
    yield* deliverPending;

    assert.deepStrictEqual(expo.requests, [2, 1, 1]);
    // Both were taken, and wait for their receipts.
    assert.lengthOf(yield* pending, 2);
    assert.strictEqual(yield* failuresOf(phone), 0);
  }).pipe(Effect.provide(domain)),
);

it.effect("keeps the receipts Expo answered when a later request for others fails", () =>
  Effect.gen(function* () {
    const expo = yield* ExpoWire;
    const sender = yield* PushSender;
    expo.asking = (n) => (n === 2 ? { status: 503, body: {} } : undefined);
    const ids = Array.from({ length: 1001 }, (_, n) => PushReceiptId.make(`receipt-${n}`));

    const answers = yield* sender.receipts(ids);

    assert.strictEqual(expo.asked.length, 2);
    assert.strictEqual(answers.size, 1000);
    assert.isUndefined(answers.get(PushReceiptId.make("receipt-1000")));
  }).pipe(Effect.provide(ExpoPushSender.layer.pipe(Layer.provideMerge(wire)))),
);
