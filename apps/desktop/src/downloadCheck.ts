// SPDX-License-Identifier: AGPL-3.0-or-later
import { VerificationFailure } from "@j3-bots/contracts";
import {
  checkDigest,
  SIGNATURE_FILE,
  type SignatureCheck,
  SUMS_FILE,
  verifySums,
} from "@j3-bots/release";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// Checking what electron-updater downloaded before the app installs it.
// electron-updater checks the download against the SHA-512 in the release's
// own `latest*.yml`, which whoever can change the release's files can change
// with it. So the app also checks it against the release's `SHA256SUMS`,
// whose Ed25519 signature only the release key makes (`@j3-bots/release`):
// the signature first, then that the signed list is this version's, then the
// file's own SHA-256 against the one listed for it. Anything short of that,
// checksums that are missing or cannot be read included, refuses the download.

/** Why a download was refused: a verification failure, or a step around it. */
export const DownloadRefusal = Schema.Union([
  VerificationFailure,
  /**
   * The downloaded file is not one this platform installs: an AppImage on
   * Linux, an installer on Windows. Without this, a feed pointed at another
   * file the release signs, such as `install.sh`, would verify.
   */
  Schema.Literal("not-installable"),
  /** The release's files or the downloaded file could not be read. */
  Schema.Literal("unreadable"),
]);
export type DownloadRefusal = typeof DownloadRefusal.Type;

class DownloadRefused extends Schema.TaggedError<DownloadRefused>()("DownloadRefused", {
  version: Schema.String,
  file: Schema.String,
  reason: DownloadRefusal,
}) {
  override get message(): string {
    return `The download of ${this.version} (${this.file}) was refused: ${this.reason}.`;
  }
}

/**
 * How long the release's checksums and signature may take to arrive. One
 * that does not answer refuses the download, rather than keeping the app
 * checking it with every other update step held.
 */
export const RELEASE_FILES_WITHIN = Duration.seconds(30);

/** The extension of the file electron-updater installs on each platform the app installs itself on. */
const INSTALLABLE: Partial<Record<NodeJS.Platform, string>> = {
  linux: ".AppImage",
  win32: ".exe",
};

/**
 * The release's name for a downloaded file, as electron-updater names it in
 * its cache (the last part of its URL, `AppUpdater.js`, `executeDownload`),
 * when it is a file `platform` installs; none otherwise.
 */
export const installableName = (path: string, platform: NodeJS.Platform): string | null => {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const extension = INSTALLABLE[platform];
  return extension !== undefined && name.endsWith(extension) && name.length > extension.length
    ? name
    : null;
};

/** What checking a download needs from its surroundings: the network, the file, the key. */
export interface DownloadCheckPorts {
  /**
   * A file of release `version` by name: its bytes, or null when the release
   * has none. `signal` aborts the request once it is no longer awaited.
   */
  readonly releaseFile: (
    version: string,
    name: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array | null>;
  /** The SHA-256 of the file at `path`, lowercase hex. */
  readonly sha256File: (path: string) => Promise<string>;
  readonly check: SignatureCheck;
  readonly platform: NodeJS.Platform;
}

/**
 * Checks the file electron-updater downloaded to `file` as release `version`.
 * Succeeds only when the release's `SHA256SUMS` carries the release key's
 * signature and names that version, the file is one this platform installs,
 * and the list gives it the digest it has. The signature comes first: nothing
 * about the file is trusted before the list it is checked against is. The
 * list and its signature must arrive within `RELEASE_FILES_WITHIN`.
 */
export const verifyDownload = Effect.fn("desktop.verifyDownload")(function* (
  { file, version }: { readonly file: string; readonly version: string },
  ports: DownloadCheckPorts,
) {
  const refuse = (reason: DownloadRefusal) => new DownloadRefused({ version, file, reason });
  const [sums, signature] = yield* Effect.tryPromise({
    try: (signal) =>
      Promise.all([
        ports.releaseFile(version, SUMS_FILE, signal),
        ports.releaseFile(version, SIGNATURE_FILE, signal),
      ]),
    catch: () => refuse("unreadable"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: RELEASE_FILES_WITHIN,
      orElse: () => Effect.fail(refuse("unreadable")),
    }),
  );
  if (sums === null) return yield* refuse("checksums-missing");
  const verified = verifySums({ version, sums, signature, check: ports.check });
  if (Result.isFailure(verified)) return yield* refuse(verified.failure);
  const name = installableName(file, ports.platform);
  if (name === null) return yield* refuse("not-installable");
  const actual = yield* Effect.tryPromise({
    try: () => ports.sha256File(file),
    catch: () => refuse("unreadable"),
  });
  const matched = checkDigest(verified.success, name, actual);
  if (Result.isFailure(matched)) return yield* refuse(matched.failure);
});
