// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  HTTP_PATHS,
  SecretId,
  SocketTicketGrant,
  type VoiceClientFrame,
  VoiceServerFrame,
  type VoiceSettingsChange,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as Ports from "../system/Ports.ts";
import { TestCloudSpeech } from "../testing/cloudSpeech.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as RefusedNames from "../web/RefusedNames.ts";
import { CloudSpeechFailed } from "./CloudSpeech.ts";
import { cloudKeySecret, Voice, type VoiceLink } from "./Voice.ts";
import * as VoiceSocket from "./VoiceSocket.ts";

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceServerFrame));

/** What a client's socket received: a frame, or the code it was closed with. */
type Received =
  | { readonly _tag: "frame"; readonly frame: VoiceServerFrame }
  | { readonly _tag: "closed"; readonly code: number };

const frame = (sent: VoiceServerFrame): Received => ({ _tag: "frame", frame: sent });

/** A quarter second of audio, as a client sends it. */
const audio = () => new Uint8Array(16_000);

const socketUrl = (query: string) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die("The test server listens on a TCP port");
    }
    return `ws://127.0.0.1:${address.port}${HTTP_PATHS.voice}${query}`;
  });

/** A voice socket, open in the test's scope: what it received, in order, and a way to talk. */
const open = (query: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(yield* socketUrl(query), { headers }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    const received = yield* Queue.unbounded<Received>();
    yield* Stream.fromEffectRepeat(reader.pull).pipe(
      Stream.flatMap((chunks) => Stream.fromIterable(chunks)),
      Stream.runForEach((chunk) =>
        typeof chunk === "string" ? Queue.offer(received, frame(decodeFrame(chunk))) : Effect.void,
      ),
      Effect.catch((error) =>
        Queue.offer(received, {
          _tag: "closed",
          code: error.reason._tag === "SocketCloseError" ? error.reason.code : 0,
        }),
      ),
      Effect.forkScoped,
    );
    const send = (data: string | Uint8Array) => writer.write(data).pipe(Effect.orDie);
    return {
      next: Queue.take(received),
      start: send(JSON.stringify({ type: "start" })),
      startTranscript: send(JSON.stringify({ type: "start", transcript: true })),
      audio: send(audio()),
      finish: send(JSON.stringify({ type: "finish" })),
      hangUp: writer.write(new Socket.CloseEvent(1000)).pipe(Effect.orDie),
    };
  });

/** A client's end of a dictation without a socket, which never hangs up by itself. */
const fakeLink = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<VoiceClientFrame | Uint8Array>();
  const sent = yield* Queue.unbounded<VoiceServerFrame>();
  const link: VoiceLink = {
    send: (next) => Queue.offer(sent, next).pipe(Effect.asVoid),
    incoming: Stream.fromQueue(incoming),
  };
  return {
    link,
    say: (next: VoiceClientFrame | Uint8Array) => Queue.offer(incoming, next),
    next: Queue.take(sent),
  };
});

const ticketFor = (token: string) =>
  HttpClientRequest.post(HTTP_PATHS.socketTicket).pipe(
    HttpClientRequest.setHeaders({ authorization: `Bearer ${token}` }),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SocketTicketGrant)),
    Effect.map((grant) => grant.ticket),
  );

let scenes = 0;

/**
 * A paired device, with the dictation preferences `voice`: OpenAI chosen,
 * with its key saved, unless `voice` says otherwise. Every provider answers
 * "Hello there." until the test says otherwise.
 */
const scene = (voice: VoiceSettingsChange = {}) =>
  Effect.gen(function* () {
    const n = ++scenes;
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    const paired = yield* devices.pair({ code, name: `Laptop ${n}` });
    yield* (yield* SettingsService).update({
      commandId: CommandId.make(`voice-${n}`),
      changes: {
        voice: { place: "automatic", provider: "openai", language: "auto", words: [], ...voice },
      },
    });
    yield* (yield* Voice).setCloudKey("openai", Redacted.make("sk-test-voice"));
    const cloud = yield* TestCloudSpeech;
    yield* cloud.answer(() => Effect.succeed("Hello there."));
    return {
      cloud,
      deviceId: paired.deviceId,
      bearer: { authorization: `Bearer ${paired.token}` },
      token: paired.token,
    };
  });

const server = Ports.serve(
  Layer.mergeAll(Http.routes, VoiceSocket.route),
  NodeHttpServer.layerTest,
  { logAddress: false },
).pipe(
  Layer.provide([TestUpdates.layer, RefusedNames.layer]),
  Layer.provideMerge(TestDomain.layer),
);

it.layer(server, { excludeTestServices: true })("voice socket", (it) => {
  it.effect("refuses an upgrade without a valid credential", () =>
    Effect.gen(function* () {
      const missing = yield* HttpClient.get(HTTP_PATHS.voice);
      const wrong = yield* HttpClient.get(HTTP_PATHS.voice, {
        headers: { authorization: "Bearer not-a-device-token" },
      });
      assert.strictEqual(missing.status, 401);
      assert.strictEqual(wrong.status, 401);
    }),
  );

  it.effect("sends a ticket's whole recording to the provider chosen, with its key", () =>
    Effect.gen(function* () {
      const { cloud, token } = yield* scene({ language: "pt", words: ["Wren"] });
      yield* cloud.answer(() => Effect.succeed("Olá, Wren."));
      const before = cloud.heard.length;
      const ticket = encodeURIComponent(yield* ticketFor(token));
      const client = yield* open(`?ticket=${ticket}`);

      yield* client.start;
      assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: false }));
      for (let piece = 0; piece < 4; piece++) yield* client.audio;
      yield* client.finish;
      assert.deepStrictEqual(yield* client.next, frame({ type: "done", text: "Olá, Wren." }));
      assert.deepStrictEqual(yield* client.next, { _tag: "closed", code: 1000 });
      assert.deepStrictEqual(cloud.heard.slice(before), [
        { provider: "openai", key: "sk-test-voice", model: null, bytes: 64_000, language: "pt" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("takes a recording from each device at once", () =>
    Effect.gen(function* () {
      const { bearer } = yield* scene();
      const first = yield* open("", bearer);
      const second = yield* open("", bearer);
      yield* first.start;
      yield* second.start;
      assert.deepStrictEqual(yield* first.next, frame({ type: "listening", live: false }));
      assert.deepStrictEqual(yield* second.next, frame({ type: "listening", live: false }));
      yield* second.audio;
      yield* second.finish;
      assert.deepStrictEqual(yield* second.next, frame({ type: "done", text: "Hello there." }));
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing when the client hangs up, and takes the next one", () =>
    Effect.gen(function* () {
      const { cloud, bearer } = yield* scene();
      const before = cloud.heard.length;
      const first = yield* open("", bearer);
      yield* first.start;
      yield* first.next;
      yield* first.audio;
      yield* first.hangUp;

      const second = yield* open("", bearer);
      yield* second.start;
      assert.deepStrictEqual(yield* second.next, frame({ type: "listening", live: false }));
      yield* second.audio;
      yield* second.finish;
      yield* second.next;
      assert.strictEqual(cloud.heard.length, before + 1);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the place's provider on every device when the place is one", () =>
    Effect.gen(function* () {
      const { cloud, bearer } = yield* scene({ place: "xai" });
      yield* (yield* Voice).setCloudKey("xai", Redacted.make("xai-test-voice"));
      const before = cloud.heard.length;
      const client = yield* open("", bearer);
      yield* client.startTranscript;
      yield* client.next;
      yield* client.audio;
      yield* client.finish;
      assert.deepStrictEqual(yield* client.next, frame({ type: "done", text: "Hello there." }));
      assert.deepStrictEqual(
        cloud.heard.slice(before).map((heard) => [heard.provider, heard.key]),
        [["xai", "xai-test-voice"]],
      );
      yield* (yield* Voice).setCloudKey("xai", null);
    }).pipe(Effect.scoped),
  );

  it.effect("says why the provider gave no words", () =>
    Effect.gen(function* () {
      const { cloud, bearer } = yield* scene();
      yield* cloud.answer(() => Effect.fail(new CloudSpeechFailed({ reason: "limit" })));
      const client = yield* open("", bearer);
      yield* client.start;
      yield* client.next;
      yield* client.audio;
      yield* client.finish;
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "cloud-limit" }));
    }).pipe(Effect.scoped),
  );

  it.effect("asks for a provider and its key before it records", () =>
    Effect.gen(function* () {
      const { bearer } = yield* scene({ provider: null });
      const none = yield* open("", bearer);
      yield* none.start;
      assert.deepStrictEqual(yield* none.next, frame({ type: "failed", reason: "cloud-key" }));

      yield* scene({ provider: "xai" });
      const keyless = yield* open("", bearer);
      yield* keyless.start;
      assert.deepStrictEqual(yield* keyless.next, frame({ type: "failed", reason: "cloud-key" }));

      yield* scene({ place: "device" });
      const onDevice = yield* open("", bearer);
      yield* onDevice.start;
      assert.deepStrictEqual(
        yield* onDevice.next,
        frame({ type: "failed", reason: "unavailable" }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("saves a provider's key as a secret no bot may use, and removes it", () =>
    Effect.gen(function* () {
      yield* scene();
      const voice = yield* Voice;
      const keys = yield* voice.cloudKeys.pipe(
        Stream.filter((now) => now.openai),
        Stream.runHead,
      );
      assert.deepStrictEqual(
        Option.map(keys, (now) => now.xai),
        Option.some(false),
      );
      const saved = yield* (yield* Secrets).named(cloudKeySecret("openai"));
      assert.deepStrictEqual(
        Option.map(saved, (secret) => secret.access),
        Option.some({ _tag: "bots" as const, botIds: [] }),
      );
      yield* voice.setCloudKey("openai", null);
      assert.isTrue(Option.isNone(yield* (yield* Secrets).named(cloudKeySecret("openai"))));
    }).pipe(Effect.scoped),
  );

  it.effect("asks for OpenRouter's model before it records", () =>
    Effect.gen(function* () {
      const { bearer } = yield* scene({ provider: "openrouter", openRouterModel: null });
      yield* (yield* Voice).setCloudKey("openrouter", Redacted.make("or-test-voice"));
      const client = yield* open("", bearer);
      yield* client.start;
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "cloud-model" }));
      yield* (yield* Voice).setCloudKey("openrouter", null);
    }).pipe(Effect.scoped),
  );

  it.effect("ends a dictation when its device is revoked", () =>
    Effect.gen(function* () {
      const { bearer, deviceId } = yield* scene();
      const client = yield* open("", bearer);
      yield* client.start;
      yield* client.next;
      yield* (yield* DeviceAuth).revoke(deviceId);
      assert.deepStrictEqual(yield* client.next, { _tag: "closed", code: 1008 });
    }).pipe(Effect.scoped),
  );

  it.effect("ends a recording whose client went silent without hanging up", () =>
    Effect.gen(function* () {
      const { cloud } = yield* scene();
      const before = cloud.heard.length;
      const voice = yield* Voice;
      const silent = yield* fakeLink;
      const dictation = yield* voice.dictate(silent.link).pipe(Effect.forkScoped);
      yield* silent.say({ type: "start" });
      assert.deepStrictEqual(yield* silent.next, { type: "listening", live: false });
      yield* silent.say(audio());
      // As a laptop put to sleep: no more audio, and no close.
      for (let second = 0; second < 30 && dictation.pollUnsafe() === undefined; second++) {
        yield* TestClock.adjust("1 second");
      }
      yield* Fiber.join(dictation);
      assert.strictEqual(cloud.heard.length, before);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect(
    "waits for the first piece while the operator answers the browser's microphone prompt",
    () =>
      Effect.gen(function* () {
        yield* scene();
        const voice = yield* Voice;
        const client = yield* fakeLink;
        yield* voice.dictate(client.link).pipe(Effect.forkScoped);
        yield* client.say({ type: "start" });
        assert.deepStrictEqual(yield* client.next, { type: "listening", live: false });
        yield* TestClock.adjust("20 seconds");
        yield* client.say(audio());
        yield* client.say({ type: "finish" });
        assert.deepStrictEqual(yield* client.next, { type: "done", text: "Hello there." });
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("sends nothing to a provider whose key was removed while the operator spoke", () =>
    Effect.gen(function* () {
      const { cloud, bearer } = yield* scene();
      const voice = yield* Voice;
      const before = cloud.heard.length;
      const client = yield* open("", bearer);
      yield* client.start;
      assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: false }));
      yield* client.audio;
      yield* voice.setCloudKey("openai", null);
      yield* client.finish;
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "cloud-key" }));
      assert.strictEqual(cloud.heard.length, before);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves alone a secret the operator made under a cloud key's name", () =>
    Effect.gen(function* () {
      const { bearer } = yield* scene({ provider: "xai" });
      const voice = yield* Voice;
      const secrets = yield* Secrets;
      const name = cloudKeySecret("xai");
      yield* secrets
        .add({
          id: SecretId.make("sec_operatorsownxaikey"),
          name,
          draft: { _tag: "value", value: Redacted.make("the operator's own") },
          access: { _tag: "every-bot" },
        })
        .pipe(Effect.orDie);

      const keys = yield* voice.cloudKeys.pipe(Stream.runHead);
      assert.deepStrictEqual(
        Option.map(keys, (now) => now.xai),
        Option.some(false),
      );
      const client = yield* open("", bearer);
      yield* client.start;
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "cloud-key" }));

      const refused = yield* voice
        .setCloudKey("xai", Redacted.make("xai-test-voice"))
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "secret-name-taken");
      yield* voice.setCloudKey("xai", null);
      const kept = yield* secrets.named(name);
      assert.deepStrictEqual(
        Option.map(kept, (secret) => secret.access),
        Option.some({ _tag: "every-bot" as const }),
      );
    }).pipe(Effect.scoped),
  );
});
