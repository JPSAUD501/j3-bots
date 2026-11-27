// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CloudVoiceKeys,
  type CloudVoiceModel,
  type CloudVoiceProvider,
  Conflict,
  MAX_VOICE_FRAME_BYTES,
  MAX_VOICE_SECONDS,
  type Secret,
  SecretId,
  SecretName,
  VOICE_SAMPLE_RATE,
  type VoiceClientFrame,
  VoiceFailure,
  type VoiceModel,
  type VoiceServerFrame,
  type VoiceSettings,
  type VoiceStatus,
  voiceProviderOf,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Ids } from "../Ids.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { DEFAULT_VOICE_SETTINGS } from "../settings/SettingsStore.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { CloudSpeech, type CloudSpeechFailed } from "./CloudSpeech.ts";

// Dictation on the server (decision 0107). A client streams a recording on
// the voice socket; the server keeps it in memory until the operator stops,
// then sends it to the cloud provider the operator chose, with their key,
// and answers the words. Audio passes through memory only: nothing here
// writes it anywhere. The server runs no speech model of its own.

/** The most audio one dictation takes, in bytes. */
const MAX_AUDIO_BYTES = MAX_VOICE_SECONDS * VOICE_SAMPLE_RATE * 4;

/**
 * How long a client may send nothing while it records. It sends a piece a
 * tenth of a second; one silent this long is gone though its connection never
 * closed, as a laptop put to sleep.
 */
const CLIENT_SILENCE = "15 seconds";

/**
 * How long a client may take to send its first piece once the server
 * listens: a browser asks the operator for the microphone the first time,
 * and they may take a while to answer.
 */
const FIRST_AUDIO_WAIT = "2 minutes";

/** The secret a cloud provider's key is kept in. */
export const cloudKeySecret = (provider: CloudVoiceProvider): SecretName =>
  SecretName.make(`voice-${provider}`);

/**
 * Whether `secret` is a cloud key as Voice saves it: a single value no bot
 * may use. A secret the operator made under the same name is not one, and
 * dictation neither reads nor changes it.
 */
const isCloudKey = (secret: Secret): boolean =>
  secret.kind._tag === "value" &&
  secret.access._tag === "bots" &&
  secret.access.botIds.length === 0;

const PROVIDERS: ReadonlyArray<CloudVoiceProvider> = ["openai", "xai", "openrouter"];

/** The client's end of a voice socket has gone. */
export class LinkClosed extends Schema.TaggedError<LinkClosed>()("LinkClosed", {}) {}

/** The client's end of one voice socket. */
export interface VoiceLink {
  readonly send: (frame: VoiceServerFrame) => Effect.Effect<void, LinkClosed>;
  /** What the client sends, frames and audio in order, until it hangs up. */
  readonly incoming: Stream.Stream<VoiceClientFrame | Uint8Array>;
}

/** Why a dictation ends without words, as the client is told. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: VoiceFailure }) {}

/** The client hung up: a cancel, nothing to answer. */
class HungUp extends Schema.TaggedError<HungUp>()("HungUp", {}) {}

const refuse = (reason: VoiceFailure) => Effect.fail(new Refused({ reason }));

const failureOf = (error: CloudSpeechFailed): Refused => {
  switch (error.reason) {
    case "model":
      return new Refused({ reason: "cloud-model" });
    case "refused":
      return new Refused({ reason: "cloud-refused" });
    case "limit":
      return new Refused({ reason: "cloud-limit" });
    case "unavailable":
      return new Refused({ reason: "cloud-unavailable" });
  }
};

/** What `voice.subscribe` says to clients of protocol 11: this server runs no speech model. */
const NO_MODEL: VoiceStatus = { _tag: "unavailable", reason: "platform" };

export class Voice extends Context.Service<
  Voice,
  {
    /** That the server runs no speech model, for clients of protocol 11 that ask. */
    readonly status: Stream.Stream<VoiceStatus>;
    /** The server's speech models, for clients of protocol 11 that ask: none. */
    readonly models: Effect.Effect<ReadonlyArray<VoiceModel>>;
    /** Whether a key is saved for each cloud provider, then each change. */
    readonly cloudKeys: Stream.Stream<CloudVoiceKeys>;
    /** OpenRouter's models that transcribe and keep no data. */
    readonly cloudModels: Effect.Effect<ReadonlyArray<CloudVoiceModel>, Conflict>;
    /** Saves the key for `provider` in Secrets, or removes it with null. */
    readonly setCloudKey: (
      provider: CloudVoiceProvider,
      key: Redacted.Redacted<string> | null,
    ) => Effect.Effect<void, Conflict>;
    /**
     * Runs one dictation over `link` to its end: `start`, the audio, then
     * `finish`, answered as `VoiceServerFrame` says. Ends quietly when the
     * client hangs up, which cancels it.
     */
    readonly dictate: (link: VoiceLink) => Effect.Effect<void>;
  }
>()("@j3-bots/server/voice/Voice") {}

export const layer = Layer.effect(
  Voice,
  Effect.gen(function* () {
    const cloud = yield* CloudSpeech;
    const settings = yield* SettingsService;
    const secrets = yield* Secrets;
    const ids = yield* Ids;

    const voiceOf = (now: { readonly voice: VoiceSettings | null }) =>
      now.voice ?? DEFAULT_VOICE_SETTINGS;

    const cloudKeys: Stream.Stream<CloudVoiceKeys> = secrets.referenceStatus.pipe(
      Stream.mapEffect(() =>
        Effect.forEach(PROVIDERS, (provider) =>
          secrets.named(cloudKeySecret(provider)).pipe(
            Effect.map((found) => Option.isSome(found) && isCloudKey(found.value)),
            Effect.orElseSucceed(() => false),
          ),
        ),
      ),
      Stream.map(([openai = false, xai = false, openrouter = false]) => ({
        openai,
        xai,
        openrouter,
      })),
      Stream.changesWith(
        (a, b) => a.openai === b.openai && a.xai === b.xai && a.openrouter === b.openrouter,
      ),
    );

    const cloudModels: Effect.Effect<ReadonlyArray<CloudVoiceModel>, Conflict> = cloud.models.pipe(
      Effect.mapError(() => new Conflict({ reason: "connector-unavailable" })),
    );

    const setCloudKey = Effect.fn("Voice.setCloudKey")(function* (
      provider: CloudVoiceProvider,
      key: Redacted.Redacted<string> | null,
    ) {
      const name = cloudKeySecret(provider);
      const found = yield* secrets.named(name);
      if (key === null) {
        if (Option.isSome(found) && isCloudKey(found.value)) {
          yield* secrets.remove(found.value.id);
        }
        return;
      }
      if (Option.isNone(found)) {
        const id = yield* ids.make("sec");
        yield* secrets
          .add({
            id: SecretId.make(id),
            name,
            draft: { _tag: "value", value: key },
            // The server's own: no bot may use it.
            access: { _tag: "bots", botIds: [] },
          })
          .pipe(
            Effect.catchTags({
              Invalid: () => Effect.die("A cloud key's secret is a valid single value."),
              NotFound: () => Effect.die("A cloud key's secret is not added from an ask."),
            }),
          );
        return;
      }
      if (!isCloudKey(found.value)) {
        return yield* new Conflict({ reason: "secret-name-taken" });
      }
      yield* secrets.update({ id: found.value.id, changes: { value: key } }).pipe(
        Effect.catchTags({
          Invalid: () => Effect.die("A single value takes a new value."),
          // Removed meanwhile: as removed, which the operator sees.
          NotFound: () => Effect.void,
        }),
      );
    });

    /** The key saved for `provider`, as Voice saves it: in no other secret. */
    const keyOf = Effect.fn("Voice.keyOf")(function* (provider: CloudVoiceProvider) {
      const name = cloudKeySecret(provider);
      const found = yield* secrets
        .named(name)
        .pipe(Effect.mapError(() => new Refused({ reason: "failed" })));
      if (Option.isNone(found) || !isCloudKey(found.value)) return Option.none();
      return yield* secrets
        .referenceValues({
          references: [{ name, field: null }],
          users: { _tag: "bots", botIds: [] },
        })
        .pipe(
          Effect.map((values) => Option.fromNullishOr([...values.values()][0])),
          Effect.catchTag("SecretUnavailable", (error) =>
            error.reason === "unavailable" ? refuse("failed") : Effect.succeedNone,
          ),
        );
    });

    /**
     * The recording the client sends until `finish`, whole. A client that
     * sends nothing for `FIRST_AUDIO_WAIT` at first, then for
     * `CLIENT_SILENCE` between pieces, has hung up.
     */
    const record = Effect.fn("Voice.record")(function* (
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
    ) {
      const take = Queue.take(inbox).pipe(Effect.mapError(() => new HungUp()));
      const pieces: Array<Uint8Array> = [];
      let received = 0;
      while (true) {
        const next = yield* take.pipe(
          Effect.timeoutOrElse({
            duration: received === 0 ? FIRST_AUDIO_WAIT : CLIENT_SILENCE,
            orElse: () => Effect.fail(new HungUp()),
          }),
        );
        if (next instanceof Uint8Array) {
          if (next.byteLength > MAX_VOICE_FRAME_BYTES || next.byteLength % 4 !== 0) {
            return yield* refuse("failed");
          }
          received += next.byteLength;
          if (received > MAX_AUDIO_BYTES) return yield* refuse("too-long");
          pieces.push(next);
        } else if (next.type === "finish") {
          const pcm = new Uint8Array(received);
          pieces.reduce((offset, piece) => {
            pcm.set(piece, offset);
            return offset + piece.byteLength;
          }, 0);
          return pcm;
        }
      }
    });

    /**
     * One dictation: the provider the settings choose, with its key, hears
     * the whole recording once the operator stops. A key removed while they
     * spoke sends nothing.
     */
    const run = Effect.fn("Voice.run")(function* (
      link: VoiceLink,
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
    ) {
      const voice = voiceOf(yield* settings.get);
      if (voice.place === "device") return yield* refuse("unavailable");
      const provider = voiceProviderOf(voice);
      if (provider === null) return yield* refuse("cloud-key");
      const model = provider === "openrouter" ? voice.openRouterModel : null;
      if (provider === "openrouter" && model === null) return yield* refuse("cloud-model");
      if (Option.isNone(yield* keyOf(provider))) return yield* refuse("cloud-key");
      yield* link.send({ type: "listening", live: false });
      const pcm = yield* record(inbox);
      const key = yield* keyOf(provider);
      if (Option.isNone(key)) return yield* refuse("cloud-key");
      const text =
        pcm.byteLength === 0
          ? ""
          : yield* cloud
              .transcribe({
                provider,
                key: key.value,
                model,
                pcm,
                options: {
                  language: voice.language,
                  words: voice.words,
                  removeFillers: voice.removeFillers,
                },
              })
              .pipe(Effect.mapError(failureOf));
      yield* link.send({ type: "done", text });
    });

    const dictate = Effect.fn("Voice.dictate")(
      function* (link: VoiceLink) {
        const inbox = yield* Queue.unbounded<VoiceClientFrame | Uint8Array, Cause.Done>();
        yield* link.incoming.pipe(Stream.runIntoQueue(inbox), Effect.forkScoped);
        const first = yield* Queue.take(inbox).pipe(Effect.mapError(() => new HungUp()));
        if (first instanceof Uint8Array || first.type !== "start") return;
        yield* run(link, inbox).pipe(
          Effect.catchTag("Refused", (refused) =>
            link.send({ type: "failed", reason: refused.reason }),
          ),
        );
      },
      Effect.scoped,
      Effect.catchTags({ HungUp: () => Effect.void, LinkClosed: () => Effect.void }),
    );

    return Voice.of({
      // Held open, as a status that never changes.
      status: Stream.concat(Stream.succeed(NO_MODEL), Stream.never),
      models: Effect.succeed([]),
      cloudKeys,
      cloudModels,
      setCloudKey,
      dictate,
    });
  }),
);
