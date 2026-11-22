// SPDX-License-Identifier: AGPL-3.0-or-later
import { getLocales } from "expo-localization";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";
import { type RecognitionPlace, recognitionPlace } from "./recognition.ts";

/** Whether the platform has a speech recognizer at all; without one the composer offers no dictation. */
export const dictationAvailable = (): boolean =>
  ExpoSpeechRecognitionModule.isRecognitionAvailable();

/** The language dictation listens for: the device's first. */
export const dictationLanguage = (): string | undefined => getLocales()[0]?.languageTag;

/**
 * Where recognition of `language` would run now. Android lists the languages
 * its on-device recognizer has installed (13 and later; earlier, none). iOS
 * is taken to recognize online: the module's check there asks about the
 * recognizer of the system's language, not of `language`, and none of it has
 * been run on iOS.
 */
export const whereRecognitionRuns = async (
  language: string | undefined,
): Promise<RecognitionPlace> => {
  if (Platform.OS !== "android" || !ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
    return "online";
  }
  // A recognizer that cannot list its languages has none it can be taken to have installed.
  const installed = await ExpoSpeechRecognitionModule.getSupportedLocales({}).then(
    (locales) => locales.installedLocales,
    () => [],
  );
  return recognitionPlace(language, installed);
};
