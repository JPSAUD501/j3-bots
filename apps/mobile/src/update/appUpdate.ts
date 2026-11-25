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
// signed SHA256SUMS verifies, then downloads the APK into its own cache,
// checks its SHA-256 against that list and what it says it is, and hands it
// to Android's installer. With "Update automatically" on, the default, it
// does so as soon as a check finds the release, and asks Android to install
// it without a confirmation, which Android grants an app updating itself on
// Android 12 and later; with it off, it waits for the operator's tap, and
// Android asks them to confirm. The downloaded file goes once the install is
// over either way, and whatever a closed app left behind goes at the next
// start.

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
  /** `unattended`: the app asked Android to install it without a confirmation. */
  | { readonly _tag: "installing"; readonly release: AppRelease; readonly unattended: boolean }
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

const AUTOMATIC_KEY = "j3:appUpdateAutomatic";

/** Whether the app installs an update as soon as it finds one: on unless the operator turned it off. */
const readAutomatic = (): boolean => {
  try {
    return Storage.getItemSync(AUTOMATIC_KEY) !== "off";
  } catch {
    // Unreadable, the phone updates itself, the default.
    return true;
  }
};

/**
 * At most one check of the feed in this long when the app opens or comes
 * back, besides the operator's own: six hours when the operator installs
 * updates themselves, as before; one hour when the app installs them as it
 * opens, so coming back to it after a while finds a release out since.
 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const AUTOMATIC_CHECK_EVERY_MS = 60 * 60 * 1000;

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

class Unreachable {
  readonly _tag = "Unreachable";
}

/**
 * How long a request may go without its answer, or a download without a
 * byte, before the feed counts as unreachable. React Native's requests have
 * no deadline of their own, and a feed that stalls would hold a check or a
 * download for as long as the app runs.
 */
const STALL_MS = 30_000;

/** A signal that aborts once `STALL_MS` go by without a call to `progressed`. */
const stallGuard = () => {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), STALL_MS);
  return {
    signal: controller.signal,
    progressed: () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), STALL_MS);
    },
    end: () => clearTimeout(timer),
  };
};

/**
 * `url`'s answer, read in full within `STALL_MS`, or null when it is a 404.
 * Any other failure, a stall included, is `Unreachable`.
 */
const fetchBody = async <A>(
  url: string,
  read: (response: Response) => Promise<A>,
  headers?: Record<string, string>,
): Promise<A | null> => {
  const guard = stallGuard();
  try {
    const response = await fetch(url, { headers: headers ?? {}, signal: guard.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Unreachable();
    const body = await read(response);
    // A read the deadline cut may still end, with only the bytes it had.
    if (guard.signal.aborted) throw new Unreachable();
    return body;
  } catch {
    throw new Unreachable();
  } finally {
    guard.end();
  }
};

/** A JSON answer from the releases API. */
const fetchJson = async (url: string): Promise<unknown> => {
  const body = await fetchBody(url, (response) => response.json(), GITHUB_HEADERS);
  if (body === null) throw new Unreachable();
  return body;
};

/** A release file's bytes, or null when the release has no such file. */
const fetchFile = (url: string): Promise<Uint8Array | null> =>
  fetchBody(url, async (response) => new Uint8Array(await response.arrayBuffer()));

const decodeReleases = Schema.decodeUnknownSync(GitHubReleases);
const decodeRelease = Schema.decodeUnknownSync(GitHubRelease);

/** The releases `channel` chooses from: the latest stable one, or the newest of every kind. */
const listReleases = async (
  feed: ReleaseFeed,
  channel: UpdateChannel,
): Promise<ReadonlyArray<GitHubRelease>> => {
  try {
    if (channel === "stable")
      return [decodeRelease(await fetchJson(`${feed.api}/releases/latest`))];
    return decodeReleases(await fetchJson(`${feed.api}/releases?per_page=30`));
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
  /** "Update automatically": whether a release a check finds is installed at once. */
  readonly automatic: Readable<boolean>;
  readonly installed: InstalledApp;
  /**
   * Reads the feed now; `opening`, the app opening or coming back, skips it
   * when it was read within the bound above. Neither replaces an update in
   * hand. With "Update automatically" on, a verified release the check
   * finds is downloaded and installed at once, one try per check: a try
   * that fails says so and waits for the next opening or the operator.
   */
  readonly check: (opening?: boolean) => Promise<void>;
  readonly setChannel: (channel: UpdateChannel) => void;
  readonly setAutomatic: (on: boolean) => void;
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
  const automatic = new Cell<boolean>(readAutomatic());
  let checkedAt = 0;
  let busy = false;

  const fail = (release: AppRelease | null, failure: AppUpdateFailure) =>
    state.set({ _tag: "failed", release, failure });

  const check = async (opening = false) => {
    if (route === "play" || busy || updateInHand(state.get())) return;
    const now = Date.now();
    const every = automatic.get() ? AUTOMATIC_CHECK_EVERY_MS : CHECK_EVERY_MS;
    if (opening && now - checkedAt < every) return;
    const running = installed.versionName;
    if (running === null) return;
    busy = true;
    checkedAt = now;
    // The channel this check reads. Should the operator change it meanwhile,
    // what this check found is dropped and the new channel is read instead,
    // so only the chosen channel ever offers a release.
    const asked = channel.get();
    const found = (next: AppUpdateState) => {
      if (channel.get() === asked) state.set(next);
    };
    // The release this check offered, which "Update automatically" takes.
    let offeredRelease: AppRelease | null = null;
    state.set({ _tag: "checking" });
    try {
      const releases = await listReleases(feed, asked);
      const offered = appOffer({ releases, channel: asked, running });
      const candidate = offered.available;
      if (candidate === null) {
        found({ _tag: "current", waitingForStable: offered.waitingForStable });
        return;
      }
      const verified = await verifiedRelease(feed, candidate);
      if (Result.isFailure(verified)) {
        found({
          _tag: "failed",
          release: null,
          failure: { _tag: "unverified", version: candidate.version, reason: verified.failure },
        });
        return;
      }
      offeredRelease = verified.success;
      found({ _tag: "available", release: verified.success });
    } catch {
      found({ _tag: "failed", release: null, failure: { _tag: "unreachable" } });
    } finally {
      busy = false;
      if (channel.get() !== asked) void check();
      else if (offeredRelease !== null && automatic.get()) void takeOffered(offeredRelease);
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

  /**
   * Hands the verified file to Android, and goes on from what it answers.
   * With "Update automatically" on, it asks Android not to ask the operator;
   * Android still asks where it does not grant that.
   */
  const install = async (release: AppRelease) => {
    if (!installer.canRequestInstalls()) {
      state.set({ _tag: "permission", release });
      return;
    }
    const unattended = automatic.get();
    state.set({ _tag: "installing", release, unattended });
    const outcome = await installer.install(fileOf(release).uri, release.apk.sha256, unattended);
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
    // A download may take long on a slow network, but not stall.
    const guard = stallGuard();
    try {
      await File.downloadFileAsync(release.apk.url, file, {
        idempotent: true,
        signal: guard.signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          guard.progressed();
          state.set({
            _tag: "downloading",
            release,
            received: bytesWritten,
            total: totalBytes > 0 ? totalBytes : null,
          });
        },
      });
      // A download the deadline cut may still end, with only the bytes it had.
      if (guard.signal.aborted) throw new Unreachable();
    } catch {
      remove(file);
      fail(release, { _tag: "unreachable" });
      return;
    } finally {
      guard.end();
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

  /** "Update automatically" takes the release a check offered, unless something else came first. */
  const takeOffered = (release: AppRelease): Promise<void> => {
    const current = state.get();
    if (current._tag !== "available" || current.release !== release) return Promise.resolve();
    return exclusive(release, () => downloadAndInstall(release));
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
    automatic,
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
      // An update waiting for the operator came from the other channel: it
      // goes, with its file, and the chosen channel is read. One under way
      // ends first; the next check reads the chosen channel.
      const current = state.get();
      if (current._tag === "cancelled" || current._tag === "permission") {
        remove(fileOf(current.release));
        state.set({ _tag: "unchecked" });
      }
      void check();
    },
    setAutomatic: (on) => {
      if (on === automatic.get()) return;
      try {
        if (on) Storage.removeItemSync(AUTOMATIC_KEY);
        else Storage.setItemSync(AUTOMATIC_KEY, "off");
      } catch {
        // The choice holds until the app restarts.
      }
      automatic.set(on);
      // Turned on with a release on offer: it is taken now, as an opening would.
      const current = state.get();
      if (on && current._tag === "available") void takeOffered(current.release);
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

/** The release build's application id (app.config.ts, `VARIANTS.production`). */
const RELEASE_PACKAGE = "dev.j3bots.mobile";

/**
 * Whether this build may take its updates from `feed`. The build refuses a
 * test feed for the release variant, but the config is read again when the
 * native project is assembled, so a project prebuilt as the release and
 * assembled with a test feed would carry one. The app that installs as J3
 * Bots trusts only the project's releases, whatever its config says.
 */
const trusted = (installer: AppInstaller, feed: ReleaseFeed): boolean =>
  feed.source === "release" || installer.installedApp().packageName !== RELEASE_PACKAGE;

/** The app's own update, or null in a build that does not update itself. */
export const appUpdate: AppUpdate | null =
  appInstaller === null || releaseFeed === null || !trusted(appInstaller, releaseFeed)
    ? null
    : make(appInstaller, releaseFeed);
