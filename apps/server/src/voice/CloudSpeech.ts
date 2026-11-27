// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CloudVoiceModel,
  CloudVoiceModelId,
  type CloudVoiceProvider,
  DICTATION_LANGUAGES,
  VOICE_SAMPLE_RATE,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

// The cloud providers dictation sends a recording to (decision 0107): OpenAI,
// xAI and OpenRouter, each with the operator's own key, straight from the
// J3 Bots server. The requests follow T3 Code's own cloud speech
// (`apps/server/src/speech/CloudSpeech.ts` and `fillerWords.ts` at
// `bc0f04d`, MIT, © T3 Tools Inc.): the endpoints, the models it sends to,
// the form fields each provider takes, and OpenRouter's catalog of models
// that keep no data (**Read**). Not one request was made to a provider while
// this was written: the tests answer as a provider would. Nothing here logs
// the audio, the words or the key.

const ENDPOINTS = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  xai: { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0" },
  openrouter: { url: "https://openrouter.ai/api/v1/audio/transcriptions" },
} as const;

/** OpenRouter's models that transcribe and keep no data (zero data retention). */
const OPENROUTER_CATALOG =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription&zdr=true";

/** The languages the providers take by name; any other is left for them to tell. */
const LANGUAGES = new Set(DICTATION_LANGUAGES);

/** How long a provider may take with one recording. */
const TRANSCRIBE_TIMEOUT = "2 minutes";
/** How long OpenRouter's catalog may take. */
const CATALOG_TIMEOUT = "10 seconds";
/** How long a catalog read is kept: it is public, so it holds nothing of the operator's. */
const CATALOG_KEPT = "10 minutes";

const Transcription = Schema.Struct({ text: Schema.String });
const OpenRouterCatalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
});
const isModelId = Schema.is(CloudVoiceModelId);

/**
 * Why a provider gave no words: no such model (`model`), the key refused
 * (`refused`), its usage limit reached (`limit`), or no answer that reads as
 * one (`unavailable`).
 */
export class CloudSpeechFailed extends Schema.TaggedError<CloudSpeechFailed>()(
  "CloudSpeechFailed",
  { reason: Schema.Literals(["model", "refused", "limit", "unavailable"]) },
) {}

/** What a recording is recognized with, beside the audio. */
export interface CloudSpeechOptions {
  /** `auto`, or an ISO 639-1 code. */
  readonly language: string;
  /** Words to always spell this way, which the provider is told to listen for. */
  readonly words: ReadonlyArray<string>;
  readonly removeFillers: boolean;
}

export class CloudSpeech extends Context.Service<
  CloudSpeech,
  {
    /** OpenRouter's models that transcribe and keep no data, read again every few minutes. */
    readonly models: Effect.Effect<ReadonlyArray<CloudVoiceModel>, CloudSpeechFailed>;
    /**
     * The words of a finished recording, by `provider` with `key`. `pcm` is
     * mono 32-bit float PCM at `VOICE_SAMPLE_RATE`, little-endian; `model`
     * is OpenRouter's, which it needs chosen and still offered.
     */
    readonly transcribe: (input: {
      readonly provider: CloudVoiceProvider;
      readonly key: Redacted.Redacted<string>;
      readonly model: CloudVoiceModelId | null;
      readonly pcm: Uint8Array;
      readonly options: CloudSpeechOptions;
    }) => Effect.Effect<string, CloudSpeechFailed>;
  }
>()("@j3-bots/server/voice/CloudSpeech") {}

/** The recording as a WAV file of 16-bit samples, which every provider takes. */
const waveOf = (pcm: Uint8Array): Uint8Array<ArrayBuffer> => {
  const samples = Math.floor(pcm.byteLength / 4);
  const input = new DataView(pcm.buffer, pcm.byteOffset, samples * 4);
  const wave = new Uint8Array(44 + samples * 2);
  const view = new DataView(wave.buffer);
  const tag = (at: number, value: string) => wave.set(new TextEncoder().encode(value), at);
  tag(0, "RIFF");
  view.setUint32(4, wave.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.max(-1, Math.min(1, input.getFloat32(index * 4, true)));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return wave;
};

const FILLERS = ["uh", "uhm", "umm", "uhh", "uhhh", "ehh", "ehm", "ahm", "hmm", "hm", "mmm"];
const FILLERS_BY_LANGUAGE: Readonly<Record<string, ReadonlyArray<string>>> = {
  en: ["um", "ah", "eh"],
  de: ["äh", "ähm"],
  fr: ["euh"],
};

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` without "um", "uh" and the like, as words of their own, in `language`. */
export const withoutFillers = (text: string, language: string): string => {
  const words = [...FILLERS, ...(FILLERS_BY_LANGUAGE[language] ?? [])];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${words.map(escaped).join("|")})(?![\\p{L}\\p{N}_])[,.]?`,
    "giu",
  );
  return text
    .replace(pattern, "")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/[^\S\r\n]*([\r\n])[^\S\r\n]*/g, "$1")
    .trim();
};

/** The request for OpenAI or xAI: a form with the recording last, since xAI reads nothing after it. */
const formBody = (
  provider: "openai" | "xai",
  wave: Uint8Array<ArrayBuffer>,
  language: string,
  options: CloudSpeechOptions,
) => {
  const form = new FormData();
  form.set("model", ENDPOINTS[provider].model);
  if (language !== "auto") form.set(provider === "openai" ? "languages[]" : "language", language);
  for (const word of options.words) {
    if (provider === "openai" && /[<>]/.test(word)) continue;
    form.append(provider === "openai" ? "keywords[]" : "keyterm", word);
  }
  if (provider === "xai") {
    if (language !== "auto") form.set("format", "true");
    form.set("filler_words", String(!options.removeFillers));
  }
  form.set("file", new Blob([wave], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.bodyFormData(form);
};

/** The request for OpenRouter: the recording in JSON, to providers that keep no data. */
const openRouterBody = (model: string, wave: Uint8Array<ArrayBuffer>, language: string) =>
  HttpClientRequest.bodyJsonUnsafe({
    model,
    input_audio: { data: Buffer.from(wave).toString("base64"), format: "wav" },
    ...(language === "auto" ? {} : { language }),
    provider: { zdr: true },
  });

/** Why a provider refused, from its status. */
const refusalOf = (status: number, provider: CloudVoiceProvider): CloudSpeechFailed["reason"] =>
  status === 429
    ? "limit"
    : status === 401 || status === 402 || status === 403
      ? "refused"
      : status === 404 && provider === "openrouter"
        ? "model"
        : "unavailable";

/** The providers over `HttpClient`, which follows no redirect. */
export const layer = Layer.effect(
  CloudSpeech,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
    const unavailable = () => new CloudSpeechFailed({ reason: "unavailable" });

    const readCatalog = Effect.gen(function* () {
      const response = yield* execute(HttpClientRequest.get(OPENROUTER_CATALOG)).pipe(
        Effect.mapError(unavailable),
      );
      if (response.status < 200 || response.status >= 300) return yield* unavailable();
      const { data } = yield* HttpClientResponse.schemaBodyJson(OpenRouterCatalog)(response).pipe(
        Effect.mapError(unavailable),
      );
      return data.flatMap(({ id, name }) =>
        isModelId(id) ? [{ id, name: name?.trim() || id }] : [],
      );
    }).pipe(
      Effect.timeoutOrElse({ duration: CATALOG_TIMEOUT, orElse: () => Effect.fail(unavailable()) }),
    );
    const models = yield* Effect.cachedWithTTL(readCatalog, (exit) =>
      Exit.isSuccess(exit) ? CATALOG_KEPT : 0,
    );

    const transcribe = Effect.fn("CloudSpeech.transcribe")(
      function* (input: {
        readonly provider: CloudVoiceProvider;
        readonly key: Redacted.Redacted<string>;
        readonly model: CloudVoiceModelId | null;
        readonly pcm: Uint8Array;
        readonly options: CloudSpeechOptions;
      }) {
        const { provider, model, options } = input;
        const language = LANGUAGES.has(options.language) ? options.language : "auto";
        if (provider === "openrouter") {
          if (model === null) return yield* new CloudSpeechFailed({ reason: "model" });
          if (!(yield* models).some((offered) => offered.id === model)) {
            return yield* new CloudSpeechFailed({ reason: "model" });
          }
        }
        const wave = waveOf(input.pcm);
        const request = HttpClientRequest.post(ENDPOINTS[provider].url).pipe(
          HttpClientRequest.bearerToken(Redacted.value(input.key)),
          provider === "openrouter" && model !== null
            ? openRouterBody(model, wave, language)
            : formBody(provider === "xai" ? "xai" : "openai", wave, language, options),
        );
        const response = yield* execute(request).pipe(Effect.mapError(unavailable));
        if (response.status < 200 || response.status >= 300) {
          return yield* new CloudSpeechFailed({ reason: refusalOf(response.status, provider) });
        }
        const { text } = yield* HttpClientResponse.schemaBodyJson(Transcription)(response).pipe(
          Effect.mapError(unavailable),
        );
        return options.removeFillers
          ? withoutFillers(text, language === "auto" ? "" : language)
          : text.trim();
      },
      (effect) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: TRANSCRIBE_TIMEOUT,
            orElse: () => Effect.fail(unavailable()),
          }),
        ),
    );

    return CloudSpeech.of({ models, transcribe });
  }),
);
