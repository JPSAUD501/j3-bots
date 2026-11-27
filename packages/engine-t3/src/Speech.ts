// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { EngineUnavailable } from "./errors.ts";

// The engine's speech recognition, in J3 Bots terms (decision 0096): its
// catalog of local models, installing and choosing one, a live recognition
// of one recording, a cloud provider's recognition of a finished one, and the
// AI's tidy-up of what was heard. Audio is passed through, never kept.

/** A local speech model of the engine's catalog, as the adapter reads it. */
export interface SpeechModel {
  /** The engine's own id for it, opaque above the adapter. */
  readonly id: string;
  readonly name: string;
  /** Its download, in bytes. */
  readonly size: number;
  /** ISO 639-1 codes. */
  readonly languages: ReadonlyArray<string>;
  /** It recognizes as it hears, so words come while the person speaks. */
  readonly streaming: boolean;
  /** The share of words it gets wrong per language, in percent, as the catalog measured it. */
  readonly errorPercent: Readonly<Record<string, number>>;
  /** Seconds per 30 seconds of speech, as the catalog measured it, by processor alone and with a graphics card. */
  readonly secondsPer30s: { readonly cpu: number | null; readonly accelerated: number | null };
  readonly installed: boolean;
  /** Bytes received, while the engine downloads it. */
  readonly downloading: number | null;
}

/**
 * Whether the engine can run speech models on its host: `unsupported` on a
 * system it has none for. `supported` says which model it uses now and
 * whether it runs on the processor alone, which `SpeechModel.secondsPer30s`
 * is read by.
 */
export type SpeechSupport =
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "supported"; readonly modelId: string; readonly processorOnly: boolean };

/** What recognition of one recording takes, beside the audio. */
export interface SpeechOptions {
  /** `auto`, or an ISO 639-1 code. */
  readonly language: string;
  /** Words to always spell this way. */
  readonly words: ReadonlyArray<string>;
  readonly removeFillers: boolean;
}

/** What has been heard so far: settled words, then words still open to change. */
export interface HeardWords {
  readonly committed: string;
  readonly tentative: string;
}

/** The cloud providers the engine sends a recording to with the person's key. */
export type CloudSpeechProvider = "openai" | "xai" | "openrouter";

/**
 * Why recognition failed.
 *
 * - `busy`: the engine runs one recognition at a time, and one is running.
 * - `unsupported`: the engine has no speech on its host.
 * - `missing-model`: the model is not installed.
 * - `too-long`: past the engine's limit for one recording.
 * - `cloud-key`, `cloud-refused`, `cloud-limit`, `cloud-model`,
 *   `cloud-unavailable`: the cloud provider had no key, refused it, hit a
 *   usage limit, has no such model, or did not answer.
 * - `failed`: anything else.
 */
export class SpeechFailed extends Schema.TaggedError<SpeechFailed>()("SpeechFailed", {
  reason: Schema.Literals([
    "busy",
    "unsupported",
    "missing-model",
    "too-long",
    "cloud-key",
    "cloud-refused",
    "cloud-limit",
    "cloud-model",
    "cloud-unavailable",
    "failed",
  ]),
}) {
  override get message(): string {
    return `Speech recognition failed: ${this.reason}.`;
  }
}

/** One live recognition: audio in, words out, until it is finished or its scope closes. */
export interface SpeechStream {
  /**
   * Passes one piece of audio (`SPEECH_PCM`), in order. Each answers the
   * words heard so far once the engine took it.
   */
  readonly feed: (pcm: Uint8Array) => Effect.Effect<HeardWords, SpeechFailed>;
  /** Ends the recording and answers the whole text. The stream takes nothing after. */
  readonly finish: Effect.Effect<string, SpeechFailed>;
}

/** The audio every method takes: mono 16 kHz 32-bit float PCM, little-endian. */
export const SPEECH_PCM = { sampleRate: 16_000, bytesPerSample: 4 } as const;

export class EngineSpeech extends Context.Service<
  EngineSpeech,
  {
    /** `EngineUnavailable` while the engine is not running. */
    readonly support: Effect.Effect<SpeechSupport, EngineUnavailable>;
    /** The engine's catalog, with what is installed and what is downloading. */
    readonly models: Effect.Effect<ReadonlyArray<SpeechModel>, EngineUnavailable>;
    /**
     * The model of the catalog the adapter picks for dictation in English and
     * Portuguese on a small host: one that streams, so words show as they
     * are said.
     */
    readonly recommended: string;
    /**
     * Downloads `modelId` if it is not installed, telling `progress` the bytes
     * received now and then, and makes it the one the engine uses. Answers
     * once it is ready. `SpeechFailed("failed")` when the download fails;
     * `"busy"` when the engine is downloading another.
     */
    readonly install: (
      modelId: string,
      progress: (received: number) => Effect.Effect<void>,
    ) => Effect.Effect<void, SpeechFailed | EngineUnavailable>;
    /**
     * How long the engine keeps a model loaded after its last use, so an idle
     * one leaves memory: `short` on a host with little of it.
     */
    readonly keepLoaded: (time: "short" | "long") => Effect.Effect<void, EngineUnavailable>;
    /**
     * A live recognition with the model the engine uses, for as long as the
     * scope lives; closing the scope before `finish` drops it.
     */
    readonly openStream: (
      options: SpeechOptions,
    ) => Effect.Effect<SpeechStream, SpeechFailed | EngineUnavailable, Scope.Scope>;
    /** Saves the key the engine sends to `provider`, or removes it with null. */
    readonly setCloudKey: (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | null,
    ) => Effect.Effect<void, EngineUnavailable>;
    /** OpenRouter's models that transcribe and keep no data. */
    readonly cloudModels: Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string }>,
      SpeechFailed | EngineUnavailable
    >;
    /** A finished recording, recognized by `provider` with the key saved for it. */
    readonly transcribeWithCloud: (input: {
      readonly provider: CloudSpeechProvider;
      /** OpenRouter's model; the others choose their own. */
      readonly model: string | null;
      readonly pcm: Uint8Array;
      readonly options: SpeechOptions;
    }) => Effect.Effect<string, SpeechFailed | EngineUnavailable>;
    /**
     * `text` tidied up by the AI (punctuation, spoken corrections, dictated
     * lists), as it lands at `start` to `end` of `draft`.
     */
    readonly tidy: (input: {
      readonly text: string;
      readonly words: ReadonlyArray<string>;
      readonly draft: { readonly text: string; readonly start: number; readonly end: number };
    }) => Effect.Effect<string, SpeechFailed | EngineUnavailable>;
  }
>()("@j3-bots/engine-t3/Speech/EngineSpeech") {}
