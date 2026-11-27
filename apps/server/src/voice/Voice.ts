// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CloudVoiceKeys,
  type CloudVoiceModel,
  type CloudVoiceProvider,
  CloudVoiceModelId,
  cloudProviderOf,
  Conflict,
  MAX_VOICE_FRAME_BYTES,
  MAX_VOICE_SECONDS,
  type Secret,
  SecretId,
  SecretName,
  VOICE_SAMPLE_RATE,
  type VoiceClientFrame,
  VoiceFailure,
  type VoiceInstall,
  type VoiceModel,
  VoiceModelId,
  type VoiceServerFrame,
  type VoiceSettings,
  type VoiceStatus,
} from "@j3-bots/contracts";
import {
  Engine,
  EngineSpeech,
  type EngineUnavailable,
  type SpeechFailed,
  type SpeechModel,
  type SpeechOptions,
} from "@j3-bots/engine-t3";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { Ids } from "../Ids.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { DEFAULT_VOICE_SETTINGS } from "../settings/SettingsStore.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { Host } from "../system/Host.ts";

// Dictation on the server (decision 0096). A client streams a recording on
// the voice socket; the server recognizes it with the engine's local model,
// or sends it whole to the cloud provider the operator chose, and answers the
// words. Audio passes through memory only: nothing here writes it anywhere.

/** The most audio one dictation takes, in bytes. */
const MAX_AUDIO_BYTES = MAX_VOICE_SECONDS * VOICE_SAMPLE_RATE * 4;

/**
 * Hosts with this much memory or less unload the model soon after its last
 * use, so it does not sit beside the bots: a 4 or 8 GB board.
 */
const SMALL_HOST_BYTES = 8 * 1024 ** 3;

/**
 * How long a client may send nothing while it records. It sends a piece a
 * tenth of a second; one silent this long is gone though its connection never
 * closed, as a laptop put to sleep, and the dictation ends so the next can
 * start. The engine gives up on a stream after as long (**Read**, T3 Code
 * v0.1.13, `apps/server/src/speech/stream.ts`).
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

const isCloudModelId = Schema.is(CloudVoiceModelId);

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

const failureOf = (error: SpeechFailed | EngineUnavailable): Refused => {
  if (error._tag === "EngineUnavailable") return new Refused({ reason: "unavailable" });
  switch (error.reason) {
    case "unsupported":
      return new Refused({ reason: "unavailable" });
    case "missing-model":
      return new Refused({ reason: "install" });
    case "busy":
    case "too-long":
    case "cloud-key":
    case "cloud-refused":
    case "cloud-limit":
    case "cloud-model":
    case "cloud-unavailable":
    case "failed":
      return new Refused({ reason: error.reason });
  }
};

/** A model as the operator chooses it, read for this server's hardware. */
const voiceModelOf = (
  model: SpeechModel,
  options: { readonly recommended: string; readonly processorOnly: boolean },
): VoiceModel => ({
  id: VoiceModelId.make(model.id),
  name: model.name,
  size: model.size,
  languages: model.languages,
  live: model.streaming,
  errorPercent: model.errorPercent,
  secondsPer30s: options.processorOnly
    ? model.secondsPer30s.cpu
    : (model.secondsPer30s.accelerated ?? model.secondsPer30s.cpu),
  recommended: model.id === options.recommended,
  installed: model.installed,
});

const sameWords = (
  a: { readonly committed: string; readonly tentative: string },
  b: { readonly committed: string; readonly tentative: string },
) => a.committed === b.committed && a.tentative === b.tentative;

type Draft = Extract<VoiceClientFrame, { type: "finish" }>["draft"];

export class Voice extends Context.Service<
  Voice,
  {
    /** Whether the server can recognize speech now, with which model, then each change. */
    readonly status: Stream.Stream<VoiceStatus>;
    /** Every model the engine can run. `Conflict("engine-unavailable")` while it does not run. */
    readonly models: Effect.Effect<ReadonlyArray<VoiceModel>, Conflict>;
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
     * `finish`, answered as `VoiceServerFrame` says. One runs at a time on
     * the server; another is answered `busy`. Ends quietly when the client
     * hangs up, which cancels it.
     */
    readonly dictate: (link: VoiceLink) => Effect.Effect<void>;
  }
>()("@j3-bots/server/voice/Voice") {}

export const layer = Layer.effect(
  Voice,
  Effect.gen(function* () {
    const speech = yield* EngineSpeech;
    const engine = yield* Engine;
    const settings = yield* SettingsService;
    const secrets = yield* Secrets;
    const ids = yield* Ids;
    const host = yield* Host;
    const scope = yield* Effect.scope;
    const keepLoaded = host.totalMemoryBytes <= SMALL_HOST_BYTES ? "short" : "long";

    /** One dictation at a time: the engine runs one recognition at a time. */
    const lock = yield* Semaphore.make(1);

    /** The model being downloaded now, which every client sees the progress of. */
    const installing = yield* SubscriptionRef.make<VoiceInstall | null>(null);
    const download = yield* SynchronizedRef.make<{
      readonly modelId: string;
      readonly fiber: Fiber.Fiber<void, SpeechFailed | EngineUnavailable>;
    } | null>(null);

    const voiceOf = (now: { readonly voice: VoiceSettings | null }) =>
      now.voice ?? DEFAULT_VOICE_SETTINGS;

    /**
     * Downloads `model` and makes it the engine's, or waits for the download
     * of it already under way. The download runs on when the dictation that
     * asked for it is cancelled, so the next one finds it ready.
     */
    const ensureInstalled = (model: SpeechModel) =>
      SynchronizedRef.modifyEffect(download, (current) =>
        Effect.gen(function* () {
          if (current !== null && current.fiber.pollUnsafe() === undefined) {
            if (current.modelId === model.id) return [current.fiber, current] as const;
            // The engine downloads one model at a time.
            yield* Fiber.await(current.fiber);
          }
          yield* SubscriptionRef.set(installing, {
            modelId: VoiceModelId.make(model.id),
            received: 0,
            total: model.size,
          });
          const fiber = yield* speech
            .install(model.id, (received) =>
              SubscriptionRef.set(installing, {
                modelId: VoiceModelId.make(model.id),
                received: Math.min(received, model.size),
                total: model.size,
              }),
            )
            .pipe(Effect.ensuring(SubscriptionRef.set(installing, null)), Effect.forkIn(scope));
          return [fiber, { modelId: model.id, fiber }] as const;
        }),
      ).pipe(Effect.flatMap(Fiber.join));

    /** The model the settings choose, or J3 Bots' pick when that one is gone from the catalog. */
    const chosenModel = (catalog: ReadonlyArray<SpeechModel>, voice: VoiceSettings) =>
      Option.fromNullishOr(
        catalog.find((model) => model.id === (voice.model ?? speech.recommended)) ??
          catalog.find((model) => model.id === speech.recommended),
      );

    /** The status but the download under way, which changes often and is joined after. */
    type Settled =
      | Extract<VoiceStatus, { _tag: "unavailable" }>
      | { readonly _tag: "available"; readonly model: VoiceModel };

    const statusFor = (start: number | null, voice: VoiceSettings): Effect.Effect<Settled> =>
      Effect.gen(function* () {
        if (start === null) return { _tag: "unavailable", reason: "engine" } as const;
        const support = yield* speech.support;
        if (support._tag === "unsupported") {
          return { _tag: "unavailable", reason: "platform" } as const;
        }
        const model = chosenModel(yield* speech.models, voice);
        if (Option.isNone(model)) return { _tag: "unavailable", reason: "platform" } as const;
        return {
          _tag: "available",
          model: voiceModelOf(model.value, {
            recommended: speech.recommended,
            processorOnly: support.processorOnly,
          }),
        } as const;
      }).pipe(
        Effect.catchTag("EngineUnavailable", () =>
          Effect.succeed({ _tag: "unavailable", reason: "engine" } as const),
        ),
      );

    const status: Stream.Stream<VoiceStatus> = Stream.zipLatest(
      engine.starts,
      settings.changes.pipe(
        Stream.map((now) => voiceOf(now)),
        Stream.changesWith((a, b) => a.model === b.model),
      ),
    ).pipe(
      // A model installed changes the catalog: read it again once it is.
      Stream.zipLatest(
        SubscriptionRef.changes(installing).pipe(
          Stream.changesWith((a, b) => (a === null) === (b === null)),
        ),
      ),
      Stream.mapEffect(([[start, voice]]) => statusFor(start, voice)),
      Stream.zipLatest(SubscriptionRef.changes(installing)),
      Stream.map(([base, install]): VoiceStatus =>
        base._tag === "unavailable"
          ? base
          : {
              _tag: "available",
              model: base.model,
              installing: install !== null && install.modelId === base.model.id ? install : null,
            },
      ),
    );

    const models = Effect.gen(function* () {
      const support = yield* speech.support;
      if (support._tag === "unsupported") return [];
      const catalog = yield* speech.models;
      return catalog.map((model) =>
        voiceModelOf(model, {
          recommended: speech.recommended,
          processorOnly: support.processorOnly,
        }),
      );
    }).pipe(
      Effect.catchTag("EngineUnavailable", () =>
        Effect.fail(new Conflict({ reason: "engine-unavailable" })),
      ),
    );

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

    const cloudModels = speech.cloudModels.pipe(
      Effect.map((found) =>
        found.flatMap((model) =>
          isCloudModelId(model.id) ? [{ id: model.id, name: model.name }] : [],
        ),
      ),
      Effect.mapError(
        (error) =>
          new Conflict({
            reason:
              error._tag === "EngineUnavailable" ? "engine-unavailable" : "connector-unavailable",
          }),
      ),
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
     * What the client sends until `finish`, each piece of audio handed to
     * `heard`. Answers the draft `finish` carries. While it `records`, a
     * client that sends nothing for `FIRST_AUDIO_WAIT` at first, then for
     * `CLIENT_SILENCE` between pieces, has hung up.
     */
    const listen = Effect.fn("Voice.listen")(function* <E>(
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
      records: boolean,
      heard: (pcm: Uint8Array) => Effect.Effect<void, E>,
    ) {
      const take = Queue.take(inbox).pipe(Effect.mapError(() => new HungUp()));
      let received = 0;
      while (true) {
        const next = yield* records
          ? take.pipe(
              Effect.timeoutOrElse({
                duration: received === 0 ? FIRST_AUDIO_WAIT : CLIENT_SILENCE,
                orElse: () => Effect.fail(new HungUp()),
              }),
            )
          : take;
        if (next instanceof Uint8Array) {
          if (next.byteLength > MAX_VOICE_FRAME_BYTES || next.byteLength % 4 !== 0) {
            return yield* refuse("failed");
          }
          received += next.byteLength;
          if (received > MAX_AUDIO_BYTES) return yield* refuse("too-long");
          yield* heard(next);
        } else if (next.type === "finish") {
          return next.draft;
        }
      }
    });

    /**
     * Waits for `model`'s download while telling the client how far it is.
     * What the client sends meanwhile is dropped: it shows the download, not
     * a microphone. True once ready; false when the client stopped first.
     */
    const prepare = Effect.fn("Voice.prepare")(function* (
      link: VoiceLink,
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
      model: SpeechModel,
    ) {
      yield* SubscriptionRef.changes(installing).pipe(
        Stream.filter((now): now is VoiceInstall => now !== null && now.modelId === model.id),
        Stream.runForEach((now) =>
          link.send({ type: "installing", received: now.received, total: now.total }),
        ),
        Effect.forkScoped,
      );
      // The client records nothing while it shows the download, however long it takes.
      const stopped = listen(inbox, false, () => Effect.void).pipe(Effect.as(false));
      return yield* Effect.raceFirst(
        ensureInstalled(model).pipe(
          Effect.as(true),
          Effect.mapError((error) =>
            error._tag === "EngineUnavailable"
              ? failureOf(error)
              : new Refused({ reason: "install" }),
          ),
        ),
        stopped,
      );
    }, Effect.scoped);

    const optionsOf = (voice: VoiceSettings): SpeechOptions => ({
      language: voice.language,
      words: voice.words,
      removeFillers: voice.removeFillers,
    });

    /** The engine's local model, live: words as they are heard. */
    const onServer = Effect.fn("Voice.onServer")(function* (
      link: VoiceLink,
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
      voice: VoiceSettings,
    ) {
      const support = yield* speech.support.pipe(Effect.mapError(failureOf));
      if (support._tag === "unsupported") return yield* refuse("unavailable");
      const model = chosenModel(yield* speech.models.pipe(Effect.mapError(failureOf)), voice);
      if (Option.isNone(model)) return yield* refuse("unavailable");
      if (!model.value.installed || support.modelId !== model.value.id) {
        if (!(yield* prepare(link, inbox, model.value))) return { text: "", draft: undefined };
      }
      yield* speech.keepLoaded(keepLoaded).pipe(Effect.mapError(failureOf));
      const stream = yield* speech.openStream(optionsOf(voice)).pipe(Effect.mapError(failureOf));
      yield* link.send({ type: "listening", live: model.value.streaming });
      let last = { committed: "", tentative: "" };
      const draft = yield* listen(inbox, true, (pcm) =>
        stream.feed(pcm).pipe(
          Effect.mapError(failureOf),
          Effect.flatMap((words) => {
            if (sameWords(words, last)) return Effect.void;
            last = words;
            return link.send({ type: "words", ...words });
          }),
        ),
      );
      const text = yield* stream.finish.pipe(Effect.mapError(failureOf));
      return { text, draft };
    }, Effect.scoped);

    /**
     * A cloud provider: the recording is kept in memory until `finish`, then
     * sent whole with the operator's key, which the engine holds only for
     * that request.
     */
    const inCloud = Effect.fn("Voice.inCloud")(function* (
      link: VoiceLink,
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
      provider: CloudVoiceProvider,
      voice: VoiceSettings,
    ) {
      const model = provider === "openrouter" ? voice.openRouterModel : null;
      if (provider === "openrouter" && model === null) return yield* refuse("cloud-model");
      if (Option.isNone(yield* keyOf(provider))) return yield* refuse("cloud-key");
      yield* link.send({ type: "listening", live: false });
      const pieces: Array<Uint8Array> = [];
      const draft = yield* listen(inbox, true, (pcm) => Effect.sync(() => pieces.push(pcm)));
      // Read again: a key removed while the operator spoke sends nothing.
      const key = yield* keyOf(provider);
      if (Option.isNone(key)) return yield* refuse("cloud-key");
      const pcm = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
      pieces.reduce((offset, piece) => {
        pcm.set(piece, offset);
        return offset + piece.byteLength;
      }, 0);
      if (pcm.byteLength === 0) return { text: "", draft };
      const text = yield* Effect.acquireUseRelease(
        speech.setCloudKey(provider, key.value),
        () => speech.transcribeWithCloud({ provider, model, pcm, options: optionsOf(voice) }),
        () => speech.setCloudKey(provider, null).pipe(Effect.ignore),
      ).pipe(Effect.mapError(failureOf));
      return { text, draft };
    });

    /** The AI's tidy-up when the operator turned it on; what was heard when it fails. */
    const tidied = Effect.fn("Voice.tidied")(function* (
      link: VoiceLink,
      text: string,
      voice: VoiceSettings,
      draft: Draft,
    ) {
      if (!voice.cleanUp || text.trim() === "") return text;
      yield* link.send({ type: "tidying" });
      return yield* speech
        .tidy({ text, words: voice.words, draft: draft ?? { text: "", start: 0, end: 0 } })
        .pipe(Effect.orElseSucceed(() => text));
    });

    const run = Effect.fn("Voice.run")(function* (
      link: VoiceLink,
      inbox: Queue.Dequeue<VoiceClientFrame | Uint8Array, Cause.Done>,
    ) {
      const voice = voiceOf(yield* settings.get);
      if (voice.place === "device") return yield* refuse("unavailable");
      const provider = cloudProviderOf(voice.place);
      const heard =
        provider === null
          ? yield* onServer(link, inbox, voice)
          : yield* inCloud(link, inbox, provider, voice);
      const text = yield* tidied(link, heard.text, voice, heard.draft);
      yield* link.send({ type: "done", text });
    });

    const dictate = Effect.fn("Voice.dictate")(
      function* (link: VoiceLink) {
        const inbox = yield* Queue.unbounded<VoiceClientFrame | Uint8Array, Cause.Done>();
        yield* link.incoming.pipe(Stream.runIntoQueue(inbox), Effect.forkScoped);
        const first = yield* Queue.take(inbox).pipe(Effect.mapError(() => new HungUp()));
        if (first instanceof Uint8Array || first.type !== "start") return;
        const ran = yield* lock.withPermitsIfAvailable(1)(
          run(link, inbox).pipe(
            Effect.catchTag("Refused", (refused) =>
              link.send({ type: "failed", reason: refused.reason }),
            ),
          ),
        );
        if (Option.isNone(ran)) yield* link.send({ type: "failed", reason: "busy" });
      },
      Effect.scoped,
      Effect.catchTags({ HungUp: () => Effect.void, LinkClosed: () => Effect.void }),
    );

    // A key the engine still holds when it starts was left by a server that
    // stopped during a recognition: it goes, once no dictation runs.
    yield* engine.starts.pipe(
      Stream.filter((start) => start !== null),
      Stream.runForEach(() =>
        Effect.forEach(PROVIDERS, (provider) => speech.setCloudKey(provider, null), {
          discard: true,
        }).pipe(Effect.ignore, lock.withPermits(1)),
      ),
      Effect.forkIn(scope),
    );

    return Voice.of({ status, models, cloudKeys, cloudModels, setCloudKey, dictate });
  }),
);
