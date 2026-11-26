// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import { type Candidate, type GitHubRelease, isNewer, newestOn, offer } from "@j3-bots/release";
import * as Option from "effect/Option";
import type { ApkInfo, InstalledApp } from "./native.ts";

// Which release is an update to this app, and whether a downloaded APK is it.
// The phone follows its own channel, chosen on the phone: stable by default,
// or nightly. Like the server, it is never offered an older release, so a
// move from nightly to stable waits for a stable release newer than the
// nightly it runs.

/** The APK a release publishes for phones (decision 0017). */
export const apkName = (version: string): string => `j3-bots-${version}-android-arm64.apk`;

/** What the feed offers this app on `channel`, from the releases it lists. */
export const appOffer = (input: {
  readonly releases: ReadonlyArray<GitHubRelease>;
  readonly channel: UpdateChannel;
  readonly running: string;
}): { readonly available: Candidate | null; readonly waitingForStable: boolean } => {
  const { available, waitingForStable } = offer({
    newest: newestOn(input.releases, input.channel),
    running: input.running,
    channel: input.channel,
  });
  return { available: Option.getOrNull(available), waitingForStable };
};

/**
 * Why a downloaded APK, whose bytes the release signed, is still not one to
 * install: it is another app's (`not-this-app`), or not the release it was
 * downloaded as, or not newer than the installed app (`not-newer`). The second
 * cannot happen with a release built from its tag; it is checked so that a
 * mistake in a release is refused here, with words, rather than by Android.
 */
export type ApkRefusal = "not-this-app" | "not-newer";

/** Whether `apk`, downloaded as `version`, may replace `installed`. */
export const apkRefusal = (input: {
  readonly apk: ApkInfo;
  readonly installed: InstalledApp;
  readonly version: string;
}): ApkRefusal | null => {
  const { apk, installed, version } = input;
  if (apk === null || apk.packageName !== installed.packageName || apk.versionName !== version) {
    return "not-this-app";
  }
  // A newer version has a higher version code (androidVersionCode), a nightly
  // too, since a day has one nightly at most.
  if (
    apk.versionCode <= installed.versionCode ||
    installed.versionName === null ||
    !isNewer(version, installed.versionName)
  ) {
    return "not-newer";
  }
  return null;
};
