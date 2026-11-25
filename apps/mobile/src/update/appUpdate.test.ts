// SPDX-License-Identifier: AGPL-3.0-or-later
import { TEST_FILES, TEST_PUBLIC_KEY, VERIFICATION_CASES } from "@j3-bots/release/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppUpdate } from "./appUpdate.ts";
import type { AppInstaller, InstallOutcome } from "./native.ts";

// The app's update as it runs on the phone, with Android's side faked and
// the release served from the shared test vectors, signed with the test key.

const storage = vi.hoisted(() => new Map<string, string>());
const downloads = vi.hoisted(() => ({ count: 0 }));

vi.mock("expo-sqlite/kv-store", () => ({
  Storage: {
    getItemSync: (key: string) => storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => void storage.set(key, value),
    removeItemSync: (key: string) => void storage.delete(key),
  },
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    list(): ReadonlyArray<File> {
      return [];
    }
  }
  class File {
    readonly uri: string;
    readonly exists = false;
    constructor(folder: Directory, name: string) {
      this.uri = `${folder.uri}${name}`;
    }
    delete() {}
    static downloadFileAsync = () => {
      downloads.count += 1;
      return Promise.resolve();
    };
  }
  return { Directory, File };
});

vi.mock("react-native", () => ({ Linking: { openURL: () => Promise.resolve() } }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: null } }));

const { makeAppUpdate } = await import("./appUpdate.ts");
const { signatureCheck } = await import("./signature.ts");

const VERSION = "0.3.1";
const APK = `j3-bots-${VERSION}-android-arm64.apk`;
const SITE = "https://releases.example.com";
const [signed] = VERIFICATION_CASES;
if (signed?.signature == null) throw new Error("The first case is a signed release.");
const { sums, signature } = { sums: signed.sums, signature: signed.signature };
const APK_DIGEST = /^([0-9a-f]{64}) {2}j3-bots-0\.3\.1-android-arm64\.apk$/m.exec(sums)?.[1];
if (APK_DIGEST === undefined || TEST_FILES[APK] === undefined) {
  throw new Error("The vectors list the APK of 0.3.1.");
}

/** The feed: one stable release, 0.3.1, with its signed list. */
const serve = (url: string): Response => {
  if (url === `${SITE}/releases/latest`) {
    return Response.json({
      tag_name: `v${VERSION}`,
      draft: false,
      prerelease: false,
      published_at: "2026-11-24T12:00:00Z",
      html_url: `${SITE}/releases/tag/v${VERSION}`,
    });
  }
  if (url.endsWith("/SHA256SUMS")) return new Response(sums);
  if (url.endsWith("/SHA256SUMS.sig")) return new Response(signature);
  return new Response(null, { status: 404 });
};

const installs: Array<{ readonly unattended: boolean }> = [];
let outcome: InstallOutcome = { _tag: "conflict" };
let allowed = true;

const installer: AppInstaller = {
  folder: () => "file:///cache/app-updates/",
  installedApp: () => ({
    packageName: "dev.j3bots.mobile.preview",
    versionName: "0.3.0",
    versionCode: 3_009_999,
    installer: null,
  }),
  canRequestInstalls: () => allowed,
  openInstallSettings: () => undefined,
  sha256: () => Promise.resolve(APK_DIGEST),
  inspectApk: () =>
    Promise.resolve({
      packageName: "dev.j3bots.mobile.preview",
      versionName: VERSION,
      versionCode: 3_019_999,
    }),
  install: (_uri, _sha256, unattended) => {
    installs.push({ unattended });
    return Promise.resolve(outcome);
  },
};

const start = (): AppUpdate =>
  makeAppUpdate(installer, {
    source: "test",
    api: SITE,
    site: SITE,
    check: signatureCheck([TEST_PUBLIC_KEY]),
  });

/** Lets what a check started run to where it waits for nothing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  storage.clear();
  installs.length = 0;
  outcome = { _tag: "conflict" };
  allowed = true;
  downloads.count = 0;
  vi.stubGlobal("fetch", (url: string) => Promise.resolve(serve(url)));
});

describe("the app's update with Update automatically on, the default", () => {
  it("installs a verified release the opening's check finds, unattended, with no tap", async () => {
    const update = start();
    expect(update.automatic.get()).toBe(true);
    await update.check(true);
    await settle();
    expect(installs).toEqual([{ unattended: true }]);
  });

  it("says a refused install and tries once per check, not in a loop", async () => {
    const update = start();
    await update.check(true);
    await settle();
    expect(update.state.get()).toMatchObject({ _tag: "failed", failure: { _tag: "conflict" } });
    // Coming back within the hour does not check, so it does not try again.
    await update.check(true);
    await settle();
    expect(installs).toHaveLength(1);
    // A check the operator asks for tries once more.
    await update.check();
    await settle();
    expect(installs).toHaveLength(2);
  });

  it("asks for Install unknown apps before it downloads, and goes on once it is allowed", async () => {
    allowed = false;
    const update = start();
    await update.check(true);
    await settle();
    expect(update.state.get()._tag).toBe("permission");
    expect(downloads.count).toBe(0);
    allowed = true;
    update.resume();
    await settle();
    expect(downloads.count).toBe(1);
    expect(installs).toEqual([{ unattended: true }]);
  });

  it("takes the release on offer when the operator turns it on", async () => {
    const update = start();
    update.setAutomatic(false);
    await update.check(true);
    expect(update.state.get()._tag).toBe("available");
    update.setAutomatic(true);
    await settle();
    expect(installs).toEqual([{ unattended: true }]);
  });
});

describe("the app's update with Update automatically off", () => {
  it("offers the release and installs it, asking Android to confirm, only on the operator's tap", async () => {
    start().setAutomatic(false);
    // The choice is kept: a new start reads it.
    const update = start();
    expect(update.automatic.get()).toBe(false);
    await update.check(true);
    await settle();
    expect(update.state.get()._tag).toBe("available");
    expect(installs).toEqual([]);
    await update.update();
    expect(installs).toEqual([{ unattended: false }]);
  });
});
