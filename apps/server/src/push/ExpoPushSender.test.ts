// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, type DeviceId, type Language, PushToken } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
import { PushWorker, RECEIPT_DELAY, sendBackoff } from "./PushWorker.ts";

/** A message as it reached Expo. */
const Sent = Schema.Struct({
  to: Schema.String,
  title: Schema.String,
  body: Schema.String,
  data: Schema.Struct({ deviceId: Schema.String, entryId: Schema.String }),
  tag: Schema.optional(Schema.String),
  collapseId: Schema.optional(Schema.String),
});
type Sent = typeof Sent.Type;
const decodeSends = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Tuple([Sent])));
const decodeAsked = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ids: Schema.Array(Schema.String) })),
);

/** How Expo answers: an HTTP status and a JSON body. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const taken = (id: string): Answer => ({ status: 200, body: { data: [{ status: "ok", id }] } });

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
    readonly sends: Array<Sent>;
    readonly asked: Array<ReadonlyArray<string>>;
    /** The answer to a send, from its message; `undefined` takes it. */
    send: (message: Sent, n: number) => Answer | undefined;
    /** The receipt of `id`; `undefined` reports it handed on. */
    receipt: (id: string) => unknown;
  }
>()("@j3-bots/server/push/ExpoPushSender.test/ExpoWire") {}

const wire = Layer.effectContext(
  Effect.sync(() => {
    const state = ExpoWire.of({
      sends: [],
      asked: [],
      send: () => undefined,
      receipt: () => undefined,
    });
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const answer = ((): Answer => {
          if (url.pathname === "/--/api/v2/push/send") {
            const [message] = decodeSends(text);
            state.sends.push(message);
            return (
              state.send(message, state.sends.length) ?? taken(`receipt-${state.sends.length}`)
            );
          }
          const { ids } = decodeAsked(text);
          state.asked.push(ids);
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

const pushDevice = (name: string, language: Language = "en") =>
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
    assert.deepStrictEqual(second?.to, "ExponentPushToken[fixture-Phone]");

    yield* TestClock.adjust(RECEIPT_DELAY);
    yield* deliverPending;
    assert.deepStrictEqual(expo.asked, [["receipt-2"]]);
    yield* TestClock.adjust(RECEIPT_DELAY);
    yield* deliverPending;
    // Handed on: nothing is asked about it again.
    assert.strictEqual(expo.asked.length, 1);
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
      expo.send = (message, n) =>
        message.to === "ExponentPushToken[fixture-Phone]"
          ? { status: 200, body: { data: [notRegistered] } }
          : taken(`tablet-${n}`);
      expo.receipt = (id) => (id.startsWith("tablet-") ? notRegistered : undefined);

      yield* says(scout.id, "Done");
      yield* deliverPending;
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
