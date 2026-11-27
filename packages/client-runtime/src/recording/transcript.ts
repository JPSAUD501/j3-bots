// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  cloudProviderOf,
  VOICE_SAMPLE_RATE,
  type VoiceSettings,
  type VoiceStatus,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { type Readable, waitFor } from "../Store.ts";
import type { Loaded } from "../stores/reads.ts";
import type { Synced } from "../stores/synced.ts";
import {
  type Dictation,
  type DictationFailure,
  type DictationState,
  isOver,
} from "../stores/Voice.ts";

// A screen recording's transcript (decision 0098): what the operator said
// while they recorded, written down after Stop through the server's speech
// recognition, the one dictation uses (decision 0096), never a recognizer
// of the client's own. The recording keeps a copy of its voice for this at
// the voice socket's rate. It goes in pieces of 20 to 30 seconds, each a
// dictation of its own, cut where the voice is quietest so a word is rarely
// split; a piece is short enough for a cloud provider's words, which come
// only at its end, to still say when they were said. With the server's own
// model, each word also says when it was heard: the server answers each
// piece of audio once the engine has heard it, with how much it had heard.

/** A word, and when the recognizer had heard it: ms into the recording, paused time left out. */
export interface TranscriptWord {
  readonly t: number;
  readonly text: string;
}

/**
 * What was said in one stretch of the recording, from `t` to `until`, in ms.
 * `words` is null where the recognizer gives the text only at the end, as a
 * cloud provider does.
 */
interface TranscriptSegment {
  readonly t: number;
  readonly until: number;
  readonly text: string;
  readonly words: ReadonlyArray<TranscriptWord> | null;
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

/** What the recognizer held after it had heard `heardMs` of a piece. */
interface Heard {
  readonly heardMs: number;
  readonly committed: string;
  readonly tentative: string;
}

const wordsOf = (text: string): ReadonlyArray<string> =>
  text.split(/\s+/u).filter((word) => word !== "");

/** A word as compared across what the recognizer held: no case, no punctuation. */
const keyOf = (word: string) => word.toLocaleLowerCase().replaceAll(/[\p{P}\p{S}]/gu, "");

/** Which of `final`'s words `held` has, in order (their longest common run). */
const matched = (held: ReadonlyArray<string>, final: ReadonlyArray<string>): Array<boolean> => {
  const rows = held.length + 1;
  const columns = final.length + 1;
  const lengths = new Uint16Array(rows * columns);
  for (let row = held.length - 1; row >= 0; row -= 1) {
    for (let column = final.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        held[row] === final[column]
          ? (lengths[(row + 1) * columns + column + 1] ?? 0) + 1
          : Math.max(
              lengths[(row + 1) * columns + column] ?? 0,
              lengths[row * columns + column + 1] ?? 0,
            );
    }
  }
  const found = final.map(() => false);
  let row = 0;
  let column = 0;
  while (row < held.length && column < final.length) {
    if (held[row] === final[column]) {
      found[column] = true;
      row += 1;
      column += 1;
    } else if (
      (lengths[(row + 1) * columns + column] ?? 0) >= (lengths[row * columns + column + 1] ?? 0)
    ) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return found;
};

/**
 * Each word of `text`, the piece's final words, with when it was heard: the
 * first moment from which the recognizer held it for good. A word it held
 * only in its final words was heard at the piece's end (`endMs`). Times
 * never go back from one word to the next.
 */
const timedWords = (
  heard: ReadonlyArray<Heard>,
  text: string,
  endMs: number,
): ReadonlyArray<TranscriptWord> => {
  const final = wordsOf(text);
  const keys = final.map(keyOf);
  // From the last thing held back: the moment each word has been held since,
  // for as long as every later one held it too.
  const since: Array<number | null> = final.map(() => null);
  const holding = final.map(() => true);
  for (let index = heard.length - 1; index >= 0; index -= 1) {
    const now = heard[index];
    if (now === undefined) continue;
    const held = matched(wordsOf(`${now.committed} ${now.tentative}`).map(keyOf), keys);
    for (const [word, has] of held.entries()) {
      if (!holding[word]) continue;
      if (has) since[word] = now.heardMs;
      else holding[word] = false;
    }
    if (!holding.includes(true)) break;
  }
  let floor = 0;
  return final.map((word, index) => {
    const t = Math.min(endMs, Math.max(floor, since[index] ?? endMs));
    floor = t;
    return { t, text: word };
  });
};

/** How one piece's dictation ended. */
type PieceOutcome =
  | { readonly _tag: "heard"; readonly text: string; readonly heard: ReadonlyArray<Heard> }
  | { readonly _tag: "failed"; readonly reason: DictationFailure | "no-model" };

/** What `writeDown` needs of the client. */
export interface TranscriptServices {
  /** Whether the server writes down a recording's voice (`recordingTranscripts`). */
  readonly takesTranscripts: Readable<boolean>;
  /** The operator's settings, of which only dictation's matter here. */
  readonly settings: Readable<Synced<{ readonly voice: VoiceSettings | null }>>;
  /** The server's speech recognition as `Voice.status` holds it. */
  readonly voiceStatus: Effect.Effect<Readable<Loaded<VoiceStatus>>, never, Scope.Scope>;
  /** `Voice.transcribe`. */
  readonly transcribe: Effect.Effect<Dictation, never, Scope.Scope>;
}

/** How long to wait for the settings or the server's status before going without. */
const READ_WAIT = "20 seconds";
/** Between tries while another device dictates. */
const BUSY_RETRY = "3 seconds";
/** How long to keep trying while another device dictates, in tries. */
const BUSY_TRIES = 40;
/** Tries of a piece whose dictation broke off, as when the connection dropped. */
const BROKEN_TRIES = 3;
/** The most one piece may take: the engine gives up on one far sooner. */
const PIECE_WAIT = "5 minutes";

/** Whether the operator's settings and the server let a recording's voice be written down now. */
const allowed = Effect.fnUntraced(function* (services: TranscriptServices) {
  if (!services.takesTranscripts.get()) return false;
  const settings = yield* waitFor(services.settings, (now) => now._tag === "ready").pipe(
    Effect.timeoutOption(READ_WAIT),
  );
  if (settings._tag === "None" || settings.value._tag !== "ready") return false;
  const voice = settings.value.value.voice;
  // The desktop has no recognizer of its own: dictation is off here.
  if (voice === null || voice.place === "device") return false;
  // A cloud provider that cannot take it answers so; nothing is installed for one.
  if (cloudProviderOf(voice.place) !== null) return true;
  const status = yield* services.voiceStatus;
  const loaded = yield* waitFor(status, (now) => now._tag !== "loading").pipe(
    Effect.timeoutOption(READ_WAIT),
  );
  if (loaded._tag === "None" || loaded.value._tag !== "ready") return false;
  const now = loaded.value.value;
  // A recording never starts the model's download: that is dictation's to ask for.
  return now._tag === "available" && now.model.installed && now.installing === null;
}, Effect.scoped);

/** One piece of the voice through one dictation, telling `heardMs` each time more was heard. */
const onePiece = Effect.fnUntraced(
  function* (services: TranscriptServices, pcm: Uint8Array, onHeard: (heardMs: number) => void) {
    const dictation = yield* services.transcribe;
    const heard: Array<Heard> = [];
    const unsubscribe = dictation.state.subscribe(() => {
      const now = dictation.state.get();
      if ((now._tag !== "listening" && now._tag !== "finishing") || now.heardMs === undefined) {
        return;
      }
      heard.push({ heardMs: now.heardMs, committed: now.committed, tentative: now.tentative });
      onHeard(now.heardMs);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const opened = yield* waitFor(dictation.state, (now) => now._tag !== "connecting");
    if (opened._tag === "installing") return { _tag: "failed", reason: "no-model" } as const;
    if (opened._tag === "listening") {
      for (let offset = 0; offset < pcm.byteLength; offset += FRAME_BYTES) {
        yield* dictation.audio(pcm.subarray(offset, offset + FRAME_BYTES));
      }
      yield* dictation.finish();
    }
    const ended: DictationState = yield* waitFor(dictation.state, isOver);
    return ended._tag === "done"
      ? ({ _tag: "heard", text: ended.text.trim(), heard } as const)
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

/** One piece, tried again while the server is busy with another dictation or the link broke. */
const piece = Effect.fnUntraced(function* (
  services: TranscriptServices,
  pcm: Uint8Array,
  onHeard: (heardMs: number) => void,
) {
  let busy = 0;
  let broken = 0;
  while (true) {
    const outcome: PieceOutcome = yield* onePiece(services, pcm, onHeard);
    if (outcome._tag === "heard") return outcome;
    switch (outcome.reason) {
      case "busy":
        busy += 1;
        if (busy >= BUSY_TRIES) return outcome;
        yield* Effect.sleep(BUSY_RETRY);
        continue;
      case "unreachable":
      case "failed":
      case "unknown":
        broken += 1;
        if (broken >= BROKEN_TRIES) return outcome;
        yield* Effect.sleep(BUSY_RETRY);
        continue;
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
 * Writes down a recording's voice through the server's speech recognition,
 * telling `progress` the share done, from 0 to 1. Null when it goes without
 * a transcript: the server is older, dictation is off on this computer (the
 * operator chose this device's own recognizer, which a computer lacks), the
 * server has no speech model installed, or the recognition failed. It never
 * starts a model's download.
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
    const from = start;
    const outcome = yield* piece(services, bytes.subarray(0, end * SAMPLE_BYTES), (heardMs) =>
      progress(Math.min(1, (from + heardMs * MS) / total)),
    );
    if (outcome._tag === "failed") return null;
    const t = Math.round(from / MS);
    const until = Math.round((from + end) / MS);
    if (outcome.text !== "") {
      segments.push({
        t,
        until,
        text: outcome.text,
        words:
          outcome.heard.length === 0
            ? null
            : timedWords(outcome.heard, outcome.text, until - t).map((word) => ({
                t: t + word.t,
                text: word.text,
              })),
      });
    }
    start += end;
    progress(start / total);
  }
  return { segments } satisfies RecordingTranscript;
});
