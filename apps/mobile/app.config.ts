// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Expo reads this config in its Node process, outside any Effect program.
import * as NodePath from "node:path";
import nativeColors from "@j3-bots/design-tokens/icons/colors.json";
import type { ConfigContext, ExpoConfig } from "expo/config";

// Expo installs TypeScript on start otherwise; the workspace typechecks with tsrs.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

/**
 * Each variant installs beside the others, with its own name, link scheme and
 * identifiers. Production is the one a release publishes: an Android phone
 * takes a new release as an update only while its application id and its
 * signing key stay the same (docs/operations/releasing.md).
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

/**
 * An icon generated from the design tokens (`pnpm --filter
 * @j3-bots/design-tokens generate`), as a path from the project's root, which
 * prebuild reads. Expo embeds the config in the app, so an absolute path would
 * carry the machine that built it.
 */
const iconIn = (projectRoot: string) => (name: string) =>
  NodePath.relative(projectRoot, require.resolve(`@j3-bots/design-tokens/icons/${name}`));

/**
 * The canvas the app opens on, in each theme: its first screen, and what
 * shows before it. The accent colors what the system draws for the app.
 */
const { canvas, accent } = nativeColors;

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

/**
 * What a build needs to receive pushes, from the environment it is built in:
 * the EAS project whose push credentials Expo's push service holds, and, for
 * Android, that project's Firebase config file. Neither is in the repository:
 * both belong to whoever publishes the build. A build without them runs, and
 * cannot turn notifications on.
 */
const fromEnvironment = (value: string | undefined) => (value === "" ? undefined : value);
const pushProjectId = fromEnvironment(process.env.EAS_PROJECT_ID);
const googleServicesFile = fromEnvironment(process.env.GOOGLE_SERVICES_JSON);

/**
 * Android installs an APK over the app only when its version code is not
 * lower than the installed one's. The release workflow gives each release a
 * higher one; any other build is 1.
 */
const versionCodeOf = (value: string | undefined): number => {
  if (value === undefined) return 1;
  const code = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || code > 2_100_000_000)
    throw new Error("ANDROID_VERSION_CODE must be a whole number from 1 to 2100000000.");
  return code;
};

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  const variantName = variantOf(process.env.APP_VARIANT);
  const variant = VARIANTS[variantName];
  const icon = iconIn(projectRoot);
  return {
    ...config,
    name: variant.name,
    slug: "j3-bots",
    scheme: variant.scheme,
    // No version here: Expo takes package.json's, which the release workflow
    // sets to the tag's.
    orientation: "default",
    userInterfaceStyle: "automatic",
    // The light theme's; plugins/accentColor.js adds the dark one.
    primaryColor: accent.light,
    // Android's launcher before adaptive icons, and iOS where it takes no variants.
    icon: icon("square.png"),
    ios: {
      bundleIdentifier: variant.id,
      icon: {
        light: icon("square.png"),
        dark: icon("square-dark.png"),
        tinted: icon("square-tinted.png"),
      },
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
      versionCode: versionCodeOf(process.env.ANDROID_VERSION_CODE),
      adaptiveIcon: {
        foregroundImage: icon("adaptive-foreground.png"),
        monochromeImage: icon("adaptive-monochrome.png"),
        backgroundColor: canvas.light,
      },
      ...(googleServicesFile === undefined ? {} : { googleServicesFile }),
      // Added by dependencies, used by nothing the app does. Notifications
      // vibrate through their channel, which needs no permission, and the app
      // schedules none to set up again after a restart.
      blockedPermissions: [
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.VIBRATE",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.RECEIVE_BOOT_COMPLETED",
      ],
    },
    ...(pushProjectId === undefined
      ? {}
      : { extra: { ...config.extra, eas: { projectId: pushProjectId } } }),
    // No over-the-air updates: a build runs the JavaScript it was built with.
    updates: { enabled: false },
    plugins: [
      // The splash screen on the canvas of the theme the system is in, with
      // the ensemble in that theme's colors. It stays until the first screen
      // has drawn in the operator's theme (index.ts).
      [
        "expo-splash-screen",
        {
          backgroundColor: canvas.light,
          image: icon("splash-light.png"),
          imageWidth: 288,
          dark: { backgroundColor: canvas.dark, image: icon("splash-dark.png") },
        },
      ],
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
      [
        "expo-notifications",
        {
          // A push that names no channel, as from a server older than the
          // channels, shows with a bot's messages.
          defaultChannel: "message",
          // Apple's development push environment for development builds.
          mode: variantName === "development" ? "development" : "production",
          // Android draws a notification's icon from its alpha alone: the
          // launcher icon, which is opaque, would show as a white square.
          icon: icon("notification.png"),
          // What Android tints the icon with in the notification itself. It
          // takes one color, so the light theme's, as `primaryColor`.
          color: accent.light,
        },
      ],
      "./plugins/accentColor.js",
      "./plugins/cleartextToPrivateHosts.js",
      "./plugins/foldInPlace.js",
    ],
  };
};
