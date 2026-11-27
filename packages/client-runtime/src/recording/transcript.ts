// SPDX-License-Identifier: AGPL-3.0-or-later
import { VOICE_SAMPLE_RATE, type VoiceSettings, voiceProviderOf } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { ConnectionState } from "../connection/Connection.ts";
import { type Readable, waitFor } from "../Store.ts";
import type { Synced } from "../stores/synced.ts";
import {
  type Dictation,
  type DictationFailure,
  type DictationState,
  isOver,
} from "../stores/Voice.ts";

// A screen recording's transcript (decisions 0098 and 0107): what the
// operator said while they recorded, written down after Stop by the cloud
// provider dictation uses, through the server, never a recognizer of the
// client's own. Only with a provider chosen; without one the recording goes
// with its voice and no transcript. The recording keeps a copy of its voice
// for this at the voice socket's rate. It goes in pieces of 20 to 30 seconds,
// each a dictation of its own, cut where the voice is quietest so a word is
// rarely split: the provider's words come only at a piece's end, so a piece
// is short enough for its words to still say when they were said.

/** What was said in one stretch of the recording, from `t` to `until`, in ms. */
interface TranscriptSegment {
  readonly t: number;
  readonly until: number;
  readonly text: string;
}

/** A recording's transcript: each stretch where something was said, in order. */
export interface RecordingTranscript {
  readonly segments: ReadonlyArray<TranscriptSegment>;
}

/**
 * A recording's voice, as the device keeps it for its transcript: mono 32-bit
 * float PCM, little-endian, at `VOICE_SAMPLE_RATE`.
 */
export interface RecordingSpeech {
  /** Bytes. */
  readonly size: number;
  /** Bytes `[start, end)`; null, or a rejection, once the device can no longer read them. */
  readonly read: (start: number, end: number) => Promise<Uint8Array | null>;
}

const SAMPLE_BYTES = 4;
const MS = VOICE_SAMPLE_RATE / 1000;
/** The longest piece of the voice one dictation takes, in samples. */
const PIECE_LONGEST = 30 * VOICE_SAMPLE_RATE;
/** The shortest piece cut before the voice's end, in samples. */
const PIECE_SHORTEST = 20 * VOICE_SAMPLE_RATE;
/** The stretch whose loudness is weighed for a cut: a tenth of a second. */
const WINDOW = VOICE_SAMPLE_RATE / 10;
/** What one audio frame of a piece holds: a quarter second, which is how finely a word is timed. */
const FRAME_BYTES = (VOICE_SAMPLE_RATE / 4) * SAMPLE_BYTES;

/**
 * Where a piece of the voice starting at `samples`' first ends, in samples:
 * at its end when they are the rest of the voice (`last`) and fit one piece,
 * otherwise in the middle of the quietest tenth of a second between 20 and
 * 30 seconds in.
 */
const pieceEnd = (samples: Float32Array, last: boolean): number => {
  if (last && samples.length <= PIECE_LONGEST) return samples.length;
  const reach = Math.min(samples.length, PIECE_LONGEST);
  let best = reach;
  let quietest = Number.POSITIVE_INFINITY;
  for (let at = PIECE_SHORTEST; at + WINDOW <= reach; at += WINDOW) {
    let energy = 0;
    for (let index = at; index < at + WINDOW; index += 1) {
      const sample = samples[index] ?? 0;
      energy += sample * sample;
    }
    if (energy < quietest) {
      quietest = energy;
      best = at + WINDOW / 2;
    }
  }
  return best;
};

/** How one piece's dictation ended. */
type PieceOutcome =
  | { readonly _tag: "heard"; readonly text: string }
  | { readonly _tag: "failed"; readonly reason: DictationFailure };

/** What `writeDown` needs of the client. */
export interface TranscriptServices {
  /** Whether the server writes down a recording's voice (`recordingTranscripts`). */
  readonly takesTranscripts: Readable<boolean>;
  /** The client's link to the server, which a piece waits on when it broke. */
  readonly connection: Readable<ConnectionState>;
  /** The operator's settings, of which only dictation's matter here. */
  readonly settings: Readable<Synced<{ readonly voice: VoiceSettings | null }>>;
  /** `Voice.transcribe`. */
  readonly transcribe: Effect.Effect<Dictation, never, Scope.Scope>;
}

/** How long to wait for the settings before going without. */
const READ_WAIT = "20 seconds";
/** Between tries of a piece. */
const RETRY = "3 seconds";
/** Tries of a piece whose dictation broke off, as when the connection dropped. */
const BROKEN_TRIES = 3;
/** How long a piece whose link broke waits for the connection to come back. */
const RECONNECT_WAIT = "10 minutes";
/** The most one piece may take: a provider gives up on one far sooner. */
const PIECE_WAIT = "5 minutes";

/** Whether the operator's settings and the server let a recording's voice be written down now. */
const allowed = Effect.fnUntraced(function* (services: TranscriptServices) {
  if (!services.takesTranscripts.get()) return false;
  const settings = yield* waitFor(services.settings, (now) => now._tag === "ready").pipe(
    Effect.timeoutOption(READ_WAIT),
  );
  if (settings._tag === "None" || settings.value._tag !== "ready") return false;
  const voice = settings.value.value.voice;
  // A provider chosen: one without its key answers so on the first piece.
  return voice !== null && voiceProviderOf(voice) !== null;
});

/** One piece of the voice through one dictation. */
const onePiece = Effect.fnUntraced(
  function* (services: TranscriptServices, pcm: Uint8Array) {
    const dictation: Dictation = yield* services.transcribe;
    const opened = yield* waitFor(dictation.state, (now) => now._tag !== "connecting");
    if (opened._tag === "listening") {
      for (let offset = 0; offset < pcm.byteLength; offset += FRAME_BYTES) {
        yield* dictation.audio(pcm.subarray(offset, offset + FRAME_BYTES));
      }
      yield* dictation.finish;
    }
    const ended: DictationState = yield* waitFor(dictation.state, isOver);
    return ended._tag === "done"
      ? ({ _tag: "heard", text: ended.text.trim() } as const)
      : ended._tag === "failed"
        ? ({ _tag: "failed", reason: ended.reason } as const)
        : ({ _tag: "failed", reason: "failed" } as const);
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: PIECE_WAIT,
        orElse: () => Effect.succeed({ _tag: "failed", reason: "failed" } as const),
      }),
    ),
  Effect.scoped,
);

/** One piece, tried again when its link broke, once the connection is back. */
const piece = Effect.fnUntraced(function* (services: TranscriptServices, pcm: Uint8Array) {
  let broken = 0;
  while (true) {
    const outcome: PieceOutcome = yield* onePiece(services, pcm);
    if (outcome._tag === "heard") return outcome;
    switch (outcome.reason) {
      case "unreachable":
      case "failed":
      case "unknown": {
        broken += 1;
        if (broken >= BROKEN_TRIES) return outcome;
        yield* Effect.sleep(RETRY);
        const back = yield* waitFor(services.connection, (now) => now._tag === "connected").pipe(
          Effect.timeoutOption(RECONNECT_WAIT),
        );
        if (Option.isNone(back)) return outcome;
        continue;
      }
      default:
        return outcome;
    }
  }
});

/** Bytes `[start, end)` of the voice; null once the device cannot read them. */
const readSpeech = (speech: RecordingSpeech, start: number, end: number) =>
  Effect.promise(() => speech.read(start, end).catch(() => null)).pipe(
    Effect.map((bytes) => (bytes === null || bytes.byteLength !== end - start ? null : bytes)),
  );

/** The samples of `bytes`, little-endian 32-bit floats. */
const samplesOf = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / SAMPLE_BYTES));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(index * SAMPLE_BYTES, true);
  }
  return samples;
};

/**
 * Writes down a recording's voice through the cloud provider dictation uses,
 * telling `progress` the share done, from 0 to 1. Null when it goes without
 * a transcript: the server is older, no provider is chosen or its key is not
 * saved, dictation is off on this computer (the operator chose this device's
 * own recognizer, which a computer lacks), or the recognition failed.
 */
export const writeDown = Effect.fn("Transcript.writeDown")(function* (
  services: TranscriptServices,
  speech: RecordingSpeech,
  progress: (done: number) => void,
) {
  const total = Math.floor(speech.size / SAMPLE_BYTES);
  if (total === 0 || !(yield* allowed(services))) return null;
  const segments: Array<TranscriptSegment> = [];
  let start = 0;
  while (start < total) {
    const reach = Math.min(PIECE_LONGEST, total - start);
    const bytes = yield* readSpeech(speech, start * SAMPLE_BYTES, (start + reach) * SAMPLE_BYTES);
    if (bytes === null) return null;
    const end = pieceEnd(samplesOf(bytes), start + reach === total);
    const outcome = yield* piece(services, bytes.subarray(0, end * SAMPLE_BYTES));
    if (outcome._tag === "failed") return null;
    if (outcome.text !== "") {
      segments.push({
        t: Math.round(start / MS),
        until: Math.round((start + end) / MS),
        text: outcome.text,
      });
    }
    start += end;
    progress(start / total);
  }
  return { segments } satisfies RecordingTranscript;
});
