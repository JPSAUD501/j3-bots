// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudProviderOf, type VoicePlace, type VoiceStatus } from "@j3-bots/contracts";
import type { HeardWords } from "../stores/Voice.ts";

// Where a dictation runs and how its words land in the composer (decision
// 0096). Words go where the caret was: settled ones in the text's own color,
// the ones still open to change lighter, until the operator stops.

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
  /** The server cannot run a speech model on its system. */
  | "server-unsupported"
  /** The server's engine is not running now. */
  | "server-unavailable";

/** Where this device's dictation runs, or why it cannot. */
export type DictationPath =
  /** The device's own recognizer. */
  | { readonly _tag: "device" }
  /** The server, with its local model or the cloud provider the operator chose. */
  | { readonly _tag: "server" }
  /** It cannot dictate here; the microphone says why. */
  | { readonly _tag: "blocked"; readonly block: DictationBlock }
  /** No microphone at all: a server older than dictation, and no recognizer of the device's own. */
  | { readonly _tag: "none" };

/**
 * Where dictation runs on this device.
 *
 * - `place`: the operator's choice, null from a server older than dictation
 *   through it, which only the device's own recognizer can then serve.
 * - `status`: the server's own, while known.
 * - `secureContext`: whether the page may use the microphone at all; always
 *   true in an app.
 */
export const dictationPath = (input: {
  readonly place: VoicePlace | null;
  readonly device: DeviceRecognizer;
  readonly status: VoiceStatus | null;
  readonly secureContext: boolean;
}): DictationPath => {
  const { place, device, status } = input;
  if (place === null) return device === "ready" ? { _tag: "device" } : { _tag: "none" };
  if (place === "device") {
    return device === "ready"
      ? { _tag: "device" }
      : { _tag: "blocked", block: "no-device-recognizer" };
  }
  if (place === "automatic" && device === "ready") return { _tag: "device" };
  if (!input.secureContext) return { _tag: "blocked", block: "insecure-page" };
  if (status?._tag === "unavailable") {
    // A cloud provider needs the engine, not a model it can run.
    if (status.reason === "platform" && cloudProviderOf(place) === null) {
      return { _tag: "blocked", block: "server-unsupported" };
    }
    if (status.reason !== "platform") return { _tag: "blocked", block: "server-unavailable" };
  }
  return { _tag: "server" };
};

/** Characters a word does not take a space before. */
const CLOSING = /^[\s.,!?;:…)\]}”’»%]/u;
/** Characters a word does not take a space after. */
const OPENING = /[\s([{“‘«/-]$/u;

/** Whether `after` takes a space after `before`, as two words do. */
const spaced = (before: string, after: string): boolean =>
  before !== "" && after !== "" && !OPENING.test(before) && !CLOSING.test(after);

/**
 * The text with what was heard where the caret was (`start` to `end`, which
 * it replaces), spaced from the words around it. The heard words run from
 * `from`: the settled ones to `committed`, then the ones still open to
 * change to `tentative`, where the caret goes.
 */
export const placeHeard = (
  draft: { readonly text: string; readonly start: number; readonly end: number },
  heard: HeardWords,
): {
  readonly text: string;
  readonly from: number;
  readonly committed: number;
  readonly tentative: number;
} => {
  const before = draft.text.slice(0, draft.start);
  const after = draft.text.slice(draft.end);
  const settled = heard.committed.trim();
  const open = heard.tentative.trim();
  const spoken = spaced(settled, open) ? `${settled} ${open}` : settled + open;
  const from = before.length + (spaced(before, spoken) ? 1 : 0);
  return {
    text:
      (from > before.length ? `${before} ` : before) +
      spoken +
      (spaced(spoken, after) ? " " : "") +
      after,
    from,
    committed: from + settled.length,
    tentative: from + spoken.length,
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
