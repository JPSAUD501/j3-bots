// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CloudVoiceKeys,
  type CloudVoiceModel,
  type CloudVoiceProvider,
  HTTP_PATHS,
  MAX_VOICE_FRAME_BYTES,
  VoiceClientFrame,
  type VoiceFailure,
  VoiceServerFrame,
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

// Dictation through the server (decision 0107): the cloud providers' keys
// on the RPC socket, and each dictation on a voice socket of its own
// (`HTTP_PATHS.voice`). The audio goes out as it is recorded and is kept
// nowhere on the device; the words come once the operator stops.

/**
 * Why a dictation on the server ended without words: the server's reasons,
 * `unknown` for one this client does not know, or the device's own.
 *
 * - `unreachable`: the voice socket could not be opened, or dropped.
 * - `not-paired`: this device holds no credential the server takes.
 */
export type DictationFailure = VoiceFailure | "unknown" | "unreachable" | "not-paired";

/** One dictation on the server, from the first frame to its end. */
export type DictationState =
  /** The socket is opening. */
  | { readonly _tag: "connecting" }
  /** Audio is taken. */
  | { readonly _tag: "listening" }
  /** The operator stopped; the provider is writing down what they said. */
  | { readonly _tag: "finishing" }
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
   * little-endian (`VOICE_SAMPLE_RATE`). Dropped unless the server listens;
   * a piece over `MAX_VOICE_FRAME_BYTES` goes in parts.
   */
  readonly audio: (pcm: Uint8Array) => Effect.Effect<void>;
  /**
   * The operator stopped. Before the server listens, nothing was heard: the
   * dictation is done with no text.
   */
  readonly finish: Effect.Effect<void>;
}

const decodeServerFrame = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceServerFrame));
const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(VoiceClientFrame));

/** The state a frame from the server leads to. */
const nextState = (frame: VoiceServerFrame): DictationState => {
  switch (frame.type) {
    case "listening":
      return { _tag: "listening" };
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
     * Whether a key is saved for each cloud provider, while held. Hold it
     * only from a server whose settings carry `voice`: an older one has no
     * such subscription.
     */
    readonly cloudKeys: Effect.Effect<Readable<Loaded<CloudVoiceKeys>>, never, Scope.Scope>;
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
     * server. Only for a server whose roster snapshot carries
     * `recordingTranscripts`.
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

    const cloudKeys = makeLive<void, CloudVoiceKeys>({
      scope,
      connection,
      keyOf: () => "cloud-keys",
      follow: (_, client, set) =>
        client["voice.cloudKeys"]().pipe(Stream.runForEach((next) => set(() => next))),
    });

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
            if (Option.isSome(frame)) state.set(nextState(frame.value));
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

      const finish = Effect.gen(function* () {
        const now = state.get();
        if (now._tag !== "listening") {
          if (!isOver(now)) state.set({ _tag: "done", text: "" });
          return;
        }
        state.set({ _tag: "finishing" });
        const sent = write !== null && (yield* write(encodeClientFrame({ type: "finish" })));
        if (!sent) yield* fail("unreachable");
      });

      return { state, audio, finish } satisfies Dictation;
    });

    return Voice.of({
      cloudKeys: cloudKeys.acquire(undefined),
      cloudModels,
      setCloudKey,
      dictate: open(false),
      transcribe: open(true),
    });
  }),
);
