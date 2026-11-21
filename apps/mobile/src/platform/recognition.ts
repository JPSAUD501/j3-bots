// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the platform's speech recognizer turns speech into text: on this
 * device, or through its speech service online, which may send the audio
 * to the service's provider.
 */
export type RecognitionPlace = "device" | "online";

/**
 * Recognition runs on the device when it has an on-device recognizer and,
 * where the platform lists them, the model for `language` is installed; a
 * language that would first need a download is recognized online.
 * `installed` is null where the platform does not list installed languages.
 */
export const recognitionPlace = (
  language: string | undefined,
  onDevice: {
    readonly recognizer: boolean;
    readonly installed: ReadonlyArray<string> | null;
  },
): RecognitionPlace => {
  if (!onDevice.recognizer || language === undefined) return "online";
  if (onDevice.installed === null) return "device";
  const wanted = language.toLowerCase();
  return onDevice.installed.some((tag) => tag.toLowerCase() === wanted) ? "device" : "online";
};

/**
 * What has been heard so far. With continuous recognition each final result
 * is a new utterance, and the interim results cover only the one still being
 * heard, so the text is every final utterance, then the interim one.
 */
export interface Heard {
  readonly final: ReadonlyArray<string>;
  readonly interim: string;
}

export const nothingHeard: Heard = { final: [], interim: "" };

/** `heard` after a result whose best transcript is `transcript`. */
export const hear = (heard: Heard, transcript: string, isFinal: boolean): Heard => {
  const said = transcript.trim();
  if (!isFinal) return { final: heard.final, interim: said };
  return { final: said === "" ? heard.final : [...heard.final, said], interim: "" };
};

/** The text of what has been heard, as it goes into the draft. */
export const heardText = (heard: Heard): string =>
  (heard.interim === "" ? heard.final : [...heard.final, heard.interim]).join(" ");
