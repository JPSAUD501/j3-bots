// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  ModelId,
  SentTelemetryEvent,
  type TelemetryClient,
  type TelemetryEvent,
  TelemetryModel,
  telemetryIdHash,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as Ports from "../system/Ports.ts";
import * as TestDatabase from "../testing/database.ts";
import { SERVER } from "../testing/telemetry.ts";
import { DEFAULT_TELEMETRY_KEY, type TelemetryHold } from "./environment.ts";
import {
  type DeliveryTiming,
  layer as telemetryLayer,
  MAX_BATCH_ATTEMPTS,
  Telemetry,
  TelemetryConfig,
} from "./Telemetry.ts";
import * as TelemetryStore from "./TelemetryStore.ts";
import { TelemetrySwitch } from "./TelemetrySwitch.ts";

// Delivery against a fake PostHog capture endpoint on loopback: nothing in
// these tests reaches the network.

/** How the fake endpoint answers the next batch. */
type Answer = "accept" | "fail" | "refuse" | "hang";

/** A batch as PostHog's `/batch/` takes it, decoded strictly: a property the contract does not declare fails it. */
const Batch = Schema.Struct({
  api_key: Schema.String,
  batch: Schema.Array(Schema.toCodecJson(SentTelemetryEvent)),
});
type Batch = typeof Batch.Type;
const decodeBatch = Schema.decodeUnknownEffect(Batch, { onExcessProperty: "error" });

class Capture extends Context.Service<
  Capture,
  {
    readonly origin: string;
    readonly batches: Queue.Queue<Batch>;
    readonly answer: Ref.Ref<Answer>;
  }
>()("@j3-bots/server/telemetry/Telemetry.test/Capture") {}

const captureLayer = Layer.unwrap(
  Effect.gen(function* () {
    const batches = yield* Queue.unbounded<Batch>();
    const answer = yield* Ref.make<Answer>("accept");
    const route = HttpRouter.add(
      "POST",
      "/batch/",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const batch = yield* request.json.pipe(Effect.flatMap(decodeBatch), Effect.orDie);
        yield* Queue.offer(batches, batch);
        switch (yield* Ref.get(answer)) {
          case "accept":
            return HttpServerResponse.jsonUnsafe({ status: "Ok" });
          case "fail":
            return HttpServerResponse.empty({ status: 503 });
          case "refuse":
            return HttpServerResponse.empty({ status: 400 });
          case "hang":
            return yield* Effect.sleep("2 seconds").pipe(Effect.as(HttpServerResponse.empty()));
        }
      }),
    );
    const served = Ports.serve(route, NodeHttpServer.layerTest, { logAddress: false });
    return Layer.effect(
      Capture,
      Effect.gen(function* () {
        const { address } = yield* HttpServer.HttpServer;
        if (!NetAddress.isInetAddress(address)) return yield* Effect.die("not an IP listener");
        return Capture.of({ origin: `http://127.0.0.1:${address.port}`, batches, answer });
      }),
    ).pipe(Layer.provide(served));
  }),
);

/** Quick enough for a test, slow enough that a test sees each step. */
const TIMING: DeliveryTiming = {
  interval: 20,
  sendTimeout: 1_000,
  shutdownFlush: 300,
  retryBase: 10,
  retryMax: 40,
};

/** Waits for no automatic send: only the stop's flush sends. */
const AT_STOP: DeliveryTiming = { ...TIMING, interval: 3_600_000 };

/** The usage data of a server whose environment holds it as `hold`, behind a switch the test turns. */
const start = (options: {
  readonly timing: DeliveryTiming;
  readonly hold?: TelemetryHold;
  readonly key?: string;
}) =>
  Effect.gen(function* () {
    const capture = yield* Capture;
    const on = yield* SubscriptionRef.make(true);
    const config = Layer.succeed(
      TelemetryConfig,
      TelemetryConfig.of({
        environment: {
          hold: options.hold ?? null,
          host: capture.origin,
          key: options.key ?? DEFAULT_TELEMETRY_KEY,
        },
        server: Effect.succeed(SERVER),
      }),
    );
    const onOff = Layer.succeed(
      TelemetrySwitch,
      TelemetrySwitch.of({
        enabled: SubscriptionRef.get(on),
        changes: SubscriptionRef.changes(on).pipe(Stream.changes),
        refresh: Effect.void,
      }),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      telemetryLayer(options.timing).pipe(
        Layer.provide([config, onOff, TelemetryStore.layer, FetchHttpClient.layer]),
      ),
      scope,
    );
    return {
      telemetry: Context.get(context, Telemetry),
      turn: (enabled: boolean) => SubscriptionRef.set(on, enabled),
      stop: Scope.close(scope, Exit.void),
    };
  });

const next = Effect.flatMap(Capture, (capture) => Queue.take(capture.batches));
const answer = (value: Answer) =>
  Effect.flatMap(Capture, (capture) => Ref.set(capture.answer, value));
const nothingSent = Effect.gen(function* () {
  assert.strictEqual(yield* Queue.size((yield* Capture).batches), 0);
});

const started: Extract<TelemetryEvent, { readonly event: "server.started" }> = {
  event: "server.started",
  properties: {},
};
type FeatureUsed = Extract<TelemetryEvent, { readonly event: "feature.used" }>;
const used = (feature: FeatureUsed["properties"]["feature"]): FeatureUsed => ({
  event: "feature.used",
  properties: { feature },
});

const featureOf = (sent: SentTelemetryEvent) =>
  sent.event === "feature.used" ? sent.properties.feature : null;

const PHONE: TelemetryClient = {
  surface: "android",
  version: "0.14.0",
  os: "android",
  device: telemetryIdHash("a-phone-s-random-id"),
};

/** One of every event, with the properties a server would give it. */
const EVERY_EVENT: {
  readonly [Name in TelemetryEvent["event"]]: Extract<TelemetryEvent, { event: Name }>;
} = {
  "server.started": started,
  "client.connected": { event: "client.connected", properties: {} },
  "install.active": {
    event: "install.active",
    properties: { bots: "2-3", rooms: "1", routines: "0", connectors: "11+" },
  },
  "turn.finished": {
    event: "turn.finished",
    properties: {
      harness: "claude-code",
      model: TelemetryModel.make(ModelId.make("claude-opus-5-5")),
      effort: "high",
      origin: "conversation",
      outcome: "failed",
      failure: "usage-limit",
      durationSeconds: 42,
    },
  },
  "message.sent": {
    event: "message.sent",
    properties: { place: "room", mention: true, reply: false, quote: true, attachments: false },
  },
  "bot.created": {
    event: "bot.created",
    properties: { harness: "codex", fromTemplate: true, by: "operator" },
  },
  "room.created": { event: "room.created", properties: { members: "2-3", by: "bot" } },
  "routine.ran": { event: "routine.ran", properties: { outcome: "delivered" } },
  "connector.added": { event: "connector.added", properties: { source: "catalog" } },
  "connector.removed": {
    event: "connector.removed",
    properties: { source: "custom", hasApp: true },
  },
  "connector-app.shown": { event: "connector-app.shown", properties: { displayMode: "pip" } },
  "update.applied": {
    event: "update.applied",
    properties: { from: "0.13.0", to: "0.14.0", outcome: "rolled-back", failure: "health-check" },
  },
  "feature.used": used("voice-input"),
  "request.failed": {
    event: "request.failed",
    properties: { error: "Conflict", code: "engine-unavailable" },
  },
};

const layer = captureLayer.pipe(Layer.provideMerge(TestDatabase.layer));

it.layer(layer, { excludeTestServices: true })("usage data", (it) => {
  it.effect(
    "sends every event with the server's dimensions, and nothing its schema does not declare",
    () =>
      Effect.gen(function* () {
        const { telemetry, stop } = yield* start({ timing: AT_STOP });
        for (const event of Object.values(EVERY_EVENT)) yield* telemetry.record(event);
        // A property no event declares, as a careless caller could pass: it never leaves.
        const leaked = { text: "what the operator wrote" };
        const careless: TelemetryEvent = { event: "server.started", properties: leaked };
        yield* telemetry.record(careless);
        yield* telemetry.record(used("whats-new"), PHONE);
        yield* stop;

        const { api_key, batch } = yield* next;
        assert.strictEqual(api_key, DEFAULT_TELEMETRY_KEY);
        assert.deepStrictEqual(
          batch.map((each) => each.event),
          [...Object.keys(EVERY_EVENT), "feature.used"],
        );
        for (const each of batch) {
          assert.strictEqual(each.distinct_id, each.properties.installId);
          assert.strictEqual(each.properties.$process_person_profile, false);
          assert.strictEqual(each.properties.$geoip_disable, true);
          assert.strictEqual(each.properties.j3Version, SERVER.j3Version);
          assert.strictEqual(each.properties.installKind, SERVER.installKind);
        }
        assert.strictEqual(new Set(batch.map((each) => each.uuid)).size, batch.length);
        const fromPhone = batch.at(-1)?.properties;
        assert.propertyVal(fromPhone, "surface", "android");
        assert.propertyVal(fromPhone, "clientVersion", "0.14.0");
        assert.propertyVal(fromPhone, "clientOs", "android");
        assert.propertyVal(fromPhone, "clientDevice", PHONE.device);
        assert.notProperty(batch[0]?.properties, "surface");
      }),
  );

  it.effect('sends waiting events in batches, and keeps what left for "See what is sent"', () =>
    Effect.gen(function* () {
      const { telemetry, stop } = yield* start({ timing: TIMING });
      yield* telemetry.record(started);
      yield* telemetry.record(used("whats-new"));
      const { batch } = yield* next;
      assert.deepStrictEqual(
        batch.map((each) => each.event),
        ["server.started", "feature.used"],
      );
      // What left is kept as it left, newest first, once the endpoint answered.
      const newest = batch[1]?.uuid;
      let sent = yield* telemetry.sent;
      while (sent[0]?.uuid !== newest) {
        yield* Effect.sleep("5 millis");
        sent = yield* telemetry.sent;
      }
      assert.deepStrictEqual(
        sent.slice(0, 2).map((each) => each.uuid),
        [batch[1]?.uuid, batch[0]?.uuid],
      );
      assert.deepStrictEqual(sent[0], batch[1]);
      yield* stop;
    }),
  );

  it.effect("tries a failed batch again, before anything newer", () =>
    Effect.gen(function* () {
      yield* answer("fail");
      const { telemetry, stop } = yield* start({ timing: TIMING });
      yield* telemetry.record(used("whats-new"));
      const first = yield* next;
      yield* answer("accept");
      yield* telemetry.record(used("voice-input"));
      const again = yield* next;
      assert.deepStrictEqual(again.batch, first.batch);
      const after = yield* next;
      assert.deepStrictEqual(after.batch.map(featureOf), ["voice-input"]);
      yield* stop;
    }),
  );

  it.effect("drops a batch after its tries run out, and sends what came after", () =>
    Effect.gen(function* () {
      yield* answer("fail");
      const { telemetry, stop } = yield* start({ timing: TIMING });
      yield* telemetry.record(used("whats-new"));
      const tries: Array<Batch> = [];
      for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS; attempt++) tries.push(yield* next);
      assert.isTrue(tries.every((each) => each.batch[0]?.uuid === tries[0]?.batch[0]?.uuid));
      yield* answer("accept");
      yield* telemetry.record(used("voice-input"));
      const after = yield* next;
      assert.deepStrictEqual(after.batch.map(featureOf), ["voice-input"]);
      yield* stop;
    }),
  );

  it.effect("drops a batch the endpoint refuses at once", () =>
    Effect.gen(function* () {
      yield* answer("refuse");
      const { telemetry, stop } = yield* start({ timing: TIMING });
      yield* telemetry.record(used("whats-new"));
      yield* next;
      yield* answer("accept");
      yield* telemetry.record(used("voice-input"));
      const after = yield* next;
      assert.strictEqual(after.batch.length, 1);
      yield* stop;
    }),
  );

  it.effect("waits at most the shutdown flush for the stop's send", () =>
    Effect.gen(function* () {
      yield* answer("hang");
      const { telemetry, stop } = yield* start({ timing: AT_STOP });
      yield* telemetry.record(started);
      const [took] = yield* Effect.timed(stop);
      assert.isBelow(Duration.toMillis(took), AT_STOP.shutdownFlush + 500);
      yield* next;
      yield* answer("accept");
    }),
  );

  it.effect("drops what waits when the switch is turned off, and sends nothing while it is", () =>
    Effect.gen(function* () {
      const { telemetry, turn, stop } = yield* start({ timing: AT_STOP });
      yield* telemetry.record(used("whats-new"));
      yield* turn(false);
      // The drop follows the switch's change on its own fiber.
      yield* Effect.sleep("20 millis");
      assert.isFalse(yield* telemetry.sending);
      yield* telemetry.record(used("voice-input"));
      yield* turn(true);
      yield* telemetry.record(started);
      yield* stop;
      const { batch } = yield* next;
      assert.deepStrictEqual(
        batch.map((each) => each.event),
        ["server.started"],
      );
    }),
  );

  it.effect("never sends again a batch that was on its way as the switch went off", () =>
    Effect.gen(function* () {
      yield* answer("hang");
      const { telemetry, turn, stop } = yield* start({ timing: TIMING });
      yield* telemetry.record(used("whats-new"));
      // On its way, and it will fail by timing out after the switch went off and on.
      yield* next;
      yield* turn(false);
      yield* Effect.sleep("20 millis");
      yield* turn(true);
      yield* answer("accept");
      yield* telemetry.record(used("voice-input"));
      const after = yield* next;
      assert.deepStrictEqual(after.batch.map(featureOf), ["voice-input"]);
      yield* stop;
    }),
  );

  it.effect("sends nothing while the environment holds it, whatever the switch says", () =>
    Effect.gen(function* () {
      const { telemetry, stop } = yield* start({ timing: AT_STOP, hold: "do-not-track" });
      assert.isFalse(yield* telemetry.sending);
      yield* telemetry.record(started);
      yield* stop;
      yield* nothingSent;
    }),
  );
});
