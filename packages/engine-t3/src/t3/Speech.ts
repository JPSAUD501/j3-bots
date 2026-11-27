// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AuthWebSocketTicketResult,
  CloudSpeechError,
  CloudSpeechModels,
  EnvironmentRequestInvalidError,
  EnvironmentSpeechModelDownload,
  EnvironmentSpeechModels,
  EnvironmentSpeechPostProcessingResult,
  EnvironmentSpeechStatus,
  EnvironmentSpeechTranscriptionResult,
  SPEECH_STREAM_PATH,
  SpeechStreamCommand,
  SpeechStreamEvent,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import { EngineUnavailable } from "../errors.ts";
import {
  type CloudSpeechProvider,
  EngineSpeech,
  type HeardWords,
  SpeechFailed,
  type SpeechModel,
  type SpeechOptions,
  type SpeechStream,
  type SpeechSupport,
} from "../Speech.ts";
import { baseUrl, type ProcessState } from "./Supervisor.ts";

// The engine's speech service (decision 0096), over its HTTP API under
// `/api/voice` and its live stream at `SPEECH_STREAM_PATH`. Both are always
// served, with no setting to turn on: recognizing, reading the catalog and
// the status need `orchestration:operate`, and installing or choosing a model,
// the unload timeout and a cloud key `settings:write`, both of which the
// adapter's credential has (`Credential.ts`). **Read** at `bc0f04d`,
// `apps/server/src/speech/http.ts` and `stream.ts`; **Verified** against the
// pinned linux-x64 build with a token minted as `Credential.ts` mints it:
// `/api/voice/status` answered `supported`, a `media` ticket opened the
// stream, and a streaming model's words came back as it was fed.

const decodeTicket = HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult);
const decodeStatus = HttpClientResponse.schemaBodyJson(EnvironmentSpeechStatus);
const decodeModels = HttpClientResponse.schemaBodyJson(EnvironmentSpeechModels);
const decodeDownload = HttpClientResponse.schemaBodyJson(EnvironmentSpeechModelDownload);
const decodeText = HttpClientResponse.schemaBodyJson(EnvironmentSpeechTranscriptionResult);
const decodeTidied = HttpClientResponse.schemaBodyJson(EnvironmentSpeechPostProcessingResult);
const decodeCloudModels = HttpClientResponse.schemaBodyJson(CloudSpeechModels);
const decodeRefusal = HttpClientResponse.schemaBodyJson(
  Schema.Union([EnvironmentRequestInvalidError, CloudSpeechError]),
);
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SpeechStreamEvent));

/** How long a request that only reads or sets may take. */
const REQUEST_TIMEOUT = Duration.seconds(15);
/** How long a model's download may take: the largest the adapter offers is a few GB. */
const DOWNLOAD_TIMEOUT = Duration.hours(2);
/** How long a cloud provider or the AI's tidy-up may take. */
const REMOTE_TIMEOUT = Duration.minutes(2);
const OPEN_TIMEOUT = Duration.seconds(10);
/**
 * How long the engine may take to load the model and answer `start`, and to
 * answer one piece of audio or `finish`: a model loads from disk in a few
 * seconds on a desktop, longer on a small board.
 */
const STREAM_TIMEOUT = Duration.minutes(2);

/**
 * The model the adapter picks: the one of the pinned catalog that streams
 * (words show as they are said) and hears Portuguese and English, and fits a
 * 4 GB board beside the bots. Every other model of the catalog that hears
 * Portuguese gives its words only once a pause or the end comes, or is
 * 4.7 GB and over 50 s per 30 s of speech on a processor. Its catalog entry:
 * a 751 MB download (Q8_0), 28 languages, 8.5 % of Portuguese words wrong and
 * 7.9 % of English, 2.8 s per 30 s on a desktop processor. **Verified** on a
 * desktop processor alone with the pinned build: a 6.5 s recording's text
 * came 0.3 s after its last piece of audio, with about 0.65 GB of working
 * memory beside the 0.73 GB model file it maps. Not run on a 4 GB board.
 */
const RECOMMENDED = "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf";

/** How often the catalog is read for a download's progress. */
const PROGRESS_INTERVAL = Duration.millis(500);

/** The engine's unload timeouts the adapter uses (`SpeechModelUnloadTimeout`). */
const UNLOAD = { short: "min_2", long: "min_15" } as const;

/** The options a recording travels with, in the engine's terms. */
const engineOptions = (options: SpeechOptions): SpeechTranscriptionOptions => ({
  speechLanguage: options.language,
  speechTranslateToEnglish: false,
  speechCustomWords: options.words.map((term) => ({ term, aliases: [] })),
  speechRemoveFillerWords: options.removeFillers,
  speechSilenceFiltering: true,
});

const encodeOptions = Schema.encodeSync(Schema.fromJsonString(SpeechTranscriptionOptions));
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(SpeechStreamCommand));

/**
 * A recording as the engine's transcription endpoints take it: the options'
 * length as four bytes, little-endian, the options as UTF-8 JSON, then the
 * audio. **Read** at `bc0f04d`, `packages/shared/src/speech.ts`
 * `encodeSpeechPcmRequest`.
 */
const pcmRequest = (pcm: Uint8Array, options: SpeechTranscriptionOptions): Uint8Array => {
  const metadata = new TextEncoder().encode(encodeOptions(options));
  const body = new Uint8Array(4 + metadata.byteLength + pcm.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength, true);
  body.set(metadata, 4);
  body.set(pcm, 4 + metadata.byteLength);
  return body;
};

/** A catalog entry of the engine's, in the adapter's terms. */
const modelOf = (model: EnvironmentSpeechModels["models"][number]): SpeechModel => ({
  id: model.id,
  name: model.name,
  size: model.size,
  languages: model.languages,
  streaming: model.supportsStreaming,
  errorPercent: Object.fromEntries(
    Object.entries(model.benchmark?.accuracy ?? {}).map(([language, measured]) => [
      language,
      measured.errorPercent,
    ]),
  ),
  secondsPer30s: {
    cpu: model.benchmark?.secondsPer30s.cpu ?? null,
    accelerated: model.benchmark?.secondsPer30s.accelerated ?? null,
  },
  installed: model.state === "installed",
  downloading: model.state === "downloading" ? (model.downloaded ?? 0) : null,
});

/** Why a cloud provider refused, in the adapter's terms. */
const cloudReason = (reason: CloudSpeechError["reason"]): SpeechFailed["reason"] => {
  switch (reason) {
    case "missing-key":
    case "key-changed":
    case "unreadable-key":
      return "cloud-key";
    case "rejected-key":
      return "cloud-refused";
    case "rate-limit":
      return "cloud-limit";
    case "model-unavailable":
      return "cloud-model";
    case "unavailable":
      return "cloud-unavailable";
  }
};

/** What the engine's refusal of a request means for its caller. */
const refusalOf = (body: EnvironmentRequestInvalidError | CloudSpeechError) => {
  if (body._tag === "CloudSpeechError")
    return new SpeechFailed({ reason: cloudReason(body.reason) });
  switch (body.reason) {
    case "speech_busy":
      return new SpeechFailed({ reason: "busy" });
    case "speech_unavailable":
      return new SpeechFailed({ reason: "unsupported" });
    case "invalid_audio":
      return new SpeechFailed({ reason: "too-long" });
    default:
      return new SpeechFailed({ reason: "failed" });
  }
};

/**
 * One live recognition over `socket`, opened with `options`: answers once
 * the engine has loaded the model and said `ready`. The engine answers each
 * piece of audio with one `update`, in order, and `finish` with `finished`;
 * an `error` ends the stream. **Read** at `bc0f04d`,
 * `apps/server/src/speech/stream.ts` `runSpeechSocket`.
 */
export const streamOver = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  options: SpeechOptions,
): Effect.fn.Return<SpeechStream, SpeechFailed, Scope.Scope> {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader.pipe(
    Effect.mapError(() => new SpeechFailed({ reason: "failed" })),
  );
  const events = yield* Queue.unbounded<SpeechStreamEvent | null>();
  // Each event the engine sends, in order; null once the socket ends.
  yield* Effect.forever(
    reader.pull.pipe(
      Effect.flatMap((chunks) =>
        Effect.forEach(
          chunks,
          (chunk) => {
            if (typeof chunk !== "string") return Effect.void;
            const event = decodeEvent(chunk);
            return Option.isSome(event) ? Queue.offer(events, event.value) : Effect.void;
          },
          { discard: true },
        ),
      ),
    ),
  ).pipe(Effect.ensuring(Queue.offer(events, null)), Effect.ignore, Effect.forkScoped);
  const next = Queue.take(events).pipe(
    Effect.timeoutOrElse({ duration: STREAM_TIMEOUT, orElse: () => Effect.succeed(null) }),
  );
  const failed = new SpeechFailed({ reason: "failed" });
  const send = (data: string | Uint8Array) =>
    writer.write(data).pipe(Effect.mapError(() => failed));

  yield* send(encodeCommand({ type: "start", options: engineOptions(options) }));
  const opened = yield* next;
  if (opened?.type !== "ready") return yield* failed;

  // One request at a time: each answer belongs to the request before it.
  const turn = yield* Semaphore.make(1);
  let heard: HeardWords = { committed: "", tentative: "" };
  let ended = false;
  const feed = (pcm: Uint8Array) =>
    turn.withPermits(1)(
      Effect.gen(function* () {
        if (ended) return yield* failed;
        yield* send(pcm);
        const event = yield* next;
        if (event?.type !== "update") {
          ended = true;
          return yield* failed;
        }
        if (event.text !== null) heard = event.text;
        return heard;
      }),
    );
  const finish = turn.withPermits(1)(
    Effect.gen(function* () {
      if (ended) return yield* failed;
      ended = true;
      yield* send(encodeCommand({ type: "finish" }));
      const event = yield* next;
      if (event?.type !== "finished") return yield* failed;
      return event.text;
    }),
  );
  return { feed, finish } satisfies SpeechStream;
});

export const makeSpeech = (input: {
  readonly state: SubscriptionRef.SubscriptionRef<ProcessState>;
  readonly port: number;
  readonly token: Effect.Effect<Redacted.Redacted<string>>;
  readonly http: HttpClient.HttpClient;
}) => {
  const url = (path: string) => `${baseUrl(input.port)}${path}`;

  const ready = SubscriptionRef.get(input.state).pipe(
    Effect.flatMap((current) =>
      current._tag === "ready" ? Effect.void : Effect.fail(new EngineUnavailable()),
    ),
  );

  /**
   * Sends `request` with the credential and answers the response when the
   * engine took it. A refusal the engine explains is a `SpeechFailed`; no
   * answer, or one it does not explain, `EngineUnavailable`.
   */
  const send = Effect.fnUntraced(function* (
    request: HttpClientRequest.HttpClientRequest,
    timeout: Duration.Duration,
  ) {
    yield* ready;
    const token = yield* input.token;
    const response = yield* input.http
      .execute(request.pipe(HttpClientRequest.bearerToken(Redacted.value(token))))
      .pipe(
        Effect.timeout(timeout),
        Effect.mapError(() => new EngineUnavailable()),
      );
    if (response.status >= 200 && response.status < 300) return response;
    const refusal = yield* decodeRefusal(response).pipe(Effect.option);
    return yield* Option.match(refusal, {
      onNone: () => Effect.fail(new EngineUnavailable()),
      onSome: (body) => Effect.fail(refusalOf(body)),
    });
  });

  /** For what fails only as `EngineUnavailable`: a refusal there is one too. */
  const unavailableOnRefusal = <A, R>(
    effect: Effect.Effect<A, SpeechFailed | EngineUnavailable, R>,
  ): Effect.Effect<A, EngineUnavailable, R> =>
    effect.pipe(Effect.catchTag("SpeechFailed", () => Effect.fail(new EngineUnavailable())));

  const support: EngineSpeech["Service"]["support"] = send(
    HttpClientRequest.get(url("/api/voice/status")),
    REQUEST_TIMEOUT,
  ).pipe(
    Effect.flatMap((response) =>
      decodeStatus(response).pipe(Effect.mapError(() => new EngineUnavailable())),
    ),
    Effect.map((status): SpeechSupport =>
      status.supported
        ? {
            _tag: "supported",
            modelId: status.modelId,
            processorOnly: status.benchmarkTier === "cpu",
          }
        : { _tag: "unsupported" },
    ),
    unavailableOnRefusal,
  );

  const models: EngineSpeech["Service"]["models"] = send(
    HttpClientRequest.get(url("/api/voice/models")).pipe(
      HttpClientRequest.setUrlParam("benchmarks", "1"),
    ),
    REQUEST_TIMEOUT,
  ).pipe(
    Effect.flatMap((response) =>
      decodeModels(response).pipe(Effect.mapError(() => new EngineUnavailable())),
    ),
    Effect.map((catalog) => catalog.models.map(modelOf)),
    unavailableOnRefusal,
  );

  const install: EngineSpeech["Service"]["install"] = Effect.fn("EngineSpeech.install")(function* (
    modelId,
    progress,
  ) {
    // The download answers only once it ends; its progress is in the catalog meanwhile.
    yield* models.pipe(
      Effect.flatMap((catalog) => {
        const received = catalog.find((model) => model.id === modelId)?.downloading;
        return received === undefined || received === null ? Effect.void : progress(received);
      }),
      Effect.ignore,
      Effect.andThen(Effect.sleep(PROGRESS_INTERVAL)),
      Effect.forever,
      Effect.forkScoped,
    );
    const downloaded = yield* send(
      HttpClientRequest.post(url("/api/voice/models/download")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ modelId }),
      ),
      DOWNLOAD_TIMEOUT,
    ).pipe(
      Effect.flatMap((response) =>
        decodeDownload(response).pipe(Effect.mapError(() => new EngineUnavailable())),
      ),
    );
    if (downloaded.cancelled === true) return yield* new SpeechFailed({ reason: "failed" });
    yield* send(
      HttpClientRequest.post(url("/api/voice/models/select")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ modelId }),
      ),
      REQUEST_TIMEOUT,
    );
  }, Effect.scoped);

  const keepLoaded: EngineSpeech["Service"]["keepLoaded"] = (time) =>
    send(
      HttpClientRequest.post(url("/api/voice/model-unload-timeout")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ timeout: UNLOAD[time] }),
      ),
      REQUEST_TIMEOUT,
    ).pipe(Effect.asVoid, unavailableOnRefusal);

  /** The stream's address, with a one-use `media` ticket for its upgrade. */
  const streamUrl = Effect.gen(function* () {
    const response = yield* send(
      HttpClientRequest.post(url("/api/auth/websocket-ticket/media")),
      REQUEST_TIMEOUT,
    ).pipe(unavailableOnRefusal);
    const ticket = yield* decodeTicket(response).pipe(
      Effect.mapError(() => new EngineUnavailable()),
    );
    const address = new URL(`${url(SPEECH_STREAM_PATH).replace("http:", "ws:")}`);
    address.searchParams.set("wsTicket", Redacted.value(ticket.ticket));
    return address.toString();
  });

  const openStream: EngineSpeech["Service"]["openStream"] = Effect.fn("EngineSpeech.openStream")(
    function* (options) {
      const address = yield* streamUrl;
      const socket = yield* Socket.makeWebSocket(address, { openTimeout: OPEN_TIMEOUT }).pipe(
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      );
      return yield* streamOver(socket, options);
    },
  );

  const setCloudKey: EngineSpeech["Service"]["setCloudKey"] = (provider, key) =>
    send(
      HttpClientRequest.post(url(`/api/voice/cloud/${provider}/key`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ key: key === null ? null : Redacted.value(key) }),
      ),
      REQUEST_TIMEOUT,
    ).pipe(Effect.asVoid, unavailableOnRefusal);

  const cloudModels: EngineSpeech["Service"]["cloudModels"] = send(
    HttpClientRequest.get(url("/api/voice/cloud/openrouter/models")),
    REMOTE_TIMEOUT,
  ).pipe(
    Effect.flatMap((response) =>
      decodeCloudModels(response).pipe(Effect.mapError(() => new EngineUnavailable())),
    ),
    Effect.map((catalog) => catalog.models.map(({ id, name }) => ({ id, name }))),
  );

  const transcribeWithCloud: EngineSpeech["Service"]["transcribeWithCloud"] = Effect.fn(
    "EngineSpeech.transcribeWithCloud",
  )(function* (request: {
    readonly provider: CloudSpeechProvider;
    readonly model: string | null;
    readonly pcm: Uint8Array;
    readonly options: SpeechOptions;
  }) {
    const response = yield* send(
      HttpClientRequest.post(url(`/api/voice/cloud/${request.provider}/transcribe`)).pipe(
        request.model === null ? (it) => it : HttpClientRequest.setUrlParam("model", request.model),
        HttpClientRequest.bodyUint8Array(
          pcmRequest(request.pcm, engineOptions(request.options)),
          "application/octet-stream",
        ),
      ),
      REMOTE_TIMEOUT,
    );
    const result = yield* decodeText(response).pipe(Effect.mapError(() => new EngineUnavailable()));
    return result.text;
  });

  const tidy: EngineSpeech["Service"]["tidy"] = Effect.fn("EngineSpeech.tidy")(function* (request) {
    const response = yield* send(
      HttpClientRequest.post(url("/api/voice/post-process")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          options: {
            speechCustomWords: request.words.map((term) => ({ term, aliases: [] })),
            speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
          },
          transcript: request.text,
          draft: {
            text: request.draft.text,
            selection: { start: request.draft.start, end: request.draft.end },
          },
        }),
      ),
      REMOTE_TIMEOUT,
    );
    const result = yield* decodeTidied(response).pipe(
      Effect.mapError(() => new EngineUnavailable()),
    );
    return result.text;
  });

  return EngineSpeech.of({
    support,
    models,
    recommended: RECOMMENDED,
    install,
    keepLoaded,
    openStream,
    setCloudKey,
    cloudModels,
    transcribeWithCloud,
    tidy,
  });
};
