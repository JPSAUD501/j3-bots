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
  VoiceModelId,
  VoiceServerFrame,
  type VoiceSettingsChange,
} from "@j3-bots/contracts";
import { TEST_SPEECH_MODELS, TestSpeechControl } from "@j3-bots/engine-t3/testing";
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
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as RefusedNames from "../web/RefusedNames.ts";
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
      finish: (draft?: { text: string; start: number; end: number }) =>
        send(JSON.stringify(draft === undefined ? { type: "finish" } : { type: "finish", draft })),
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
 * A paired device, with the dictation preferences `voice` and the small
 * streaming model installed, which the server uses unless `voice` says
 * otherwise.
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
        voice: {
          place: "automatic",
          language: "auto",
          words: [],
          cleanUp: false,
          model: null,
          ...voice,
        },
      },
    });
    const speech = yield* TestSpeechControl;
    yield* speech.markInstalled(TEST_SPEECH_MODELS.streaming);
    yield* speech.failWith(null);
    yield* speech.scriptWords([]);
    return {
      speech,
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

  it.effect("passes a ticket's recording to the engine and answers the words as they come", () =>
    Effect.gen(function* () {
      const { speech, token } = yield* scene({ language: "pt", words: ["Wren"] });
      yield* speech.scriptWords([
        { committed: "", tentative: "olá" },
        { committed: "olá", tentative: "Wr" },
        { committed: "olá", tentative: "Wr" },
        { committed: "olá Wren", tentative: "" },
      ]);
      yield* speech.scriptText({ finished: "Olá, Wren." });
      const ticket = encodeURIComponent(yield* ticketFor(token));
      const client = yield* open(`?ticket=${ticket}`);

      yield* client.start;
      const stream = yield* speech.nextStream;
      assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: true }));
      for (let piece = 0; piece < 4; piece++) yield* client.audio;
      assert.deepStrictEqual(
        yield* client.next,
        frame({ type: "words", committed: "", tentative: "olá" }),
      );
      assert.deepStrictEqual(
        yield* client.next,
        frame({ type: "words", committed: "olá", tentative: "Wr" }),
      );
      // The third piece heard nothing new, so nothing was sent for it.
      assert.deepStrictEqual(
        yield* client.next,
        frame({ type: "words", committed: "olá Wren", tentative: "" }),
      );
      yield* client.finish();
      assert.deepStrictEqual(yield* client.next, frame({ type: "done", text: "Olá, Wren." }));
      assert.deepStrictEqual(yield* client.next, { _tag: "closed", code: 1000 });

      assert.deepStrictEqual(stream.options, {
        language: "pt",
        words: ["Wren"],
        removeFillers: true,
      });
      assert.strictEqual((yield* stream.fed).length, 4);
      assert.isTrue(yield* stream.finished);
      yield* stream.released;
    }).pipe(Effect.scoped),
  );

  it.effect("drops the recording when the client hangs up, and takes the next one", () =>
    Effect.gen(function* () {
      const { speech, bearer } = yield* scene();
      const first = yield* open("", bearer);
      yield* first.start;
      const dropped = yield* speech.nextStream;
      yield* first.next;
      yield* first.audio;
      yield* first.hangUp;
      yield* dropped.released;
      assert.isFalse(yield* dropped.finished);

      const second = yield* open("", bearer);
      yield* second.start;
      yield* speech.nextStream;
      assert.deepStrictEqual(yield* second.next, frame({ type: "listening", live: true }));
    }).pipe(Effect.scoped),
  );

  it.effect("answers busy to a second dictation while one runs", () =>
    Effect.gen(function* () {
      const { speech, bearer } = yield* scene();
      const first = yield* open("", bearer);
      yield* first.start;
      yield* speech.nextStream;
      yield* first.next;

      const second = yield* open("", bearer);
      yield* second.start;
      assert.deepStrictEqual(yield* second.next, frame({ type: "failed", reason: "busy" }));
      assert.deepStrictEqual(yield* second.next, { _tag: "closed", code: 1000 });
    }).pipe(Effect.scoped),
  );

  it.effect("has the AI tidy the words when the operator asked, with the draft around them", () =>
    Effect.gen(function* () {
      const { speech, bearer } = yield* scene({ cleanUp: true });
      yield* speech.scriptText({ finished: "eggs milk", tidied: "Eggs and milk." });
      const client = yield* open("", bearer);
      yield* client.start;
      yield* speech.nextStream;
      yield* client.next;
      yield* client.audio;
      yield* client.finish({ text: "Buy: ", start: 5, end: 5 });
      // Nothing was heard for the piece: no words frame comes.
      assert.deepStrictEqual(yield* client.next, frame({ type: "tidying" }));
      assert.deepStrictEqual(yield* client.next, frame({ type: "done", text: "Eggs and milk." }));
      assert.deepStrictEqual(yield* speech.tidyRequests, [
        { text: "eggs milk", draft: { text: "Buy: " } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "answers a transcript's words with the audio they were heard in, and never tidies them",
    () =>
      Effect.gen(function* () {
        // The operator asked for the tidy-up, which is for the composer only.
        const { speech, bearer } = yield* scene({ cleanUp: true });
        yield* speech.scriptWords([
          { committed: "", tentative: "" },
          { committed: "", tentative: "open" },
          { committed: "open", tentative: "the" },
          { committed: "open the invoices", tentative: "" },
        ]);
        yield* speech.scriptText({ finished: "open the invoices", tidied: "Open the invoices." });
        const tidiedBefore = (yield* speech.tidyRequests).length;
        const client = yield* open("", bearer);
        yield* client.startTranscript;
        yield* speech.nextStream;
        assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: true }));
        for (let piece = 0; piece < 4; piece++) yield* client.audio;
        // Each piece is a quarter second; the first heard nothing.
        assert.deepStrictEqual(
          yield* client.next,
          frame({ type: "words", committed: "", tentative: "open", heardMs: 500 }),
        );
        assert.deepStrictEqual(
          yield* client.next,
          frame({ type: "words", committed: "open", tentative: "the", heardMs: 750 }),
        );
        assert.deepStrictEqual(
          yield* client.next,
          frame({ type: "words", committed: "open the invoices", tentative: "", heardMs: 1000 }),
        );
        yield* client.finish();
        assert.deepStrictEqual(
          yield* client.next,
          frame({ type: "done", text: "open the invoices" }),
        );
        assert.strictEqual((yield* speech.tidyRequests).length, tidiedBefore);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a cloud provider the whole recording with the saved key, and keeps none in the engine",
    () =>
      Effect.gen(function* () {
        const { speech, bearer } = yield* scene({ place: "openai" });
        const voice = yield* Voice;

        const keyless = yield* open("", bearer);
        yield* keyless.start;
        assert.deepStrictEqual(yield* keyless.next, frame({ type: "failed", reason: "cloud-key" }));

        yield* voice.setCloudKey("openai", Redacted.make("sk-test-voice"));
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

        yield* speech.scriptText({ cloud: "Hello from the cloud." });
        const client = yield* open("", bearer);
        yield* client.start;
        assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: false }));
        yield* client.audio;
        yield* client.audio;
        yield* client.finish();
        assert.deepStrictEqual(
          yield* client.next,
          frame({ type: "done", text: "Hello from the cloud." }),
        );
        assert.deepStrictEqual(yield* speech.cloudRequests, [
          { provider: "openai", model: null, bytes: 32_000 },
        ]);
        assert.deepStrictEqual(
          (yield* speech.cloudKeys).get("openai"),
          null,
          "The engine's copy of the key is removed once the recording is transcribed.",
        );

        yield* voice.setCloudKey("openai", null);
        assert.isTrue(Option.isNone(yield* (yield* Secrets).named(cloudKeySecret("openai"))));
      }).pipe(Effect.scoped),
  );

  it.effect("asks for OpenRouter's model before it records", () =>
    Effect.gen(function* () {
      const { bearer } = yield* scene({ place: "openrouter", openRouterModel: null });
      const client = yield* open("", bearer);
      yield* client.start;
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "cloud-model" }));
    }).pipe(Effect.scoped),
  );

  it.effect("ends a dictation when its device is revoked", () =>
    Effect.gen(function* () {
      const { speech, bearer, deviceId } = yield* scene();
      const client = yield* open("", bearer);
      yield* client.start;
      const stream = yield* speech.nextStream;
      yield* client.next;
      yield* (yield* DeviceAuth).revoke(deviceId);
      assert.deepStrictEqual(yield* client.next, { _tag: "closed", code: 1008 });
      yield* stream.released;
    }).pipe(Effect.scoped),
  );

  it.effect(
    "ends a recording whose client went silent without hanging up, and takes the next one",
    () =>
      Effect.gen(function* () {
        const { speech } = yield* scene();
        const voice = yield* Voice;
        const silent = yield* fakeLink;
        const dictation = yield* voice.dictate(silent.link).pipe(Effect.forkScoped);
        yield* silent.say({ type: "start" });
        const stream = yield* speech.nextStream;
        assert.deepStrictEqual(yield* silent.next, { type: "listening", live: true });
        yield* silent.say(audio());
        // As a laptop put to sleep: no more audio, and no close.
        for (let second = 0; second < 30 && dictation.pollUnsafe() === undefined; second++) {
          yield* TestClock.adjust("1 second");
        }
        yield* Fiber.join(dictation);
        yield* stream.released;
        assert.isFalse(yield* stream.finished);

        const next = yield* fakeLink;
        yield* voice.dictate(next.link).pipe(Effect.forkScoped);
        yield* next.say({ type: "start" });
        yield* speech.nextStream;
        assert.deepStrictEqual(yield* next.next, { type: "listening", live: true });
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect(
    "waits for the first piece while the operator answers the browser's microphone prompt",
    () =>
      Effect.gen(function* () {
        const { speech } = yield* scene({ place: "openai" });
        const voice = yield* Voice;
        yield* voice.setCloudKey("openai", Redacted.make("sk-test-voice"));
        yield* speech.scriptText({ cloud: "Allowed at last." });
        const client = yield* fakeLink;
        yield* voice.dictate(client.link).pipe(Effect.forkScoped);
        yield* client.say({ type: "start" });
        assert.deepStrictEqual(yield* client.next, { type: "listening", live: false });
        yield* TestClock.adjust("20 seconds");
        yield* client.say(audio());
        yield* client.say({ type: "finish" });
        assert.deepStrictEqual(yield* client.next, { type: "done", text: "Allowed at last." });
        yield* voice.setCloudKey("openai", null);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect(
    "sends nothing to a cloud provider whose key was removed while the operator spoke",
    () =>
      Effect.gen(function* () {
        const { speech, bearer } = yield* scene({ place: "openai" });
        const voice = yield* Voice;
        yield* voice.setCloudKey("openai", Redacted.make("sk-test-voice"));
        const before = (yield* speech.cloudRequests).length;
        const client = yield* open("", bearer);
        yield* client.start;
        assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: false }));
        yield* client.audio;
        yield* voice.setCloudKey("openai", null);
        yield* client.finish();
        assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "cloud-key" }));
        assert.strictEqual((yield* speech.cloudRequests).length, before);
      }).pipe(Effect.scoped),
  );

  it.effect("leaves alone a secret the operator made under a cloud key's name", () =>
    Effect.gen(function* () {
      const { bearer } = yield* scene({ place: "xai" });
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

  it.effect("says the server cannot recognize speech on a system the engine has none for", () =>
    Effect.gen(function* () {
      const { speech, bearer } = yield* scene();
      yield* speech.setSupport("unsupported");
      const voice = yield* Voice;
      assert.deepStrictEqual(
        yield* voice.status.pipe(Stream.runHead),
        Option.some({ _tag: "unavailable" as const, reason: "platform" as const }),
      );
      const client = yield* open("", bearer);
      yield* client.start;
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "unavailable" }));
      yield* speech.setSupport("supported");
    }).pipe(Effect.scoped),
  );
});

// A server of its own, so no model is installed yet.
it.layer(server, { excludeTestServices: true })("voice socket on first use", (it) => {
  it.effect("says the model could not be installed when its download fails", () =>
    Effect.gen(function* () {
      const { speech, bearer } = yield* scene({
        model: VoiceModelId.make(TEST_SPEECH_MODELS.buffered),
      });
      const client = yield* open("", bearer);
      yield* client.start;
      const install = yield* speech.nextInstall;
      yield* client.next;
      yield* install.end("failed");
      assert.deepStrictEqual(yield* client.next, frame({ type: "failed", reason: "install" }));
    }).pipe(Effect.scoped),
  );

  it.effect("installs the model on first use, saying how far it got, then listens", () =>
    Effect.gen(function* () {
      const { speech, bearer } = yield* scene({
        model: VoiceModelId.make(TEST_SPEECH_MODELS.buffered),
      });
      const voice = yield* Voice;
      const client = yield* open("", bearer);
      yield* client.start;
      const install = yield* speech.nextInstall;
      assert.strictEqual(install.modelId, TEST_SPEECH_MODELS.buffered);
      assert.deepStrictEqual(
        yield* client.next,
        frame({ type: "installing", received: 0, total: 1_600_000_000 }),
      );
      yield* install.progress(400_000_000);
      assert.deepStrictEqual(
        yield* client.next,
        frame({ type: "installing", received: 400_000_000, total: 1_600_000_000 }),
      );
      // Every device sees the download, not only the one dictating.
      const status = yield* voice.status.pipe(Stream.runHead);
      assert.deepStrictEqual(
        Option.map(status, (now) => (now._tag === "available" ? now.installing : null)),
        Option.some({
          modelId: VoiceModelId.make(TEST_SPEECH_MODELS.buffered),
          received: 400_000_000,
          total: 1_600_000_000,
        }),
      );
      // Audio sent while it downloads is dropped: none of it was heard.
      yield* client.audio;
      yield* install.end("installed");
      yield* speech.nextStream;
      assert.deepStrictEqual(yield* client.next, frame({ type: "listening", live: false }));
      assert.strictEqual(yield* speech.selected, TEST_SPEECH_MODELS.buffered);
    }).pipe(Effect.scoped),
  );
});
