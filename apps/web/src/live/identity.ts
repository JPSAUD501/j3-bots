// SPDX-License-Identifier: AGPL-3.0-or-later
import { ClientIdentity } from "@j3-bots/client-runtime";
import type { TelemetryOs, TelemetrySurface } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Desktop, systemOf } from "./desktop";

// What this window tells its server it is, for usage data (decision 0099).

/** Where this browser's random id for usage data is kept: not a secret, and only ever sent hashed. */
const ID_KEY = "j3-bots.usage-data-id";

/** 32 random bytes as hex, from the generator every page has, plain HTTP included. */
const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * The id kept for this origin, made the first time. Storage the browser
 * refuses, as in a private window, gives one for this page alone.
 */
const randomId = Effect.sync(() => {
  try {
    const kept = localStorage.getItem(ID_KEY);
    if (kept !== null && kept !== "") return kept;
    const made = randomHex();
    localStorage.setItem(ID_KEY, made);
    return made;
  } catch {
    return randomHex();
  }
});

const osOf = (userAgent: string): TelemetryOs => {
  if (/Android/.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  switch (systemOf(userAgent)) {
    case "windows":
      return "windows";
    case "mac":
      return "macos";
    case "linux":
      return /Linux|X11|CrOS/.test(userAgent) ? "linux" : "other";
  }
};

/**
 * A browser tab is the web client, which is the server's own release. In
 * the desktop app, its main window or quick access, with the app's release.
 */
export const identityLayer = (desktop: Desktop | null) => {
  const surface: TelemetrySurface =
    desktop === null
      ? "web"
      : window.location.pathname.startsWith("/quick")
        ? "quick-access"
        : "desktop";
  return Layer.succeed(ClientIdentity, {
    surface,
    os: osOf(navigator.userAgent),
    version:
      desktop === null
        ? Effect.succeed(null)
        : Effect.promise(() =>
            // An app that cannot say leaves the version out; the rest is still told.
            desktop.updateStatus().then(
              (status) => status?.current ?? null,
              () => null,
            ),
          ),
    randomId,
  });
};
