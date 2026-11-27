// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CloudVoiceKeys,
  type CloudVoiceModel,
  type CloudVoiceProvider,
  HTTP_PATHS,
  MAX_VOICE_FRAME_BYTES,
  MAX_VOICE_SECONDS,
  VOICE_SAMPLE_RATE,
  VoiceClientFrame,
  type VoiceFailure,
  VoiceServerFrame,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { Connection, type NotPaired, ReconnectPolicy } from "../connection/Connection.ts";
import type { ServerUnreachable } from "../connection/http.ts";
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
   * little-endian (`VOICE_SAMPLE_RATE`). What is recorded while the socket
   * opens is held and goes once the server listens, so the first words are
   * not lost; after Stop, or once the dictation ended, a piece is dropped.
   * A piece over `MAX_VOICE_FRAME_BYTES` goes in parts.
   */
  readonly audio: (pcm: Uint8Array) => Effect.Effect<void>;
  /**
   * The operator stopped. Before the server listens, it is finishing, and
   * the server is told once what was held has gone.
   */
  readonly finish: Effect.Effect<void>;
}

/** The most a dictation holds while its socket opens: as much as the server takes in one. */
const MAX_HELD_BYTES = MAX_VOICE_SECONDS * VOICE_SAMPLE_RATE * 4;

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

/**
 * One dictation on the voice socket at `address`, opened with the
 * `WebSocketConstructor` in context, for as long as its scope lives.
 * `transcript` asks for a piece of a screen recording's voice.
 */
export const openDictation = Effect.fnUntraced(function* (
  address: Effect.Effect<string, NotPaired | ServerUnreachable>,
  openTimeout: Duration.Input,
  transcript: boolean,
) {
  const state = new Cell<DictationState>({ _tag: "connecting" });
  /** Writes on the open socket; false once it is closed. */
  let write: ((data: string | Uint8Array) => Effect.Effect<boolean>) | null = null;
  /** What was recorded before the server listened, oldest first. */
  const held: Array<Uint8Array> = [];
  let heldBytes = 0;
  /** Whether the operator stopped before the server listened. */
  let stoppedEarly = false;
  /** Writes `pcm` in frames the server takes; false once the socket is closed. */
  const send = Effect.fnUntraced(function* (pcm: Uint8Array) {
    for (let offset = 0; offset < pcm.byteLength; offset += MAX_VOICE_FRAME_BYTES) {
      const piece = pcm.subarray(offset, offset + MAX_VOICE_FRAME_BYTES);
      if (write === null || !(yield* write(piece))) return false;
    }
    return true;
  });
  const fail = (reason: DictationFailure) =>
    Effect.sync(() => {
      if (!isOver(state.get())) state.set({ _tag: "failed", reason });
    });

  const run = Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(yield* address, { openTimeout });
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
        if (Option.isNone(frame)) continue;
        const next = nextState(frame.value);
        if (next._tag !== "listening" || isOver(state.get())) {
          state.set(next);
          continue;
        }
        // Held pieces go first; one recorded meanwhile joins them, so the order holds.
        for (let piece = held.shift(); piece !== undefined; piece = held.shift()) {
          if (!(yield* send(piece))) break;
        }
        held.length = 0;
        heldBytes = 0;
        if (!stoppedEarly) {
          state.set(next);
          continue;
        }
        const told = write !== null && (yield* write(encodeClientFrame({ type: "finish" })));
        if (!told) yield* fail("unreachable");
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
    const now = state.get()._tag;
    if (now === "connecting") {
      if (heldBytes + pcm.byteLength > MAX_HELD_BYTES) return;
      held.push(pcm.slice());
      heldBytes += pcm.byteLength;
      return;
    }
    if (now === "listening") yield* send(pcm);
  });

  const finish = Effect.gen(function* () {
    const now = state.get();
    if (now._tag === "connecting") {
      stoppedEarly = true;
      state.set({ _tag: "finishing" });
      return;
    }
    if (now._tag !== "listening") return;
    state.set({ _tag: "finishing" });
    const sent = write !== null && (yield* write(encodeClientFrame({ type: "finish" })));
    if (!sent) yield* fail("unreachable");
  });

  return { state, audio, finish } satisfies Dictation;
});

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

    const open = (transcript: boolean) =>
      openDictation(
        connection.socketAddress(HTTP_PATHS.voice, {}),
        policy.openTimeout,
        transcript,
      ).pipe(Effect.provideService(Socket.WebSocketConstructor, makeWebSocket));

    return Voice.of({
      cloudKeys: cloudKeys.acquire(undefined),
      cloudModels,
      setCloudKey,
      dictate: open(false),
      transcribe: open(true),
    });
  }),
);
