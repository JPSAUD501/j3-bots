// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigContext, ExpoConfig } from "expo/config";

// Expo installs TypeScript on start otherwise; the workspace typechecks with tsrs.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

/**
 * Each variant installs beside the others, with its own name, link scheme and
 * identifiers. The identifiers are development placeholders, until the ids of
 * a published build are chosen.
 */
const VARIANTS = {
  development: { name: "J3 Bots Dev", scheme: "j3bots-dev", id: "dev.j3bots.mobile.dev" },
  preview: { name: "J3 Bots Preview", scheme: "j3bots-preview", id: "dev.j3bots.mobile.preview" },
  production: { name: "J3 Bots", scheme: "j3bots", id: "dev.j3bots.mobile" },
} as const;

/** Why the app asks for the microphone: only dictation uses it. */
const MICROPHONE_USE = "J3 Bots listens while you dictate a message, and only then.";

/** Why the app asks for the camera, as the system shows it. */
const CAMERA_USE = "J3 Bots uses the camera to read the QR code that pairs this device.";

const variantOf = (value: string | undefined): keyof typeof VARIANTS => {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    case undefined:
      return "development";
    default:
      throw new Error("APP_VARIANT must be development, preview or production.");
  }
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = VARIANTS[variantOf(process.env.APP_VARIANT)];
  return {
    ...config,
    name: variant.name,
    slug: "j3-bots",
    scheme: variant.scheme,
    version: "0.0.0",
    orientation: "default",
    userInterfaceStyle: "automatic",
    ios: {
      bundleIdentifier: variant.id,
      supportsTablet: true,
      infoPlist: {
        // J3 Bots runs on the operator's own machine, often reached by a LAN
        // address over plain HTTP; the app refuses plain HTTP anywhere else.
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSLocalNetworkUsageDescription:
          "J3 Bots connects to the J3 Bots server on your own network.",
      },
    },
    android: {
      package: variant.id,
      // Added by dependencies, used by nothing the app does.
      blockedPermissions: [
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.VIBRATE",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
      ],
    },
    // No over-the-air updates: a build runs the JavaScript it was built with.
    updates: { enabled: false },
    plugins: [
      // Its defaults keep the credential out of Android's backups: a restored
      // backup could not decrypt it. The credential is read without Face ID,
      // so the app asks for no permission to use it.
      ["expo-secure-store", { faceIDPermission: false }],
      // Photos are picked through the system's photo picker, which needs no
      // permission. The camera only reads a pairing QR code, asked for when
      // the operator opens the scanner; the microphone only hears dictation,
      // asked for at the first dictation. Every plugin that names one of them
      // gets the same sentence for it: `false` in any one would block that
      // permission for the whole app on Android, the scanner or dictation
      // included. The camera records nothing, so it takes no audio.
      [
        "expo-image-picker",
        {
          photosPermission: false,
          cameraPermission: CAMERA_USE,
          microphonePermission: MICROPHONE_USE,
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission: CAMERA_USE,
          microphonePermission: MICROPHONE_USE,
          recordAudioAndroid: false,
        },
      ],
      // Dictation in the composer, with the platform's speech recognizer.
      [
        "expo-speech-recognition",
        {
          microphonePermission: MICROPHONE_USE,
          speechRecognitionPermission:
            "J3 Bots turns what you dictate into text in your message, which you send yourself.",
        },
      ],
      // Other apps' share sheets list J3 Bots on Android for text, links and
      // files of any type, one or several. iOS would need a share extension,
      // which reaches the app through an App Group, and signing one takes a
      // paid Apple developer account.
      [
        "expo-sharing",
        {
          ios: { enabled: false },
          android: {
            enabled: true,
            singleShareMimeTypes: ["*/*"],
            multipleShareMimeTypes: ["*/*"],
          },
        },
      ],
      "./plugins/cleartextToPrivateHosts.js",
      "./plugins/foldInPlace.js",
    ],
  };
};
