// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { CloudVoiceModelId, type CloudVoiceProvider } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CloudSpeech, CloudSpeechFailed, layer, withoutFillers } from "./CloudSpeech.ts";

/** What a fake provider was sent: where, with which key, and the body as it reads it. */
interface Sent {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly form: ReadonlyArray<readonly [string, string]> | null;
  readonly file: { readonly type: string; readonly size: number } | null;
  readonly json: unknown;
}

/** A provider's answer: a status and a JSON body. */
type Answer = { readonly status: number; readonly body: unknown };

/** The providers over a fake client that records each request and answers as `answer` says. */
const providers = (answer: (url: URL) => Answer) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body = request.body;
      const form = body._tag === "FormData" ? body.formData : null;
      const file = form?.get("file");
      sent.push({
        url: url.toString(),
        authorization: request.headers["authorization"],
        form:
          form === null
            ? null
            : [...form.entries()].flatMap(([name, value]) =>
                typeof value === "string" ? [[name, value] as const] : [],
              ),
        file: file instanceof Blob ? { type: file.type, size: file.size } : null,
        json: body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null,
      });
      const { status, body: reply } = answer(url);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return { sent, layer: layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))) };
};

/** A second of audio at the voice socket's rate, as 32-bit floats. */
const second = new Uint8Array(16_000 * 4);

const transcribe = (provider: CloudVoiceProvider, model: string | null = null) =>
  Effect.gen(function* () {
    const cloud = yield* CloudSpeech;
    return yield* cloud.transcribe({
      provider,
      key: Redacted.make("sk-test"),
      model: model === null ? null : CloudVoiceModelId.make(model),
      pcm: second,
      options: { language: "pt", words: ["Wren"], removeFillers: true },
    });
  });

it.effect("sends OpenAI the recording as a WAV form with the key, language and words", () => {
  const fake = providers(() => ({ status: 200, body: { text: " Hmm, olá Wren. " } }));
  return Effect.gen(function* () {
    assert.strictEqual(yield* transcribe("openai"), "olá Wren.");
    const [request] = fake.sent;
    assert.strictEqual(request?.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.strictEqual(request?.authorization, "Bearer sk-test");
    assert.deepStrictEqual(request?.form, [
      ["model", "gpt-transcribe"],
      ["languages[]", "pt"],
      ["keywords[]", "Wren"],
    ]);
    // A 44-byte header, then a second of 16-bit samples.
    assert.deepStrictEqual(request?.file, { type: "audio/wav", size: 44 + 32_000 });
  }).pipe(Effect.provide(fake.layer));
});

it.effect("asks xAI to take filler words out itself", () => {
  const fake = providers(() => ({ status: 200, body: { text: "olá" } }));
  return Effect.gen(function* () {
    yield* transcribe("xai");
    assert.deepStrictEqual(fake.sent[0]?.form, [
      ["model", "grok-voice-transcribe-2.0"],
      ["language", "pt"],
      ["keyterm", "Wren"],
      ["format", "true"],
      ["filler_words", "false"],
    ]);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("sends OpenRouter only a model it offers now, to providers that keep no data", () => {
  const fake = providers((url) =>
    url.pathname.endsWith("/models")
      ? { status: 200, body: { data: [{ id: "openai/whisper-large-v3", name: "Whisper" }] } }
      : { status: 200, body: { text: "olá" } },
  );
  return Effect.gen(function* () {
    const gone = yield* transcribe("openrouter", "someone/retired").pipe(Effect.flip);
    assert.deepStrictEqual(gone, new CloudSpeechFailed({ reason: "model" }));
    assert.strictEqual(yield* transcribe("openrouter", "openai/whisper-large-v3"), "olá");
    // The catalog was read once, for both.
    assert.strictEqual(fake.sent.filter((sent) => sent.url.includes("/models")).length, 1);
    const sent = fake.sent.at(-1)?.json;
    assert.deepStrictEqual(
      typeof sent === "object" && sent !== null && "provider" in sent ? sent.provider : null,
      { zdr: true },
    );
  }).pipe(Effect.provide(fake.layer));
});

it.effect("says why a provider gave no words, from its answer", () =>
  Effect.gen(function* () {
    const reasonFor = (status: number) => {
      const fake = providers(() => ({ status, body: { error: "no" } }));
      return transcribe("openai").pipe(
        Effect.flip,
        Effect.map((failed) => failed.reason),
        Effect.provide(fake.layer),
      );
    };
    assert.strictEqual(yield* reasonFor(401), "refused");
    assert.strictEqual(yield* reasonFor(402), "refused");
    assert.strictEqual(yield* reasonFor(429), "limit");
    assert.strictEqual(yield* reasonFor(503), "unavailable");
  }),
);

it("takes filler words out without touching words that hold them", () => {
  assert.strictEqual(withoutFillers("Um, so uh the umbrella hm.", "en"), "so the umbrella");
  assert.strictEqual(withoutFillers("Ehm, o guarda-chuva.", "pt"), "o guarda-chuva.");
});
