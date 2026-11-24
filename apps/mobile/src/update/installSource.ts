// SPDX-License-Identifier: AGPL-3.0-or-later

/** Google Play's package: the installer Android records for an app from Play. */
const PLAY_STORE = "com.android.vending";

/**
 * Where the app takes its own update, from the package Android says
 * installed it. An app from Google Play is updated by Play: Android lets only
 * the store update an app it installed without asking, and Play signs with
 * its own key, which no APK on the release carries. Every other install (an
 * APK opened from a browser or a file manager, an update this app installed,
 * `adb install`) takes the release's APK in the app.
 *
 * J3 Bots is not on Play yet (decision 0017); this is the one place that
 * changes when it is.
 */
export const updateRoute = (installer: string | null): "play" | "in-app" =>
  installer === PLAY_STORE ? "play" : "in-app";

/** The app's page on Google Play, which Play's app opens. */
export const playPage = (packageName: string): string =>
  `market://details?id=${encodeURIComponent(packageName)}`;
