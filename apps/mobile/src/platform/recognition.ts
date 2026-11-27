// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceLanguage } from "@j3-bots/contracts";

// The phone's own recognizer, run on the phone only (decision 0096): which of
// its installed languages hears the operator, and what it has heard.

/** A language tag's language, lowercased: `pt` of `pt-BR`. */
const languageOf = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? "";

const sameTag = (a: string, b: string): boolean =>
  a.toLowerCase().replaceAll("_", "-") === b.toLowerCase().replaceAll("_", "-");

/**
 * The installed locale the phone's recognizer hears `language` with, or null
 * when none of them is that language. Automatic is the phone's own first
 * language. Among the installed locales of the language, the one the phone
 * is set to wins, as `pt-BR` over `pt-PT` on a phone in Brazilian Portuguese.
 */
export const recognizerLocale = (
  language: VoiceLanguage,
  phone: ReadonlyArray<string>,
  installed: ReadonlyArray<string>,
): string | null => {
  const first = phone[0];
  const wanted = language === "auto" ? (first === undefined ? null : languageOf(first)) : language;
  if (wanted === null) return null;
  const same = installed.filter((tag) => languageOf(tag) === wanted);
  return same.find((tag) => phone.some((own) => sameTag(own, tag))) ?? same[0] ?? null;
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

/** Everything heard, finished utterances and the one still heard, as the words a stop leaves. */
export const heardText = (heard: Heard): string =>
  [...heard.final, heard.interim].filter((part) => part !== "").join(" ");
