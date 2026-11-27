// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Expo reads this config in its Node process, outside any Effect program.
import * as NodePath from "node:path";
import fontFaces from "@j3-bots/design-tokens/fonts.json";
import nativeColors from "@j3-bots/design-tokens/icons/colors.json";
import type { ConfigContext, ExpoConfig } from "expo/config";
import packageJson from "./package.json";
import { androidVersionCode } from "./src/androidVersionCode.ts";

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
 * The bundled faces (packages/design-tokens/fonts), embedded at build time.
 * Android takes each family with its weights, so a `fontWeight` picks the
 * file; iOS reads the family from each file.
 */
const fontsIn = (projectRoot: string) => {
  const path = (file: string) =>
    NodePath.relative(projectRoot, require.resolve(`@j3-bots/design-tokens/fonts/${file}.ttf`));
  const families = [...new Set(fontFaces.map((face) => face.family))];
  return {
    android: {
      fonts: families.map((fontFamily) => ({
        fontFamily,
        fontDefinitions: fontFaces
          .filter((face) => face.family === fontFamily)
          .map((face) => ({ path: path(face.file), weight: face.weight })),
      })),
    },
    ios: { fonts: fontFaces.map((face) => path(face.file)) },
  };
};

/**
 * The canvas the app opens on, in each theme: its first screen, and what
 * shows before it. The accent colors what the system draws for the app, and
 * the color of the icon's light tints a notification's icon.
 */
const { canvas, accent, iconLight } = nativeColors;

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
 * Where the app takes its own update from (src/update/feed.ts). The release
 * build reads the project's releases and trusts only the release key it
 * carries. A preview or development build updates itself only when it is
 * built for a release server of its own, with that server's public key: the
 * device checks of the update do so. The release build refuses both, and
 * the app that installs as J3 Bots ignores a test feed whatever its config
 * says (src/update/appUpdate.ts), so it trusts no other key.
 */
const testFeed = fromEnvironment(process.env.J3_APP_UPDATE_FEED);
const testKey = fromEnvironment(process.env.J3_APP_UPDATE_KEY);

const appUpdateOf = (variantName: keyof typeof VARIANTS) => {
  if (variantName === "production") {
    if (testFeed !== undefined || testKey !== undefined)
      throw new Error(
        "J3_APP_UPDATE_FEED and J3_APP_UPDATE_KEY are for preview and development builds only.",
      );
    return { _tag: "release" } as const;
  }
  if (testFeed === undefined && testKey === undefined) return undefined;
  if (testFeed === undefined || testKey === undefined)
    throw new Error("J3_APP_UPDATE_FEED and J3_APP_UPDATE_KEY go together.");
  return { _tag: "test", feed: testFeed, key: testKey } as const;
};

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  const variantName = variantOf(process.env.APP_VARIANT);
  const variant = VARIANTS[variantName];
  const icon = iconIn(projectRoot);
  const appUpdate = appUpdateOf(variantName);
  const extra = {
    ...config.extra,
    ...(pushProjectId === undefined ? {} : { eas: { projectId: pushProjectId } }),
    ...(appUpdate === undefined ? {} : { appUpdate }),
  };
  return {
    ...config,
    name: variant.name,
    slug: "j3-bots",
    scheme: variant.scheme,
    // The release workflow sets package.json's version to the tag's.
    version: packageJson.version,
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
      versionCode: androidVersionCode(packageJson.version),
      adaptiveIcon: {
        // The plate is shaded, so it is a layer of its own and not a color.
        backgroundImage: icon("adaptive-background.png"),
        foregroundImage: icon("adaptive-foreground.png"),
        monochromeImage: icon("adaptive-monochrome.png"),
      },
      ...(googleServicesFile === undefined ? {} : { googleServicesFile }),
      // A bot template tapped in a mail or a chat opens in the app, when the
      // app that holds it kept the media type J3 Bots shared it with
      // (TEMPLATE_MEDIA_TYPE in packages/contracts). Android knows no media
      // type for `.j3bot`, so any other reaches the app through the share sheet.
      intentFilters: [
        {
          action: "VIEW",
          category: ["DEFAULT", "BROWSABLE"],
          data: [
            { scheme: "content", mimeType: "application/vnd.j3bots.bot+json" },
            { scheme: "file", mimeType: "application/vnd.j3bots.bot+json" },
          ],
        },
      ],
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
    extra,
    // No over-the-air updates: a build runs the JavaScript it was built with.
    updates: { enabled: false },
    plugins: [
      ["expo-font", fontsIn(projectRoot)],
      // The splash screen on the canvas of the theme the system is in, with
      // the icon's mark in that theme's colors. It stays until the first screen
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
      // Dictation in the composer with the phone's own recognizer, on the
      // phone only; its microphone permission also serves dictation through
      // the server (modules/voice-capture).
      [
        "expo-speech-recognition",
        {
          microphonePermission: MICROPHONE_USE,
          speechRecognitionPermission:
            "J3 Bots turns what you dictate into text in your message, which you send yourself.",
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
          // What Android tints the icon with in the notification itself: the
          // color of the icon's light, which reads on a light shade and a
          // dark one, where the chrome's near-black accent would not.
          color: iconLight,
        },
      ],
      "./plugins/accentColor.js",
      "./plugins/cleartextToPrivateHosts.js",
      "./plugins/foldInPlace.js",
      // Other apps' share sheets list J3 Bots on Android through the share
      // sheet's own activity (modules/share-sheet), with the bots as Direct
      // Share targets. iOS would need a share extension, which reaches the
      // app through an App Group, and signing one takes a paid Apple
      // developer account.
      "./plugins/shareTargets.js",
      "./plugins/unsignedRelease.js",
    ],
  };
};
