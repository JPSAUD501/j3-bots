// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { NonNegativeInt, OpenLiterals } from "./base.ts";
import { Conflict } from "./errors.ts";
import { SecretValue } from "./secrets.ts";

// Dictation (decision 0096): the operator speaks, the words land in the
// composer, and they send them themselves. Where the words are recognized is
// the operator's choice (`VoicePlace`): on the device itself, on the server
// with the engine's local model, or by a cloud provider with the operator's
// key. Audio reaches the server only on the voice socket (`HTTP_PATHS.voice`)
// and is never stored.

/** The audio the voice socket takes: mono, 16 kHz, 32-bit float, little-endian. */
export const VOICE_SAMPLE_RATE = 16_000;
/** The most one audio frame of the voice socket may hold: one second. */
export const MAX_VOICE_FRAME_BYTES = VOICE_SAMPLE_RATE * 4;
/** The longest one dictation may run: five minutes, the engine's own limit. */
export const MAX_VOICE_SECONDS = 300;

/** The cloud providers that can recognize speech with the operator's own key. */
export const CloudVoiceProvider = Schema.Literals(["openai", "xai", "openrouter"]);
export type CloudVoiceProvider = typeof CloudVoiceProvider.Type;

/**
 * Where dictation turns speech into words.
 *
 * - `automatic`: on a phone with its own on-device recognizer for the
 *   language, there; anywhere else, on the server.
 * - `device`: only on the device itself; a device without its own
 *   recognizer cannot dictate.
 * - `server`: on the server, with the engine's local model.
 * - a cloud provider: on the server, which sends the recording to that
 *   provider with the operator's key once they stop.
 */
export const VoicePlace = Schema.Literals([
  "automatic",
  "device",
  "server",
  "openai",
  "xai",
  "openrouter",
]);
export type VoicePlace = typeof VoicePlace.Type;

/** The cloud provider `place` names, or null for a place that is not one. */
export const cloudProviderOf = (place: VoicePlace): CloudVoiceProvider | null =>
  place === "openai" || place === "xai" || place === "openrouter" ? place : null;

/**
 * The language the operator speaks: `auto` to have the model tell, or an
 * ISO 639-1 code such as `pt` or `en`.
 */
export const VoiceLanguage = Schema.String.check(Schema.isPattern(/^(auto|[a-z]{2})$/));
export type VoiceLanguage = typeof VoiceLanguage.Type;

/** A line break, a tab or any other control character, which a word cannot hold. */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The longest word to always spell right. */
export const MAX_VOICE_WORD_LENGTH = 50;
/** How many words to always spell right the operator may keep. */
export const MAX_VOICE_WORDS = 100;

/** A word or name dictation should always spell this way, such as a product or a person. */
export const VoiceWord = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_VOICE_WORD_LENGTH),
  Schema.makeFilter((word: string) =>
    NOT_ONE_LINE.test(word) ? "A word to spell right is one line." : true,
  ),
);

/** Words to spell right: none twice, ignoring case. */
export const VoiceWords = Schema.Array(VoiceWord).check(
  Schema.isMaxLength(MAX_VOICE_WORDS),
  Schema.makeFilter((words: ReadonlyArray<string>) => {
    const keys = words.map((word) => word.normalize("NFC").toLocaleLowerCase());
    return new Set(keys).size === keys.length || "Each word to spell right is there once.";
  }),
);

/**
 * A speech model the server can run, as the server names it. Opaque to a
 * client, which only shows and chooses it.
 */
export const VoiceModelId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
).pipe(Schema.brand("VoiceModelId"));
export type VoiceModelId = typeof VoiceModelId.Type;

/** A model of OpenRouter's that transcribes, as OpenRouter names it (`author/model`). */
export const CloudVoiceModelId = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(160),
  Schema.isPattern(/^(?!openrouter\/)[a-z\d][a-z\d.-]*\/[a-z\d][a-z\d._-]*$/i),
);
export type CloudVoiceModelId = typeof CloudVoiceModelId.Type;

/** The operator's dictation preferences: one set for the server and every device. */
export const VoiceSettings = Schema.Struct({
  place: VoicePlace,
  language: VoiceLanguage,
  words: VoiceWords,
  /** Takes out "um", "uh" and the like. On by default. */
  removeFillers: Schema.Boolean,
  /**
   * Has the AI tidy what was heard (punctuation, spoken corrections,
   * dictated lists) before it lands in the composer. Off by default: each
   * tidy-up is a request on the operator's AI plan.
   */
  cleanUp: Schema.Boolean,
  /** The server's local model; null for the one J3 Bots picks (`VoiceModel.recommended`). */
  model: Schema.NullOr(VoiceModelId),
  /** The model OpenRouter transcribes with, which that provider needs chosen. */
  openRouterModel: Schema.NullOr(CloudVoiceModelId),
});
export type VoiceSettings = typeof VoiceSettings.Type;

/** A change to the dictation preferences. A field left out keeps its value. */
export const VoiceSettingsChange = Schema.Struct({
  place: Schema.optionalKey(VoicePlace),
  language: Schema.optionalKey(VoiceLanguage),
  words: Schema.optionalKey(VoiceWords),
  removeFillers: Schema.optionalKey(Schema.Boolean),
  cleanUp: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NullOr(VoiceModelId)),
  openRouterModel: Schema.optionalKey(Schema.NullOr(CloudVoiceModelId)),
});
export type VoiceSettingsChange = typeof VoiceSettingsChange.Type;

/**
 * A model the server can run, in the terms the operator chooses by: how big
 * it is, how fast it is on this server, how well it hears each language,
 * and whether the words show while they speak.
 */
export const VoiceModel = Schema.Struct({
  id: VoiceModelId,
  name: Schema.String,
  /** Its download, in bytes. */
  size: NonNegativeInt,
  /** ISO 639-1 codes. */
  languages: Schema.Array(Schema.String),
  /** Words show while the operator speaks; otherwise they come once they stop. */
  live: Schema.Boolean,
  /**
   * The share of words it gets wrong in a language, in percent, as measured
   * by the engine's makers, keyed by ISO 639-1 code. A language left out
   * was not measured.
   */
  errorPercent: Schema.Record(Schema.String, Schema.Finite),
  /**
   * Seconds it takes for 30 seconds of speech, as measured on hardware like
   * this server's (a processor alone, or with a graphics card); null when it
   * was not measured.
   */
  secondsPer30s: Schema.NullOr(Schema.Finite),
  /** J3 Bots' own pick for this server, which `VoiceSettings.model` null means. */
  recommended: Schema.Boolean,
  /** Whether it is on the server's disk. */
  installed: Schema.Boolean,
});
export type VoiceModel = typeof VoiceModel.Type;

/** A model on its way to the server's disk: bytes received of its size. */
export const VoiceInstall = Schema.Struct({
  modelId: VoiceModelId,
  received: NonNegativeInt,
  total: NonNegativeInt,
});
export type VoiceInstall = typeof VoiceInstall.Type;

/**
 * Whether the server can recognize speech itself, as `voice.subscribe`
 * says it, and whether a key is saved for each cloud provider.
 *
 * `unavailable`: the server cannot run a speech model (`platform`: the
 * engine has no speech for its system), or its engine is not running now
 * (`engine`). A cloud provider still needs the engine.
 */
export const VoiceStatus = Schema.Union([
  Schema.TaggedStruct("unavailable", { reason: OpenLiterals(["platform", "engine"]) }),
  Schema.TaggedStruct("available", {
    /** The model dictation on the server uses, as the settings choose it. */
    model: VoiceModel,
    /** A model being installed now; null when none is. */
    installing: Schema.NullOr(VoiceInstall),
  }),
]);
export type VoiceStatus = typeof VoiceStatus.Type;

/** Whether a key is saved for each cloud provider. A key is never sent back. */
export const CloudVoiceKeys = Schema.Struct({
  openai: Schema.Boolean,
  xai: Schema.Boolean,
  openrouter: Schema.Boolean,
});
export type CloudVoiceKeys = typeof CloudVoiceKeys.Type;

/** A model OpenRouter can transcribe with. */
export const CloudVoiceModel = Schema.Struct({ id: CloudVoiceModelId, name: Schema.String });
export type CloudVoiceModel = typeof CloudVoiceModel.Type;

// ---------------------------------------------------------------------------
// The voice socket

/** The longest draft a `finish` frame carries, for the AI's tidy-up to read around. */
export const MAX_VOICE_DRAFT_LENGTH = 20_000;

/**
 * What a client sends on the voice socket as JSON text. Audio goes between
 * `start` and `finish` as binary frames (`VOICE_SAMPLE_RATE`), none over
 * `MAX_VOICE_FRAME_BYTES`. Closing the socket before `done` cancels: nothing
 * is kept.
 *
 * `start` with `transcript` asks for a screen recording's transcript rather
 * than words for the composer: each `words` frame then says how much of the
 * audio the words were heard in (`heardMs`), and the AI never tidies them.
 * Only a server whose roster snapshot carries `recordingTranscripts` takes
 * it; an older one would dictate as usual.
 *
 * `finish` may carry the draft the words go into, with where they go
 * (`start` to `end`, in UTF-16 units), for the AI's tidy-up to read the
 * words in their place.
 */
export const VoiceClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    transcript: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    type: Schema.Literal("finish"),
    draft: Schema.optionalKey(
      Schema.Struct({
        text: Schema.String.check(Schema.isMaxLength(MAX_VOICE_DRAFT_LENGTH)),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
]);
export type VoiceClientFrame = typeof VoiceClientFrame.Type;

/**
 * Why a dictation on the server ended without words, as a client says it.
 *
 * - `unavailable`: the server cannot recognize speech now (`VoiceStatus`).
 * - `busy`: another dictation is running on the server, from another device.
 * - `install`: the speech model could not be downloaded.
 * - `cloud-key`: no key is saved for the chosen provider.
 * - `cloud-refused`: the provider refused the key.
 * - `cloud-limit`: the provider's usage limit was reached.
 * - `cloud-model`: OpenRouter needs a model chosen, or no longer offers it.
 * - `cloud-unavailable`: the provider did not answer.
 * - `too-long`: the recording passed `MAX_VOICE_SECONDS`.
 * - `failed`: anything else.
 */
export const VOICE_FAILURES = [
  "unavailable",
  "busy",
  "install",
  "cloud-key",
  "cloud-refused",
  "cloud-limit",
  "cloud-model",
  "cloud-unavailable",
  "too-long",
  "failed",
] as const;
export const VoiceFailure = Schema.Literals(VOICE_FAILURES);
export type VoiceFailure = typeof VoiceFailure.Type;

/**
 * What the server sends on the voice socket, as JSON text, in this order:
 * `installing` while the model downloads, on first use; `listening` once
 * audio is taken, with whether words come while the operator speaks
 * (`live`); `words` as they are heard, `committed` settled and `tentative`
 * still open to change, and for a transcript (`start` with `transcript`)
 * `heardMs`, the milliseconds of audio the engine had taken when it heard
 * them; `tidying` while the AI tidies them up; then `done` with the final
 * text, or `failed` at any point. The server closes the socket after either.
 */
export const VoiceServerFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("installing"),
    received: NonNegativeInt,
    total: NonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literal("listening"), live: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("words"),
    committed: Schema.String,
    tentative: Schema.String,
    heardMs: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({ type: Schema.Literal("tidying") }),
  Schema.Struct({ type: Schema.Literal("done"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), reason: OpenLiterals(VOICE_FAILURES) }),
]);
export type VoiceServerFrame = typeof VoiceServerFrame.Type;

// ---------------------------------------------------------------------------
// The RPCs

/**
 * Dictation's RPCs, which a client makes only to a server whose settings
 * carry `voice`; an older one answers each with a defect.
 */
export const VoiceRpcs = RpcGroup.make(
  /** Whether the server can recognize speech now and with which model, then each change. */
  Rpc.make("voice.subscribe", { success: VoiceStatus, stream: true }),
  /**
   * Every model the server can run, for the operator to choose one by.
   * `Conflict("engine-unavailable")` while the engine is not running.
   */
  Rpc.make("voice.models", { success: Schema.Array(VoiceModel), error: Conflict }),
  /** Whether a key is saved for each cloud provider, then each change. */
  Rpc.make("voice.cloudKeys", { success: CloudVoiceKeys, stream: true }),
  /**
   * The models OpenRouter can transcribe with now, that keep no data.
   * `Conflict("engine-unavailable")` while the engine is not running, or
   * `Conflict("connector-unavailable")` when OpenRouter does not answer.
   */
  Rpc.make("voice.cloudModels", { success: Schema.Array(CloudVoiceModel), error: Conflict }),
  /**
   * Saves the operator's key for a cloud provider in Secrets, as a single
   * value named `voice-<provider>` that no bot may use, or removes it with
   * null. Saving the same key again changes nothing, so it carries no
   * command id. Fails as Secrets does while they cannot be written
   * (`Conflict("secrets-unavailable")`), or with
   * `Conflict("secret-name-taken")` when a login already has that name.
   */
  Rpc.make("voice.setCloudKey", {
    payload: { provider: CloudVoiceProvider, key: Schema.NullOr(SecretValue) },
    error: Conflict,
  }),
);
