// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { NonNegativeInt, OpenLiterals } from "./base.ts";
import { Conflict } from "./errors.ts";
import { SecretValue } from "./secrets.ts";

// Dictation (decisions 0096 and 0107): the operator speaks, the words land
// in the composer, and they send them themselves. Where the words are
// recognized is the operator's choice (`VoicePlace`): on the device itself,
// where it has a recognizer of its own, or by the cloud provider they chose
// (`VoiceSettings.provider`), with their own key, which the server sends the
// recording to. Audio reaches the server only on the voice socket
// (`HTTP_PATHS.voice`) and is never stored.

/** The audio the voice socket takes: mono, 16 kHz, 32-bit float, little-endian. */
export const VOICE_SAMPLE_RATE = 16_000;
/** The most one audio frame of the voice socket may hold: one second. */
export const MAX_VOICE_FRAME_BYTES = VOICE_SAMPLE_RATE * 4;
/** The longest one dictation may run: five minutes. */
export const MAX_VOICE_SECONDS = 300;

/** The cloud providers that can recognize speech with the operator's own key. */
export const CloudVoiceProvider = Schema.Literals(["openai", "xai", "openrouter"]);
export type CloudVoiceProvider = typeof CloudVoiceProvider.Type;

/**
 * Where dictation turns speech into words.
 *
 * - `automatic`: on a phone with its own on-device recognizer for the
 *   language, there; anywhere else, by the provider the operator chose
 *   (`VoiceSettings.provider`).
 * - `device`: only on the device itself; a device without its own
 *   recognizer cannot dictate.
 * - a cloud provider: always that provider, on a phone too. It is the one
 *   `VoiceSettings.provider` names.
 * - `server`: the engine's local model, which a server of protocol 11 before
 *   0.15.0 may still hold. This server never sends it, refuses it in a change
 *   (`Invalid("voice-place")`), and its settings migrate it to `automatic`.
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
 * The languages the cloud providers take by name, as ISO 639-1 codes. Any
 * other the operator speaks, they tell by themselves (`auto`).
 */
export const DICTATION_LANGUAGES: ReadonlyArray<string> =
  "ar bg ca cs da de el en es fa fi fr hi hr hu id it ja ko mk ms nl pl pt ro ru sk sv th tr uk ur vi zh".split(
    " ",
  );

/**
 * The language the operator speaks: `auto` to have the provider tell, or an
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
 * A speech model a server before 0.15.0 can run, as it names it. This server
 * runs none; the id stays for `voice.models`, which clients of protocol 11
 * still call.
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
  /**
   * The cloud provider that turns speech into words wherever the device has
   * no recognizer of its own; null until the operator chooses one. When
   * `place` is a provider, it is that one.
   *
   * Absent from a server before 0.15.0, which recognizes speech with the
   * engine's local model: a client then dictates only with the device's own
   * recognizer, and a computer not at all.
   */
  provider: Schema.optionalKey(Schema.NullOr(CloudVoiceProvider)),
  language: VoiceLanguage,
  words: VoiceWords,
  /** Takes out "um", "uh" and the like. On by default. */
  removeFillers: Schema.Boolean,
  /**
   * The AI's tidy-up of a server before 0.15.0. This server has none, and
   * always sends false, for clients of protocol 11 that show it.
   */
  cleanUp: Schema.Boolean,
  /**
   * The local model of a server before 0.15.0. This server runs none, and
   * always sends null, for clients of protocol 11 that show it.
   */
  model: Schema.NullOr(VoiceModelId),
  /** The model OpenRouter transcribes with, which that provider needs chosen. */
  openRouterModel: Schema.NullOr(CloudVoiceModelId),
});
export type VoiceSettings = typeof VoiceSettings.Type;

/**
 * A change to the dictation preferences. A field left out keeps its value.
 * Choosing a provider as `place` chooses it as `provider` too, and choosing
 * another `provider` while `place` is one moves `place` to it.
 */
export const VoiceSettingsChange = Schema.Struct({
  place: Schema.optionalKey(VoicePlace),
  /** Sent only to a server whose settings carry `voice.provider`. */
  provider: Schema.optionalKey(Schema.NullOr(CloudVoiceProvider)),
  language: Schema.optionalKey(VoiceLanguage),
  words: Schema.optionalKey(VoiceWords),
  removeFillers: Schema.optionalKey(Schema.Boolean),
  openRouterModel: Schema.optionalKey(Schema.NullOr(CloudVoiceModelId)),
});
export type VoiceSettingsChange = typeof VoiceSettingsChange.Type;

/**
 * The cloud provider a device without a recognizer of its own dictates with
 * under `voice`, or null where it cannot: `place` is `device`, or no provider
 * is chosen.
 */
export const voiceProviderOf = (voice: VoiceSettings): CloudVoiceProvider | null =>
  voice.place === "device" ? null : (cloudProviderOf(voice.place) ?? voice.provider ?? null);

/**
 * A model a server before 0.15.0 can run, as `voice.models` lists it for
 * clients of protocol 11. This server runs none and lists none.
 */
export const VoiceModel = Schema.Struct({
  id: VoiceModelId,
  name: Schema.String,
  /** Its download, in bytes. */
  size: NonNegativeInt,
  /** ISO 639-1 codes. */
  languages: Schema.Array(Schema.String),
  live: Schema.Boolean,
  errorPercent: Schema.Record(Schema.String, Schema.Finite),
  secondsPer30s: Schema.NullOr(Schema.Finite),
  recommended: Schema.Boolean,
  installed: Schema.Boolean,
});
export type VoiceModel = typeof VoiceModel.Type;

/** A model on its way to the disk of a server before 0.15.0. */
export const VoiceInstall = Schema.Struct({
  modelId: VoiceModelId,
  received: NonNegativeInt,
  total: NonNegativeInt,
});
export type VoiceInstall = typeof VoiceInstall.Type;

/**
 * Whether the server recognizes speech itself, as `voice.subscribe` says it
 * to clients of protocol 11. This server runs no speech model: it always
 * answers `unavailable` with `platform`.
 */
export const VoiceStatus = Schema.Union([
  Schema.TaggedStruct("unavailable", { reason: OpenLiterals(["platform", "engine"]) }),
  Schema.TaggedStruct("available", {
    model: VoiceModel,
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

/**
 * What a client sends on the voice socket as JSON text. Audio goes between
 * `start` and `finish` as binary frames (`VOICE_SAMPLE_RATE`), none over
 * `MAX_VOICE_FRAME_BYTES`. Closing the socket before `done` cancels: nothing
 * is kept.
 *
 * `start` with `transcript` asks for a piece of a screen recording's voice
 * rather than words for the composer. Only a server whose roster snapshot
 * carries `recordingTranscripts` takes it. An older client's `finish` may
 * carry the draft the words went into, which this server passes over.
 */
export const VoiceClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    transcript: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ type: Schema.Literal("finish") }),
]);
export type VoiceClientFrame = typeof VoiceClientFrame.Type;

/**
 * Why a dictation ended without words, as a client says it.
 *
 * - `unavailable`: dictation stays on the device here (`place` is `device`).
 * - `cloud-key`: no provider is chosen, or no key is saved for it.
 * - `cloud-refused`: the provider refused the key.
 * - `cloud-limit`: the provider's usage limit was reached.
 * - `cloud-model`: OpenRouter needs a model chosen, or no longer offers it.
 * - `cloud-unavailable`: the provider did not answer.
 * - `too-long`: the recording passed `MAX_VOICE_SECONDS`.
 * - `failed`: anything else.
 */
export const VOICE_FAILURES = [
  "unavailable",
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
 * `listening` once audio is taken; then `done` with the text the provider
 * heard, once the operator stopped, or `failed` at any point. The server
 * closes the socket after either. `live` is always false: the provider
 * hears the whole recording at its end. Clients of protocol 11 read it.
 */
export const VoiceServerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("listening"), live: Schema.Boolean }),
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
  /**
   * Whether the server runs a speech model, for clients of protocol 11 that
   * hold it: always `unavailable` with `platform` here.
   */
  Rpc.make("voice.subscribe", { success: VoiceStatus, stream: true }),
  /** The server's speech models, for clients of protocol 11: none here. */
  Rpc.make("voice.models", { success: Schema.Array(VoiceModel), error: Conflict }),
  /** Whether a key is saved for each cloud provider, then each change. */
  Rpc.make("voice.cloudKeys", { success: CloudVoiceKeys, stream: true }),
  /**
   * The models OpenRouter can transcribe with now, that keep no data.
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
