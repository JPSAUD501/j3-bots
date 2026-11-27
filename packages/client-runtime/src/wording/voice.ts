// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CloudVoiceProvider } from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { DictationBlock } from "../presentation/dictation.ts";
import type { DictationFailure } from "../stores/Voice.ts";

/** A cloud provider's name, which is the same in every language. */
export const CLOUD_PROVIDER_NAMES: Record<CloudVoiceProvider, string> = {
  openai: "OpenAI",
  xai: "xAI",
  openrouter: "OpenRouter",
};

/** Where an operator makes a key for each provider. */
export const CLOUD_PROVIDER_KEY_PAGES: Record<CloudVoiceProvider, string> = {
  openai: "https://platform.openai.com/api-keys",
  xai: "https://console.x.ai",
  openrouter: "https://openrouter.ai/settings/keys",
};

const failures: Record<DictationFailure, KeyWith> = {
  unavailable: "dictation.failed.unavailable",
  "cloud-key": "dictation.failed.cloudKey",
  "cloud-refused": "dictation.failed.cloudRefused",
  "cloud-limit": "dictation.failed.cloudLimit",
  "cloud-model": "dictation.failed.cloudModel",
  "cloud-unavailable": "dictation.failed.cloudUnavailable",
  "too-long": "dictation.failed.tooLong",
  unreachable: "dictation.failed.unreachable",
  "not-paired": "dictation.failed.unreachable",
  failed: "dictation.failed.other",
  unknown: "dictation.failed.other",
};

/** Why a dictation ended without words, for someone who isn't technical. */
export const dictationFailureWords = (reason: DictationFailure, { t }: I18n): string =>
  t(failures[reason]);

/** Whether a dictation that ended this way is fixed in Settings → Voice. */
export const dictationFailureNeedsSetup = (reason: DictationFailure): boolean =>
  reason === "cloud-key" || reason === "cloud-refused" || reason === "cloud-model";

const blocks: Record<DictationBlock, KeyWith> = {
  "insecure-page": "dictation.blocked.insecurePage",
  "no-device-recognizer": "dictation.blocked.noDeviceRecognizer",
  setup: "dictation.blocked.setup",
};

/** Why the microphone cannot dictate here, and what makes it work. */
export const dictationBlockWords = (block: DictationBlock, { t }: I18n): string => t(blocks[block]);

/** A language's name in the reader's own language, from its ISO 639-1 code. */
export const languageName = (code: string, { locale }: I18n): string => {
  const name = new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
};

/** A recording's length as a clock shows it: "0:07", "12:30". */
export const elapsedWords = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
