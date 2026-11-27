// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CloudVoiceProvider, VoiceModel, VoicePlace } from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { DictationBlock } from "../presentation/dictation.ts";
import type { DictationFailure, DictationState } from "../stores/Voice.ts";

/** A cloud provider's name, which is the same in every language. */
export const CLOUD_PROVIDER_NAMES: Record<CloudVoiceProvider, string> = {
  openai: "OpenAI",
  xai: "xAI",
  openrouter: "OpenRouter",
};

/** A size in bytes, as a download is named: "751 MB", "1.6 GB". */
export const sizeWords = (bytes: number, { locale }: I18n): string => {
  const megabytes = bytes / 1_000_000;
  const format = (value: number, unit: string) =>
    `${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${unit}`;
  return megabytes >= 1000 ? format(megabytes / 1000, "GB") : format(Math.max(megabytes, 1), "MB");
};

/** What the composer says while a dictation on the server runs; null while it only listens live. */
export const dictationStateWords = (state: DictationState, i18n: I18n): string | null => {
  switch (state._tag) {
    case "connecting":
      return i18n.t("dictation.connecting");
    case "installing":
      return i18n.t("dictation.installing", {
        received: sizeWords(state.received, i18n),
        total: sizeWords(state.total, i18n),
      });
    case "listening":
      return state.live ? i18n.t("dictation.listening") : i18n.t("dictation.listeningEnd");
    case "finishing":
      return i18n.t("dictation.finishing");
    case "tidying":
      return i18n.t("dictation.tidying");
    case "done":
      return null;
    case "failed":
      return dictationFailureWords(state.reason, i18n);
  }
};

const failures: Record<DictationFailure, KeyWith> = {
  unavailable: "dictation.failed.unavailable",
  busy: "dictation.failed.busy",
  install: "dictation.failed.install",
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

const blocks: Record<DictationBlock, KeyWith> = {
  "insecure-page": "dictation.blocked.insecurePage",
  "no-device-recognizer": "dictation.blocked.noDeviceRecognizer",
  "server-unsupported": "dictation.blocked.serverUnsupported",
  "server-unavailable": "dictation.blocked.serverUnavailable",
};

/** Why the microphone cannot dictate here, and what makes it work. */
export const dictationBlockWords = (block: DictationBlock, { t }: I18n): string => t(blocks[block]);

/** A place dictation runs, as Settings → Voice names it and says what it means. */
export const voicePlaceWords = (
  place: VoicePlace,
  { t }: I18n,
): { readonly label: string; readonly description: string } => {
  switch (place) {
    case "automatic":
      return {
        label: t("voice.place.automatic"),
        description: t("voice.place.automatic.description"),
      };
    case "device":
      return { label: t("voice.place.device"), description: t("voice.place.device.description") };
    case "server":
      return { label: t("voice.place.server"), description: t("voice.place.server.description") };
    case "openai":
    case "xai":
    case "openrouter":
      return {
        label: CLOUD_PROVIDER_NAMES[place],
        description: t("voice.place.cloud.description", { provider: CLOUD_PROVIDER_NAMES[place] }),
      };
  }
};

/** A language's name in the reader's own language, from its ISO 639-1 code. */
export const languageName = (code: string, { locale }: I18n): string => {
  const name = new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
};

/**
 * What a model is, in the words an operator chooses one by: its download, when
 * its words come, how many languages it hears, how fast it is on this server,
 * and how often it gets the reader's language wrong when that was measured.
 */
export const voiceModelWords = (model: VoiceModel, i18n: I18n): ReadonlyArray<string> => {
  const own = i18n.locale.slice(0, 2);
  const errors = model.errorPercent[own];
  return [
    i18n.t("voice.model.size", { size: sizeWords(model.size, i18n) }),
    i18n.t(model.live ? "voice.model.live" : "voice.model.atEnd"),
    i18n.plural("voice.model.languages", model.languages.length),
    ...(model.secondsPer30s === null
      ? []
      : [
          i18n.t("voice.model.speed", {
            seconds: new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 }).format(
              model.secondsPer30s,
            ),
          }),
        ]),
    ...(errors === undefined
      ? []
      : [
          i18n.t("voice.model.errors", {
            percent: new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 }).format(
              errors,
            ),
            language: new Intl.DisplayNames([i18n.locale], { type: "language" }).of(own) ?? own,
          }),
        ]),
  ];
};
