// SPDX-License-Identifier: AGPL-3.0-or-later
import { requireOptionalNativeModule } from "expo";
import * as Schema from "effect/Schema";

// The app's own module (modules/app-update), on Android only. What it answers
// crosses from Kotlin, so each answer is decoded before the app trusts it.

const InstalledApp = Schema.Struct({
  packageName: Schema.String,
  versionName: Schema.NullOr(Schema.String),
  versionCode: Schema.Int,
  /** The package that installed the app, null when the system does not say. */
  installer: Schema.NullOr(Schema.String),
});
export type InstalledApp = typeof InstalledApp.Type;

const ApkInfo = Schema.NullOr(
  Schema.Struct({
    packageName: Schema.String,
    versionName: Schema.NullOr(Schema.String),
    versionCode: Schema.Int,
  }),
);
export type ApkInfo = typeof ApkInfo.Type;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/**
 * How handing an APK to Android ended. Updating the running app ends its
 * process, so `installed` is seldom heard: the app learns it at its next
 * start, from its own version.
 *
 * - `digest-mismatch`: the bytes written into the install were not the ones
 *   the release signed, and nothing was installed;
 * - `cancelled`: the operator said no to Android's confirmation;
 * - `conflict`: Android refused an APK signed with another key, or whose
 *   version code is not above the installed one's;
 * - `incompatible`: it does not run on this phone;
 * - `storage`: there was no room for it;
 * - `blocked`: something on the phone, such as a work profile's policy,
 *   does not let apps install;
 * - `failed`: any other failure, with Android's own code and message.
 */
const InstallOutcome = Schema.Union([
  Schema.TaggedStruct("installed", {}),
  Schema.TaggedStruct("digest-mismatch", {}),
  Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("conflict", {}),
  Schema.TaggedStruct("incompatible", {}),
  Schema.TaggedStruct("storage", {}),
  Schema.TaggedStruct("blocked", {}),
  Schema.TaggedStruct("failed", {
    code: Schema.String,
    message: Schema.NullOr(Schema.String),
  }),
]);
export type InstallOutcome = typeof InstallOutcome.Type;

interface AppUpdateModule {
  folder(): string;
  installedApp(): unknown;
  canRequestInstalls(): boolean;
  openInstallSettings(): void;
  sha256(uri: string): Promise<unknown>;
  inspectApk(uri: string): Promise<unknown>;
  install(uri: string, sha256: string, unattended: boolean): Promise<unknown>;
}

const module = requireOptionalNativeModule<AppUpdateModule>("AppUpdate");

/** What the app needs from Android to update itself; null where the module is absent (iOS). */
export interface AppInstaller {
  /** The folder updates are downloaded into: a `file:` URI ending in `/`. */
  readonly folder: () => string;
  readonly installedApp: () => InstalledApp;
  /** Whether the operator lets J3 Bots install apps ("Install unknown apps"). */
  readonly canRequestInstalls: () => boolean;
  /** Opens the system's page where the operator allows it. */
  readonly openInstallSettings: () => void;
  /** The SHA-256 of a file in the update folder, in lowercase hex. */
  readonly sha256: (uri: string) => Promise<string>;
  /** What an APK in the update folder says it is, or null when it is not one. */
  readonly inspectApk: (uri: string) => Promise<ApkInfo>;
  /**
   * Installs an APK from the update folder when its bytes have this SHA-256.
   * `unattended` asks Android to install it without asking the operator,
   * which Android grants only on its own conditions (Android 12 and later).
   */
  readonly install: (uri: string, sha256: string, unattended: boolean) => Promise<InstallOutcome>;
}

const decode = Schema.decodeUnknownSync;

export const appInstaller: AppInstaller | null =
  module === null
    ? null
    : {
        folder: () => module.folder(),
        installedApp: () => decode(InstalledApp)(module.installedApp()),
        canRequestInstalls: () => module.canRequestInstalls(),
        openInstallSettings: () => module.openInstallSettings(),
        sha256: async (uri) => decode(Sha256)(await module.sha256(uri)),
        inspectApk: async (uri) => decode(ApkInfo)(await module.inspectApk(uri)),
        install: async (uri, sha256, unattended) =>
          decode(InstallOutcome)(await module.install(uri, sha256, unattended)),
      };
