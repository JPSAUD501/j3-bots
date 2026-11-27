// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CloudVoiceKeys, type VoiceSettings, voiceProviderOf } from "@j3-bots/contracts";

// Where a dictation runs and how its words land in the composer (decisions
// 0096 and 0107). Words go where the caret was when the operator started,
// moved along with what they typed meanwhile.

/**
 * Whether this device has a speech recognizer of its own for the language,
 * which recognizes on the device and nowhere else:
 *
 * - `ready`: it has, with the language installed;
 * - `missing-language`: it has, without that language;
 * - `none`: it has none, as a browser or the desktop app.
 */
export type DeviceRecognizer = "ready" | "missing-language" | "none";

/** Why the microphone cannot dictate here, in a form the composer explains. */
export type DictationBlock =
  /**
   * The page is served over plain `http:` from another machine: a browser
   * gives no microphone there. The desktop app, the Android app or an
   * `https:` address can.
   */
  | "insecure-page"
  /** The operator chose this device's own recognizer, and it has none, or not the language. */
  | "no-device-recognizer"
  /**
   * No service is chosen to write down what the operator says, its key is
   * not saved, or OpenRouter has no model chosen: the microphone opens
   * Settings → Voice.
   */
  | "setup";

/** Where this device's dictation runs, or why it cannot. */
export type DictationPath =
  /** The device's own recognizer. */
  | { readonly _tag: "device" }
  /** The server, which sends the recording to the cloud provider chosen. */
  | { readonly _tag: "server" }
  /** It cannot dictate here; the microphone says why. */
  | { readonly _tag: "blocked"; readonly block: DictationBlock }
  /**
   * No microphone at all: a server before dictation through a cloud
   * provider (`VoiceSettings.provider` absent), and no recognizer of the
   * device's own.
   */
  | { readonly _tag: "none" };

/**
 * Where dictation runs on this device.
 *
 * - `voice`: the operator's choice, null from a server before dictation.
 * - `keys`: which providers have a key saved, while known.
 * - `secureContext`: whether the page may use the microphone at all; always
 *   true in an app.
 */
export const dictationPath = (input: {
  readonly voice: VoiceSettings | null;
  readonly device: DeviceRecognizer;
  readonly keys: CloudVoiceKeys | null;
  readonly secureContext: boolean;
}): DictationPath => {
  const { voice, device, keys } = input;
  const own = device === "ready" ? ({ _tag: "device" } as const) : null;
  // A server older than cloud dictation: only the device's own recognizer.
  if (voice === null || voice.provider === undefined) return own ?? { _tag: "none" };
  if (voice.place === "device") return own ?? { _tag: "blocked", block: "no-device-recognizer" };
  if (voice.place === "automatic" && own !== null) return own;
  if (!input.secureContext) return { _tag: "blocked", block: "insecure-page" };
  const provider = voiceProviderOf(voice);
  if (
    provider === null ||
    keys?.[provider] === false ||
    (provider === "openrouter" && voice.openRouterModel === null)
  ) {
    return { _tag: "blocked", block: "setup" };
  }
  return { _tag: "server" };
};

/**
 * Where words dictated into `before`, at `start` to `end`, go once it became
 * `after`, as the operator typed meanwhile: moved along with the text before
 * them, and to the end of an edit that ran over them. `caret`, where the
 * caret stands in `after` once the operator's own edit is in, places that
 * edit: without it, typing the letter that follows the words' place would
 * read as typed after it.
 */
export const followTyping = (
  at: { readonly start: number; readonly end: number },
  before: string,
  after: string,
  caret?: number,
): { readonly start: number; readonly end: number } => {
  if (before === after) return at;
  const shortest = Math.min(before.length, after.length);
  const same = (limit: number, alike: (index: number) => boolean) => {
    let count = 0;
    while (count < limit && alike(count)) count += 1;
    return count;
  };
  const fromStart = (index: number) => before[index] === after[index];
  const fromEnd = (index: number) =>
    before[before.length - 1 - index] === after[after.length - 1 - index];
  let head: number;
  let tail: number;
  if (caret === undefined) {
    head = same(shortest, fromStart);
    tail = same(shortest - head, fromEnd);
  } else {
    // The edit ends at the caret: what follows it is as it was.
    tail = same(
      Math.min(shortest, after.length - Math.min(Math.max(caret, 0), after.length)),
      fromEnd,
    );
    head = same(shortest - tail, fromStart);
  }
  // The edit replaced `before`'s [head, before.length - tail) with after's [head, after.length - tail).
  const changedEnd = before.length - tail;
  const shift = after.length - before.length;
  if (changedEnd <= at.start) return { start: at.start + shift, end: at.end + shift };
  if (head >= at.end) return at;
  const end = after.length - tail;
  return { start: end, end };
};

/** Characters a word does not take a space before. */
const CLOSING = /^[\s.,!?;:…)\]}”’»%]/u;
/** Characters a word does not take a space after. */
const OPENING = /[\s([{“‘«/-]$/u;

/** Whether `after` takes a space after `before`, as two words do. */
const spaced = (before: string, after: string): boolean =>
  before !== "" && after !== "" && !OPENING.test(before) && !CLOSING.test(after);

/**
 * The text with `words` where the caret was (`start` to `end`, which they
 * replace), spaced from the words around them. They run from `from` to
 * `end`, where the caret goes.
 */
export const placeHeard = (
  draft: { readonly text: string; readonly start: number; readonly end: number },
  words: string,
): { readonly text: string; readonly from: number; readonly end: number } => {
  const before = draft.text.slice(0, draft.start);
  const after = draft.text.slice(draft.end);
  const spoken = words.trim();
  const from = before.length + (spaced(before, spoken) ? 1 : 0);
  return {
    text:
      (from > before.length ? `${before} ` : before) +
      spoken +
      (spaced(spoken, after) ? " " : "") +
      after,
    from,
    end: from + spoken.length,
  };
};

/** The level a meter shows for a piece of a recording: 0 for silence, 1 for full scale. */
export const levelOf = (samples: Float32Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  if (rms === 0) return 0;
  // From -60 dBFS, below which speech does not reach, to full scale.
  const decibels = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (decibels + 60) / 60));
};
