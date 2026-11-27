// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceRecognizer } from "@j3-bots/client-runtime/presentation";
import type { VoiceLanguage } from "@j3-bots/contracts";
import { getLocales } from "expo-localization";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { recognizerLocale } from "./recognition.ts";

/** The phone's own recognizer for a language: whether it hears it on the phone, and in which locale. */
export interface PhoneRecognizer {
  readonly state: DeviceRecognizer;
  /** The installed locale it listens in, while `ready`. */
  readonly locale: string | null;
}

const NONE: PhoneRecognizer = { state: "none", locale: null };

/**
 * Whether the phone can recognize speech on the phone and nowhere else.
 * Android does from 13 on, where `requiresOnDeviceRecognition` makes
 * `expo-speech-recognition` use `createOnDeviceSpeechRecognizer`; before it,
 * the module would take the default recognizer, which may go online. iOS is
 * left out: the module's check there asks about the recognizer of the
 * system's language, not of the one dictation listens for.
 */
const recognizesOnPhone = (): boolean =>
  Platform.OS === "android" &&
  typeof Platform.Version === "number" &&
  Platform.Version >= 33 &&
  ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();

/**
 * Whether the phone's own recognizer hears `language` on the phone: its
 * on-device recognizer lists the languages installed for use offline
 * (`installedOnDeviceLanguages`). One that cannot list them is taken to
 * have none of them.
 */
export const phoneRecognizer = async (language: VoiceLanguage): Promise<PhoneRecognizer> => {
  if (!recognizesOnPhone()) return NONE;
  const installed = await ExpoSpeechRecognitionModule.getSupportedLocales({}).then(
    (locales) => locales.installedLocales,
    () => [],
  );
  const phone = getLocales().map((locale) => locale.languageTag);
  const locale = recognizerLocale(language, phone, installed);
  return locale === null ? { state: "missing-language", locale: null } : { state: "ready", locale };
};

/**
 * `phoneRecognizer(language)`, read again each time the app comes to the
 * front, as after a language was installed in the phone's settings; null
 * until it is known.
 */
export function usePhoneRecognizer(language: VoiceLanguage): PhoneRecognizer | null {
  const [known, setKnown] = useState<{
    readonly language: VoiceLanguage;
    readonly recognizer: PhoneRecognizer;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void phoneRecognizer(language).then((recognizer) => {
        if (live) setKnown({ language, recognizer });
      });
    read();
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      live = false;
      watch.remove();
    };
  }, [language]);
  return known?.language === language ? known.recognizer : null;
}

/** Whether dictation may use the microphone: allowed, refused, or refused for good. */
export type MicrophoneAccess = "granted" | "denied" | "blocked";

/**
 * Asks for the microphone (`RECORD_AUDIO`), unless it is allowed already.
 * Refused for good is when Android no longer lets the app ask, as from the
 * second refusal on: only the phone's settings allow it then.
 */
export const askMicrophone = (): Promise<MicrophoneAccess> =>
  ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync().then((permission) =>
    permission.granted ? "granted" : permission.canAskAgain ? "denied" : "blocked",
  );

/** Whether the microphone is allowed now, without asking. */
export const microphoneAllowed = (): Promise<boolean> =>
  ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync().then(
    (permission) => permission.granted,
  );
