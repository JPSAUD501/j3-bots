// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import type { GitHubRelease } from "@j3-bots/release";
import { apkRefusal, appOffer } from "./appRelease.ts";
import { updateRoute } from "./installSource.ts";
import type { InstalledApp } from "./native.ts";

const installed: InstalledApp = {
  packageName: "dev.j3bots.mobile",
  versionName: "0.3.1",
  versionCode: 3_019_999,
  installer: null,
};

const apk = (versionName: string, versionCode: number, packageName = installed.packageName) => ({
  packageName,
  versionName,
  versionCode,
});

const release = (tag: string, prerelease: boolean): GitHubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease,
  published_at: "2026-11-24T12:00:00Z",
  html_url: `https://github.com/JPSAUD501/j3-bots/releases/tag/${tag}`,
});

/** A stable release and a later nightly, as the releases list has them, newest first. */
const releases = [release("0.3.3-nightly.20261124.1", true), release("v0.3.2", false)];

describe("which release the app is offered", () => {
  it("offers a stable app only a newer stable release, and a nightly app the newest nightly", () => {
    expect(appOffer({ releases, channel: "stable", running: "0.3.1" }).available?.version).toBe(
      "0.3.2",
    );
    expect(appOffer({ releases, channel: "nightly", running: "0.3.1" }).available).toMatchObject({
      version: "0.3.3-nightly.20261124.1",
      tag: "0.3.3-nightly.20261124.1",
    });
  });

  it("keeps a nightly app that moves to stable waiting for a newer stable release", () => {
    expect(appOffer({ releases, channel: "stable", running: "0.3.3-nightly.20261124.1" })).toEqual({
      available: null,
      waitingForStable: true,
    });
  });
});

describe("whether a downloaded APK may replace the app", () => {
  it("takes the release it was downloaded as, when it is newer", () => {
    expect(apkRefusal({ apk: apk("0.3.2", 3_029_999), installed, version: "0.3.2" })).toBeNull();
  });

  it("refuses another app, or another release than the one downloaded", () => {
    for (const other of [
      null,
      apk("0.3.2", 3_029_999, "dev.j3bots.mobile.preview"),
      apk("0.3.3", 3_039_999),
    ]) {
      expect(apkRefusal({ apk: other, installed, version: "0.3.2" })).toBe("not-this-app");
    }
  });

  it("refuses a downgrade, by version or by version code", () => {
    expect(apkRefusal({ apk: apk("0.3.0", 30_099), installed, version: "0.3.0" })).toBe(
      "not-newer",
    );
    expect(apkRefusal({ apk: apk("0.3.1", 3_019_999), installed, version: "0.3.1" })).toBe(
      "not-newer",
    );
    expect(apkRefusal({ apk: apk("0.3.2", 3_000_000), installed, version: "0.3.2" })).toBe(
      "not-newer",
    );
  });

  it("takes a later nightly of the same day, which has the same version code", () => {
    const nightly = {
      ...installed,
      versionName: "0.3.2-nightly.20261124.7",
      versionCode: 3_020_328,
    };
    expect(
      apkRefusal({
        apk: apk("0.3.2-nightly.20261124.8", 3_020_328),
        installed: nightly,
        version: "0.3.2-nightly.20261124.8",
      }),
    ).toBeNull();
  });
});

describe("where the app takes its own update", () => {
  it("leaves an app Google Play installed to Play, and installs every other one itself", () => {
    expect(updateRoute("com.android.vending")).toBe("play");
    for (const installer of [
      null,
      "com.android.chrome",
      "com.google.android.packageinstaller",
      "dev.j3bots.mobile",
    ]) {
      expect(updateRoute(installer)).toBe("in-app");
    }
  });
});
