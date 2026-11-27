// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { EngineUnavailable } from "../errors.ts";
import {
  type CloudSpeechProvider,
  EngineSpeech,
  type HeardWords,
  SpeechFailed,
  type SpeechModel,
  type SpeechOptions,
  type SpeechSupport,
} from "../Speech.ts";

/** The catalog of the fake: a model that streams and hears both languages, and one that does not. */
export const TEST_SPEECH_MODELS = {
  streaming: "test/streaming-small",
  buffered: "test/buffered-large",
} as const;

const catalog: ReadonlyArray<Omit<SpeechModel, "installed" | "downloading">> = [
  {
    id: TEST_SPEECH_MODELS.streaming,
    name: "Streaming Small",
    size: 700_000_000,
    languages: ["en", "pt"],
    streaming: true,
    errorPercent: { en: 7.9, pt: 8.5 },
    secondsPer30s: { cpu: 2.8, accelerated: 1.7 },
  },
  {
    id: TEST_SPEECH_MODELS.buffered,
    name: "Buffered Large",
    size: 1_600_000_000,
    languages: ["en", "pt", "es"],
    streaming: false,
    errorPercent: { en: 4, pt: 3.9 },
    secondsPer30s: { cpu: 31, accelerated: 15 },
  },
];

/** One live recognition the server opened, as the engine's end of it. */
export interface FakeSpeechStream {
  readonly options: SpeechOptions;
  /** Every piece of audio the server fed it, in order. */
  readonly fed: Effect.Effect<ReadonlyArray<Uint8Array>>;
  /** Whether the server finished it. */
  readonly finished: Effect.Effect<boolean>;
  /** Completes once the server let it go, finished or not. */
  readonly released: Effect.Effect<void>;
}

/** One model download the server asked for, as the engine's end of it. */
export interface FakeInstall {
  readonly modelId: string;
  /** Tells the server how far the download got. */
  readonly progress: (received: number) => Effect.Effect<void>;
  /** Ends the download: installed, or failed. */
  readonly end: (outcome: "installed" | "failed") => Effect.Effect<void>;
}

/** What a test does as the engine's speech service. */
export class TestSpeechControl extends Context.Service<
  TestSpeechControl,
  {
    /** Whether the engine runs (`EngineUnavailable` otherwise) and has speech on its host. */
    readonly setSupport: (support: "supported" | "unsupported" | "down") => Effect.Effect<void>;
    /** Marks a model installed without a download, as one installed before. */
    readonly markInstalled: (modelId: string) => Effect.Effect<void>;
    /** The next download the server asks for, once it has. */
    readonly nextInstall: Effect.Effect<FakeInstall>;
    /** The model the engine uses now. */
    readonly selected: Effect.Effect<string | null>;
    /** The unload time the server last chose. */
    readonly keptLoaded: Effect.Effect<"short" | "long" | null>;
    /**
     * What each piece of audio is answered with, in order; the last one
     * answers every piece after it. Nothing heard until set.
     */
    readonly scriptWords: (words: ReadonlyArray<HeardWords>) => Effect.Effect<void>;
    /** What `finish`, a cloud provider and the tidy-up answer. */
    readonly scriptText: (text: {
      readonly finished?: string;
      readonly cloud?: string;
      readonly tidied?: string;
    }) => Effect.Effect<void>;
    /** Makes the next opens, finishes and cloud recognitions fail, or not with null. */
    readonly failWith: (reason: SpeechFailed["reason"] | null) => Effect.Effect<void>;
    /** The next live recognition the server opens, once it has. */
    readonly nextStream: Effect.Effect<FakeSpeechStream>;
    /** The key saved for each cloud provider; null for one removed. */
    readonly cloudKeys: Effect.Effect<ReadonlyMap<CloudSpeechProvider, string | null>>;
    /** Every cloud recognition asked for, in order. */
    readonly cloudRequests: Effect.Effect<
      ReadonlyArray<{
        readonly provider: CloudSpeechProvider;
        readonly model: string | null;
        readonly bytes: number;
      }>
    >;
    /** Every tidy-up asked for, in order. */
    readonly tidyRequests: Effect.Effect<
      ReadonlyArray<{ readonly text: string; readonly draft: { readonly text: string } }>
    >;
  }
>()("@j3-bots/engine-t3/testing/TestSpeech/TestSpeechControl") {}

/**
 * An in-memory `EngineSpeech` and its control. Supported, with nothing
 * installed, until the test says otherwise. A download waits for the test to
 * end it; a live recognition answers from the words the test scripted.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const support = yield* Ref.make<"supported" | "unsupported" | "down">("supported");
    const installed = yield* Ref.make<ReadonlySet<string>>(new Set());
    const downloading = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const selected = yield* Ref.make<string | null>(null);
    const keptLoaded = yield* Ref.make<"short" | "long" | null>(null);
    const installs = yield* Queue.unbounded<FakeInstall>();
    const words = yield* Ref.make<ReadonlyArray<HeardWords>>([]);
    const texts = yield* Ref.make({ finished: "", cloud: "", tidied: "" });
    const failure = yield* Ref.make<SpeechFailed["reason"] | null>(null);
    const streams = yield* Queue.unbounded<FakeSpeechStream>();
    const cloudKeys = yield* Ref.make<ReadonlyMap<CloudSpeechProvider, string | null>>(new Map());
    const cloudRequests = yield* Ref.make<
      ReadonlyArray<{ provider: CloudSpeechProvider; model: string | null; bytes: number }>
    >([]);
    const tidyRequests = yield* Ref.make<
      ReadonlyArray<{ readonly text: string; readonly draft: { readonly text: string } }>
    >([]);

    const running = Ref.get(support).pipe(
      Effect.flatMap((now) =>
        now === "down" ? Effect.fail(new EngineUnavailable()) : Effect.void,
      ),
    );
    const failIfScripted = Ref.get(failure).pipe(
      Effect.flatMap((reason) =>
        reason === null ? Effect.void : Effect.fail(new SpeechFailed({ reason })),
      ),
    );

    const speech = EngineSpeech.of({
      support: Effect.gen(function* () {
        yield* running;
        if ((yield* Ref.get(support)) === "unsupported") {
          return { _tag: "unsupported" } satisfies SpeechSupport;
        }
        return {
          _tag: "supported",
          modelId: (yield* Ref.get(selected)) ?? TEST_SPEECH_MODELS.streaming,
          processorOnly: true,
        } satisfies SpeechSupport;
      }),
      models: Effect.gen(function* () {
        yield* running;
        const done = yield* Ref.get(installed);
        const pending = yield* Ref.get(downloading);
        return catalog.map((model) => ({
          ...model,
          installed: done.has(model.id),
          downloading: pending.get(model.id) ?? null,
        }));
      }),
      recommended: TEST_SPEECH_MODELS.streaming,
      install: Effect.fn("TestSpeech.install")(function* (modelId, progress) {
        yield* running;
        if (!(yield* Ref.get(installed)).has(modelId)) {
          const ended = yield* Deferred.make<"installed" | "failed">();
          yield* Ref.update(downloading, (all) => new Map(all).set(modelId, 0));
          yield* Queue.offer(installs, {
            modelId,
            progress: (received) =>
              Ref.update(downloading, (all) => new Map(all).set(modelId, received)).pipe(
                Effect.andThen(progress(received)),
              ),
            end: (outcome) => Deferred.succeed(ended, outcome).pipe(Effect.asVoid),
          });
          const outcome = yield* Deferred.await(ended);
          yield* Ref.update(downloading, (all) => {
            const next = new Map(all);
            next.delete(modelId);
            return next;
          });
          if (outcome === "failed") return yield* new SpeechFailed({ reason: "failed" });
          yield* Ref.update(installed, (all) => new Set(all).add(modelId));
        }
        yield* Ref.set(selected, modelId);
      }),
      keepLoaded: (time) => running.pipe(Effect.andThen(Ref.set(keptLoaded, time))),
      openStream: Effect.fn("TestSpeech.openStream")(function* (options) {
        yield* running;
        yield* failIfScripted;
        const fed = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
        const finished = yield* Ref.make(false);
        const released = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        yield* Queue.offer(streams, {
          options,
          fed: Ref.get(fed),
          finished: Ref.get(finished),
          released: Deferred.await(released),
        });
        return {
          feed: (pcm: Uint8Array) =>
            Effect.gen(function* () {
              const count = (yield* Ref.updateAndGet(fed, (all) => [...all, pcm])).length;
              const script = yield* Ref.get(words);
              return script[Math.min(count, script.length) - 1] ?? { committed: "", tentative: "" };
            }),
          finish: Effect.gen(function* () {
            yield* failIfScripted;
            yield* Ref.set(finished, true);
            return (yield* Ref.get(texts)).finished;
          }),
        };
      }),
      setCloudKey: (provider, key: Redacted.Redacted<string> | null) =>
        running.pipe(
          Effect.andThen(
            Ref.update(cloudKeys, (all) =>
              new Map(all).set(provider, key === null ? null : Redacted.value(key)),
            ),
          ),
        ),
      cloudModels: running.pipe(Effect.as([{ id: "test/transcriber", name: "Test Transcriber" }])),
      transcribeWithCloud: Effect.fn("TestSpeech.transcribeWithCloud")(function* (input) {
        yield* running;
        yield* Ref.update(cloudRequests, (all) => [
          ...all,
          { provider: input.provider, model: input.model, bytes: input.pcm.byteLength },
        ]);
        yield* failIfScripted;
        return (yield* Ref.get(texts)).cloud;
      }),
      tidy: Effect.fn("TestSpeech.tidy")(function* (input) {
        yield* running;
        yield* Ref.update(tidyRequests, (all) => [
          ...all,
          { text: input.text, draft: { text: input.draft.text } },
        ]);
        return (yield* Ref.get(texts)).tidied;
      }),
    });

    return Context.make(EngineSpeech, speech).pipe(
      Context.add(
        TestSpeechControl,
        TestSpeechControl.of({
          setSupport: (next) => Ref.set(support, next),
          markInstalled: (modelId) => Ref.update(installed, (all) => new Set(all).add(modelId)),
          nextInstall: Queue.take(installs),
          selected: Ref.get(selected),
          keptLoaded: Ref.get(keptLoaded),
          scriptWords: (next) => Ref.set(words, next),
          scriptText: (next) => Ref.update(texts, (now) => ({ ...now, ...next })),
          failWith: (reason) => Ref.set(failure, reason),
          nextStream: Queue.take(streams),
          cloudKeys: Ref.get(cloudKeys),
          cloudRequests: Ref.get(cloudRequests),
          tidyRequests: Ref.get(tidyRequests),
        }),
      ),
    );
  }),
);
