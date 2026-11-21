// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigContext, ExpoConfig } from "expo/config";

// Expo installs TypeScript on start otherwise; the workspace typechecks with tsrs.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

/**
 * Each variant installs beside the others, with its own name, link scheme and
 * identifiers. The identifiers are development placeholders, pending the
 * owner's choice of names and ids (open question 6).
 */
const VARIANTS = {
  development: { name: "J3 Bots Dev", scheme: "j3bots-dev", id: "dev.j3bots.mobile.dev" },
  preview: { name: "J3 Bots Preview", scheme: "j3bots-preview", id: "dev.j3bots.mobile.preview" },
  production: { name: "J3 Bots", scheme: "j3bots", id: "dev.j3bots.mobile" },
} as const;

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
    android: { package: variant.id },
    // No over-the-air updates: a build runs the JavaScript it was built with.
    updates: { enabled: false },
    plugins: [
      // Its defaults keep the credential out of Android's backups: a restored
      // backup could not decrypt it.
      "expo-secure-store",
      "./plugins/cleartextToPrivateHosts.js",
    ],
  };
};
