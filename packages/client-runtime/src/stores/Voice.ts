// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CloudVoiceKeys,
  type CloudVoiceModel,
  type CloudVoiceProvider,
  HTTP_PATHS,
  MAX_VOICE_FRAME_BYTES,
  VoiceClientFrame,
  type VoiceFailure,
  type VoiceModel,
  VoiceServerFrame,
  type VoiceStatus,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { Connection, ReconnectPolicy } from "../connection/Connection.ts";
import { intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { type Loaded, makeLive } from "./reads.ts";

// Dictation through the server (decision 0096): its status and models on
// the RPC socket, and each dictation on a voice socket of its own
// (`HTTP_PATHS.voice`). The audio goes out as it is recorded and is kept
// nowhere on the device.

/** What has been heard so far: settled words, then words still open to change. */
export interface HeardWords {
  readonly committed: string;
  readonly tentative: string;
}

/**
 * Why a dictation on the server ended without words: the server's reasons,
 * `unknown` for one this client does not know, or the device's own.
 *
 * - `unreachable`: the voice socket could not be opened, or dropped.
 * - `not-paired`: this device holds no credential the server takes.
 */
export type DictationFailure = VoiceFailure | "unknown" | "unreachable" | "not-paired";

/**
 * For a transcript (`Voice.transcribe`), how much of the audio the engine
 * had taken, in ms, when it heard the words held: absent before any word.
 */
interface HeardIn {
  readonly heardMs?: number;
}

/** One dictation on the server, from the first frame to its end. */
export type DictationState =
  /** The socket is opening, or the server is loading the model. */
  | { readonly _tag: "connecting" }
  /** The server is downloading the model, on first use. */
  | { readonly _tag: "installing"; readonly received: number; readonly total: number }
  /**
   * Audio is taken. `live`: words come while the operator speaks; otherwise
   * they come once they stop.
   */
  | ({ readonly _tag: "listening"; readonly live: boolean } & HeardWords & HeardIn)
  /** The operator stopped; the server is working out the last words. */
  | ({ readonly _tag: "finishing" } & HeardWords & HeardIn)
  /** The AI is tidying up what was heard. */
  | ({ readonly _tag: "tidying" } & HeardWords)
  | { readonly _tag: "done"; readonly text: string }
  | { readonly _tag: "failed"; readonly reason: DictationFailure };

/** Whether a dictation has ended: nothing more comes. */
export const isOver = (state: DictationState): boolean =>
  state._tag === "done" || state._tag === "failed";

/** One dictation, for as long as its scope lives. Closing the scope first cancels it. */
export interface Dictation {
  readonly state: Readable<DictationState>;
  /**
   * Passes on one piece of the recording: mono 16 kHz 32-bit float PCM,
   * little-endian (`VOICE_SAMPLE_RATE`). Dropped unless the server listens,
   * as while it downloads the model; a piece over `MAX_VOICE_FRAME_BYTES`
   * goes in parts.
   */
  readonly audio: (pcm: Uint8Array) => Effect.Effect<void>;
  /**
   * The operator stopped. `draft` is the text the words go into, with where
   * they go, for the AI's tidy-up. Before the server listens, nothing was
   * heard: the dictation is done with no text.
   */
  readonly finish: (draft?: {
    readonly text: string;
    readonly start: number;
    readonly end: number;
  }) => Effect.Effect<void>;
}

const decodeServerFrame = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceServerFrame));
const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(VoiceClientFrame));

/** The words held, in any state that holds them. */
const heardIn = (state: DictationState): HeardWords =>
  "committed" in state
    ? { committed: state.committed, tentative: state.tentative }
    : { committed: "", tentative: "" };

/** The state a frame from the server leads to, from `now`. */
export const nextState = (now: DictationState, frame: VoiceServerFrame): DictationState => {
  switch (frame.type) {
    case "installing":
      return { _tag: "installing", received: frame.received, total: frame.total };
    case "listening":
      return { _tag: "listening", live: frame.live, committed: "", tentative: "" };
    case "words":
      return now._tag === "listening" || now._tag === "finishing"
        ? {
            ...now,
            committed: frame.committed,
            tentative: frame.tentative,
            ...(frame.heardMs === undefined ? {} : { heardMs: frame.heardMs }),
          }
        : now;
    case "tidying":
      return { _tag: "tidying", ...heardIn(now) };
    case "done":
      return { _tag: "done", text: frame.text };
    case "failed":
      return { _tag: "failed", reason: frame.reason };
  }
};

export class Voice extends Context.Service<
  Voice,
  {
    /**
     * Whether the server can recognize speech now, and with which model,
     * while held. Hold it only from a server whose settings carry `voice`:
     * an older one has no such subscription.
     */
    readonly status: Effect.Effect<Readable<Loaded<VoiceStatus>>, never, Scope.Scope>;
    /** Whether a key is saved for each cloud provider, while held; as `status`. */
    readonly cloudKeys: Effect.Effect<Readable<Loaded<CloudVoiceKeys>>, never, Scope.Scope>;
    /** Every model the server can run. */
    readonly models: Effect.Effect<IntentResult<ReadonlyArray<VoiceModel>>>;
    /** OpenRouter's models that transcribe. */
    readonly cloudModels: Effect.Effect<IntentResult<ReadonlyArray<CloudVoiceModel>>>;
    /** Saves the key for a cloud provider in the server's Secrets, or removes it with null. */
    readonly setCloudKey: (
      provider: CloudVoiceProvider,
      key: Redacted.Redacted<string> | null,
    ) => Effect.Effect<IntentResult>;
    /** Starts a dictation on the server. */
    readonly dictate: Effect.Effect<Dictation, never, Scope.Scope>;
    /**
     * Starts writing down a piece of a screen recording's voice on the
     * server: a dictation whose words say how much audio they were heard in
     * (`heardMs`) and are never tidied. Only for a server whose roster
     * snapshot carries `recordingTranscripts`.
     */
    readonly transcribe: Effect.Effect<Dictation, never, Scope.Scope>;
  }
>()("@j3-bots/client-runtime/stores/Voice") {}

export const layer = Layer.effect(
  Voice,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const scope = yield* Scope.Scope;
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const policy = yield* ReconnectPolicy;

    const status = makeLive<void, VoiceStatus>({
      scope,
      connection,
      keyOf: () => "status",
      follow: (_, client, set) =>
        client["voice.subscribe"]().pipe(Stream.runForEach((next) => set(() => next))),
    });
    const cloudKeys = makeLive<void, CloudVoiceKeys>({
      scope,
      connection,
      keyOf: () => "cloud-keys",
      follow: (_, client, set) =>
        client["voice.cloudKeys"]().pipe(Stream.runForEach((next) => set(() => next))),
    });

    const models = connection
      .call((client) => client["voice.models"]())
      .pipe(Effect.exit, Effect.map(intentResult));
    const cloudModels = connection
      .call((client) => client["voice.cloudModels"]())
      .pipe(Effect.exit, Effect.map(intentResult));
    const setCloudKey = (provider: CloudVoiceProvider, key: Redacted.Redacted<string> | null) =>
      connection
        .call((client) => client["voice.setCloudKey"]({ provider, key }))
        .pipe(Effect.exit, Effect.map(intentResult));

    const open = Effect.fnUntraced(function* (transcript: boolean) {
      const state = new Cell<DictationState>({ _tag: "connecting" });
      /** Writes on the open socket; false once it is closed. */
      let write: ((data: string | Uint8Array) => Effect.Effect<boolean>) | null = null;
      const fail = (reason: DictationFailure) =>
        Effect.sync(() => {
          if (!isOver(state.get())) state.set({ _tag: "failed", reason });
        });

      const run = Effect.gen(function* () {
        const address = yield* connection.socketAddress(HTTP_PATHS.voice, {});
        const socket = yield* Socket.makeWebSocket(address, {
          openTimeout: policy.openTimeout,
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, makeWebSocket));
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        write = (data) =>
          writer.write(data).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        yield* write(
          encodeClientFrame(transcript ? { type: "start", transcript: true } : { type: "start" }),
        );
        while (!isOver(state.get())) {
          for (const message of yield* reader.pull) {
            if (typeof message !== "string") continue;
            // A frame this client does not know is passed over.
            const frame = decodeServerFrame(message);
            if (Option.isSome(frame)) state.update((now) => nextState(now, frame.value));
          }
        }
      }).pipe(
        Effect.catchTags({
          NotPaired: () => fail("not-paired"),
          ServerUnreachable: () => fail("unreachable"),
          SocketError: () => fail("unreachable"),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            write = null;
          }),
        ),
        Effect.scoped,
      );
      yield* Effect.forkScoped(run);

      const audio = Effect.fn("Dictation.audio")(function* (pcm: Uint8Array) {
        if (write === null || state.get()._tag !== "listening") return;
        for (let offset = 0; offset < pcm.byteLength; offset += MAX_VOICE_FRAME_BYTES) {
          yield* write(pcm.subarray(offset, offset + MAX_VOICE_FRAME_BYTES));
        }
      });

      const finish = Effect.fn("Dictation.finish")(function* (draft?: {
        readonly text: string;
        readonly start: number;
        readonly end: number;
      }) {
        const now = state.get();
        if (now._tag !== "listening") {
          if (!isOver(now)) state.set({ _tag: "done", text: "" });
          return;
        }
        state.set({
          _tag: "finishing",
          committed: now.committed,
          tentative: now.tentative,
          ...(now.heardMs === undefined ? {} : { heardMs: now.heardMs }),
        });
        const sent =
          write !== null &&
          (yield* write(
            encodeClientFrame(draft === undefined ? { type: "finish" } : { type: "finish", draft }),
          ));
        if (!sent) yield* fail("unreachable");
      });

      return { state, audio, finish } satisfies Dictation;
    });

    return Voice.of({
      status: status.acquire(undefined),
      cloudKeys: cloudKeys.acquire(undefined),
      models,
      cloudModels,
      setCloudKey,
      dictate: open(false),
      transcribe: open(true),
    });
  }),
);
