// SPDX-License-Identifier: AGPL-3.0-or-later
import { Cell, type Readable } from "@j3-bots/client-runtime";
import {
  type UpdateChannel,
  UpdateChannel as UpdateChannelSchema,
  type VerificationFailure,
} from "@j3-bots/contracts";
import {
  type Candidate,
  checkDigest,
  expectedDigest,
  GitHubRelease,
  GitHubReleases,
  SIGNATURE_FILE,
  SUMS_FILE,
  type VerifiedSums,
  verifySums,
} from "@j3-bots/release";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Directory, File } from "expo-file-system";
import { Storage } from "expo-sqlite/kv-store";
import { Linking } from "react-native";
import { apkName, apkRefusal, appOffer } from "./appRelease.ts";
import { type ReleaseFeed, releaseFeed } from "./feed.ts";
import { playPage, updateRoute } from "./installSource.ts";
import {
  type AppInstaller,
  appInstaller,
  type InstalledApp,
  type InstallOutcome,
} from "./native.ts";

// The app's own update, on Android. The app reads the releases of its
// channel, offers the newest one only when it is newer than itself and its
// signed SHA256SUMS verifies, then on the operator's tap downloads the APK
// into its own cache, checks its SHA-256 against that list and what it says
// it is, and hands it to Android's installer, which asks the operator to
// confirm. The downloaded file goes once the install is over either way, and
// whatever a closed app left behind goes at the next start.

/** A release this app may update to, its APK's digest taken from the signed list. */
interface AppRelease {
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly notesUrl: string;
  readonly apk: { readonly url: string; readonly sha256: string };
  /** The release's signed list, which the downloaded APK is checked against. */
  readonly sums: VerifiedSums;
}

/**
 * Why the update did not go through, for the operator:
 *
 * - `unreachable`: the releases or the download could not be reached;
 * - `unverified`: the release's signed list did not verify, or does not
 *   list the APK; nothing of it was installed;
 * - `digest-mismatch`: the downloaded APK is not the one the release signed;
 * - `not-this-app`, `not-newer`: see `ApkRefusal`;
 * - the rest are Android's refusals of the install (`InstallOutcome`).
 */
export type AppUpdateFailure =
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "unverified"; readonly version: string; readonly reason: VerificationFailure }
  | { readonly _tag: "digest-mismatch" }
  | { readonly _tag: "not-this-app" }
  | { readonly _tag: "not-newer" }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "incompatible" }
  | { readonly _tag: "storage" }
  | { readonly _tag: "blocked" }
  | { readonly _tag: "install-failed"; readonly detail: string };

export type AppUpdateState =
  /** Google Play installed the app, and updates it. */
  | { readonly _tag: "play" }
  | { readonly _tag: "unchecked" }
  | { readonly _tag: "checking" }
  /** Nothing newer on the channel. `waitingForStable`: on stable while a nightly runs. */
  | { readonly _tag: "current"; readonly waitingForStable: boolean }
  | { readonly _tag: "available"; readonly release: AppRelease }
  | {
      readonly _tag: "downloading";
      readonly release: AppRelease;
      readonly received: number;
      readonly total: number | null;
    }
  | { readonly _tag: "verifying"; readonly release: AppRelease }
  /** Verified and waiting for the operator to allow installs from J3 Bots. */
  | { readonly _tag: "permission"; readonly release: AppRelease }
  | { readonly _tag: "installing"; readonly release: AppRelease }
  /** The operator said no to Android's confirmation; the verified file is kept to try again. */
  | { readonly _tag: "cancelled"; readonly release: AppRelease }
  | {
      readonly _tag: "failed";
      readonly release: AppRelease | null;
      readonly failure: AppUpdateFailure;
    };

const CHANNEL_KEY = "j3:appUpdateChannel";

const readChannel = (): UpdateChannel => {
  try {
    return Option.getOrElse(
      Schema.decodeUnknownOption(UpdateChannelSchema)(Storage.getItemSync(CHANNEL_KEY)),
      () => "stable",
    );
  } catch {
    // Unreadable, the phone follows stable, the default.
    return "stable";
  }
};

/** At most one check of the feed in this long, besides the operator's own. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

class Unreachable {
  readonly _tag = "Unreachable";
}

const fetchOk = async (url: string, headers?: Record<string, string>): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(url, headers === undefined ? {} : { headers });
  } catch {
    throw new Unreachable();
  }
  if (!response.ok) throw new Unreachable();
  return response;
};

/** A release file's bytes, or null when the release has no such file. */
const fetchFile = async (url: string): Promise<Uint8Array | null> => {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Unreachable();
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Unreachable();
  return new Uint8Array(await response.arrayBuffer());
};

const decodeReleases = Schema.decodeUnknownSync(GitHubReleases);
const decodeRelease = Schema.decodeUnknownSync(GitHubRelease);

/** The releases `channel` chooses from: the latest stable one, or the newest of every kind. */
const listReleases = async (
  feed: ReleaseFeed,
  channel: UpdateChannel,
): Promise<ReadonlyArray<GitHubRelease>> => {
  try {
    if (channel === "stable") {
      const response = await fetchOk(`${feed.api}/releases/latest`, GITHUB_HEADERS);
      return [decodeRelease(await response.json())];
    }
    const response = await fetchOk(`${feed.api}/releases?per_page=30`, GITHUB_HEADERS);
    return decodeReleases(await response.json());
  } catch (error) {
    if (error instanceof Unreachable) throw error;
    // An answer that is not a list of releases.
    throw new Unreachable();
  }
};

/** A file of the release tagged `tag`: each release's files sit under its own tag. */
const download = (feed: ReleaseFeed, tag: string, file: string) =>
  `${feed.site}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;

/** `candidate` as an update to this app, once its signed list verifies and lists the APK. */
const verifiedRelease = async (
  feed: ReleaseFeed,
  candidate: Candidate,
): Promise<Result.Result<AppRelease, VerificationFailure>> => {
  const [sums, signature] = await Promise.all([
    fetchFile(download(feed, candidate.tag, SUMS_FILE)),
    fetchFile(download(feed, candidate.tag, SIGNATURE_FILE)),
  ]);
  // Nothing signed: a release from before releases were signed.
  if (sums === null) return Result.fail("checksums-missing");
  const file = apkName(candidate.version);
  return Result.flatMap(
    verifySums({ version: candidate.version, sums, signature, check: feed.check }),
    (verified) =>
      Result.map(expectedDigest(verified, file), (sha256) => ({
        version: candidate.version,
        channel: candidate.channel,
        notesUrl: candidate.notesUrl,
        apk: { url: download(feed, candidate.tag, file), sha256 },
        sums: verified,
      })),
  );
};

const failureOf = (
  outcome: Exclude<InstallOutcome, { _tag: "installed" | "cancelled" }>,
): AppUpdateFailure => {
  switch (outcome._tag) {
    case "digest-mismatch":
    case "conflict":
    case "incompatible":
    case "storage":
    case "blocked":
      return { _tag: outcome._tag };
    case "failed":
      return { _tag: "install-failed", detail: outcome.message ?? outcome.code };
  }
};

/** Deletes `file`, if it is there. A file that stays is deleted at the next start. */
const remove = (file: File) => {
  try {
    if (file.exists) file.delete();
  } catch {
    // Left for the next start, which empties the folder.
  }
};

/**
 * Whether an update the operator started is under way or waits for them, to
 * allow installs or to confirm again. No check replaces it: it ends when it
 * is installed or fails, and the folder is emptied at the next start.
 */
export const updateInHand = (current: AppUpdateState): boolean => {
  switch (current._tag) {
    case "downloading":
    case "verifying":
    case "permission":
    case "installing":
    case "cancelled":
      return true;
    default:
      return false;
  }
};

export interface AppUpdate {
  readonly state: Readable<AppUpdateState>;
  readonly channel: Readable<UpdateChannel>;
  readonly installed: InstalledApp;
  /**
   * Reads the feed now; `auto` skips it when it was read in the last six
   * hours. Neither replaces an update in hand.
   */
  readonly check: (auto?: boolean) => Promise<void>;
  readonly setChannel: (channel: UpdateChannel) => void;
  /** Downloads, verifies and installs the available release, asking for what Android needs. */
  readonly update: () => Promise<void>;
  /** Opens the system's page that lets J3 Bots install apps. */
  readonly allowInstalls: () => void;
  /** The app came back to the foreground: an install waiting for the permission goes on. */
  readonly resume: () => void;
  /** Opens Google Play's page of the app. */
  readonly openPlay: () => void;
}

const make = (installer: AppInstaller, feed: ReleaseFeed): AppUpdate => {
  const installed = installer.installedApp();
  const folder = new Directory(installer.folder());
  // Whatever a closed app left: an update installed or abandoned.
  for (const item of folder.list()) {
    if (item instanceof File) remove(item);
  }
  const route = updateRoute(installed.installer);
  const state = new Cell<AppUpdateState>(
    route === "play" ? { _tag: "play" } : { _tag: "unchecked" },
  );
  const channel = new Cell<UpdateChannel>(readChannel());
  let checkedAt = 0;
  let busy = false;

  const fail = (release: AppRelease | null, failure: AppUpdateFailure) =>
    state.set({ _tag: "failed", release, failure });

  const check = async (auto = false) => {
    if (route === "play" || busy || updateInHand(state.get())) return;
    const now = Date.now();
    if (auto && now - checkedAt < CHECK_EVERY_MS) return;
    const running = installed.versionName;
    if (running === null) return;
    busy = true;
    checkedAt = now;
    state.set({ _tag: "checking" });
    try {
      const releases = await listReleases(feed, channel.get());
      const offered = appOffer({ releases, channel: channel.get(), running });
      const candidate = offered.available;
      if (candidate === null) {
        state.set({ _tag: "current", waitingForStable: offered.waitingForStable });
        return;
      }
      Result.match(await verifiedRelease(feed, candidate), {
        onSuccess: (release) => state.set({ _tag: "available", release }),
        onFailure: (reason) =>
          fail(null, { _tag: "unverified", version: candidate.version, reason }),
      });
    } catch {
      fail(null, { _tag: "unreachable" });
    } finally {
      busy = false;
    }
  };

  const fileOf = (release: AppRelease) => new File(folder, apkName(release.version));

  /**
   * Runs one step of `release`'s update, never two at once. What the module
   * throws, rather than answers, is an install that failed.
   */
  const exclusive = async (release: AppRelease, step: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await step();
    } catch (error) {
      remove(fileOf(release));
      fail(release, {
        _tag: "install-failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busy = false;
    }
  };

  /** Hands the verified file to Android, and goes on from what it answers. */
  const install = async (release: AppRelease) => {
    if (!installer.canRequestInstalls()) {
      state.set({ _tag: "permission", release });
      return;
    }
    state.set({ _tag: "installing", release });
    const outcome = await installer.install(fileOf(release).uri, release.apk.sha256);
    if (outcome._tag === "cancelled") {
      state.set({ _tag: "cancelled", release });
      return;
    }
    remove(fileOf(release));
    if (outcome._tag === "installed") state.set({ _tag: "current", waitingForStable: false });
    else fail(release, failureOf(outcome));
  };

  /** Downloads `release`'s APK, checks it against the signed list and the installed app, then installs it. */
  const downloadAndInstall = async (release: AppRelease) => {
    const file = fileOf(release);
    remove(file);
    state.set({ _tag: "downloading", release, received: 0, total: null });
    try {
      await File.downloadFileAsync(release.apk.url, file, {
        idempotent: true,
        onProgress: ({ bytesWritten, totalBytes }) =>
          state.set({
            _tag: "downloading",
            release,
            received: bytesWritten,
            total: totalBytes > 0 ? totalBytes : null,
          }),
      });
    } catch {
      remove(file);
      fail(release, { _tag: "unreachable" });
      return;
    }
    state.set({ _tag: "verifying", release });
    const digest = await installer.sha256(file.uri);
    if (Result.isFailure(checkDigest(release.sums, apkName(release.version), digest))) {
      remove(file);
      fail(release, { _tag: "digest-mismatch" });
      return;
    }
    const refusal = apkRefusal({
      apk: await installer.inspectApk(file.uri),
      installed,
      version: release.version,
    });
    if (refusal !== null) {
      remove(file);
      fail(release, { _tag: refusal });
      return;
    }
    await install(release);
  };

  const update = async (): Promise<void> => {
    const current = state.get();
    switch (current._tag) {
      case "cancelled":
      case "permission": {
        // Already downloaded and checked; the install checks the bytes again.
        const { release } = current;
        return exclusive(release, () => install(release));
      }
      case "available":
      case "failed": {
        const { release } = current;
        if (release === null) return;
        return exclusive(release, () => downloadAndInstall(release));
      }
      default:
        return;
    }
  };

  return {
    state,
    channel,
    installed,
    check,
    setChannel: (next) => {
      if (next === channel.get()) return;
      try {
        if (next === "stable") Storage.removeItemSync(CHANNEL_KEY);
        else Storage.setItemSync(CHANNEL_KEY, next);
      } catch {
        // The choice holds until the app restarts.
      }
      channel.set(next);
      void check();
    },
    update,
    allowInstalls: () => installer.openInstallSettings(),
    resume: () => {
      const current = state.get();
      if (current._tag !== "permission" || !installer.canRequestInstalls()) return;
      const { release } = current;
      void exclusive(release, () => install(release));
    },
    openPlay: () => void Linking.openURL(playPage(installed.packageName)),
  };
};

/** The app's own update, or null in a build that does not update itself. */
export const appUpdate: AppUpdate | null =
  appInstaller === null || releaseFeed === null ? null : make(appInstaller, releaseFeed);
