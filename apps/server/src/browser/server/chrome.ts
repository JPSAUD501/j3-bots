// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { sha256 } from "../../hash.ts";
import { writeInPlace } from "../../home/inPlace.ts";
import type { Layout } from "../../Layout.ts";
import { unzip } from "./unzip.ts";

// The server's own browser (decision 0110): full Chrome for Testing, run in
// its new headless mode. Not `chrome-headless-shell`, which sites can tell
// from Chrome. One version, pinned per platform by size and SHA-256, is
// downloaded on first use into `<home>/browser/chrome/<version>-<platform>/`,
// checked whole before anything in it is unpacked, and kept there. The
// engine's own copy is never read.

/** The pinned release, per platform as Chrome for Testing names it. */
export const CHROME_VERSION = "158.0.8127.88";

/**
 * Each platform's download, **Verified** 2026-11-27: every archive was
 * streamed from Google's bucket and measured.
 */
const RELEASES = {
  linux64: {
    size: 208_082_347,
    sha256: "59e3b43f8b3aaa292238fbdcfb36a93127debd53e212510dcdc2cc8812b4b57e",
    executable: ["chrome-linux64", "chrome"],
  },
  "linux-arm64": {
    size: 205_794_810,
    sha256: "91669b5de79af808d498037dd974e4b09461776a1b5240b3bb656abd17e5d3ab",
    executable: ["chrome-linux-arm64", "chrome"],
  },
  "mac-arm64": {
    size: 200_337_306,
    sha256: "6caf16b007aafaf6d4a4db252262be8ebbf0d91a2af005257e388996dbe463d6",
    executable: [
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ],
  },
  "mac-x64": {
    size: 213_548_436,
    sha256: "4529a2bdbea10cf69f79b8b0ff43a5a23e8dc8b033da85cbe873afb81855579a",
    executable: [
      "chrome-mac-x64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ],
  },
  win64: {
    size: 214_931_627,
    sha256: "fda73ca9ffc7f02c5c85165cb472152540a76a7cecd8ec11314ea781e4454109",
    executable: ["chrome-win64", "chrome.exe"],
  },
} as const;

export type ChromePlatform = keyof typeof RELEASES;

/** Chrome for Testing's name for the platform the server runs on, if it ships one. */
export const chromePlatformOf = (
  platform: NodeJS.Platform,
  arch: string,
): Option.Option<ChromePlatform> => {
  if (platform === "linux" && arch === "x64") return Option.some("linux64");
  if (platform === "linux" && arch === "arm64") return Option.some("linux-arm64");
  if (platform === "darwin" && arch === "arm64") return Option.some("mac-arm64");
  if (platform === "darwin" && arch === "x64") return Option.some("mac-x64");
  if (platform === "win32" && arch === "x64") return Option.some("win64");
  return Option.none();
};

const downloadUrl = (platform: ChromePlatform) =>
  `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/chrome-${platform}.zip`;

/**
 * Why the server's browser could not be installed: Google could not be
 * reached, the download was not the pinned one, it could not be written or
 * unpacked, or there is no build for this platform.
 */
export class ChromeInstallFailed extends Schema.TaggedError<ChromeInstallFailed>()(
  "ChromeInstallFailed",
  {
    reason: Schema.Literals(["unreachable", "checksum", "files", "platform"]),
  },
) {
  override get message(): string {
    return `The server's browser could not be installed: ${this.reason}.`;
  }
}

const fail = (reason: ChromeInstallFailed["reason"]) => new ChromeInstallFailed({ reason });

/** Where the browser lives under the home. */
export const chromeFolders = (path: Path.Path, home: string, platform: ChromePlatform) => {
  const root = path.join(home, "browser", "chrome");
  const name = `${CHROME_VERSION}-${platform}`;
  return {
    root,
    partial: path.join(root, `${name}.zip.partial`),
    staging: path.join(root, `${name}.staging`),
    target: path.join(root, name),
    executable: path.join(root, name, ...RELEASES[platform].executable),
  };
};

/**
 * The installed browser's executable, downloading and unpacking it first
 * when it is not there yet. A download cut off resumes from its `.partial`.
 */
export const ensureChrome = Effect.fn("browser.ensureChrome")(function* (input: {
  readonly home: string;
  readonly platform: ChromePlatform;
  readonly files: Layout["Service"];
  readonly client: HttpClient.HttpClient;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = RELEASES[input.platform];
  const folders = chromeFolders(path, input.home, input.platform);
  const filesFailed = () => fail("files");
  const checked = (location: string) =>
    input.files.writable(location).pipe(Effect.mapError(filesFailed));
  const remove = (location: string) =>
    fs.remove(location, { recursive: true, force: true }).pipe(Effect.mapError(filesFailed));

  const installed = yield* fs.stat(folders.executable).pipe(Effect.option);
  if (Option.isSome(installed) && installed.value.type === "File") return folders.executable;

  yield* fs
    .makeDirectory(yield* checked(folders.root), { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(filesFailed));
  yield* checked(folders.partial);
  const existing = yield* fs.stat(folders.partial).pipe(Effect.option);
  const kept =
    Option.isSome(existing) && existing.value.type === "File" ? Number(existing.value.size) : 0;
  const have = kept > release.size ? 0 : kept;
  if (have === 0 && kept > 0) yield* remove(folders.partial);

  if (have < release.size) {
    yield* Effect.gen(function* () {
      const response = yield* HttpClient.withScope(input.client)
        .execute(
          HttpClientRequest.get(downloadUrl(input.platform)).pipe(
            have > 0
              ? HttpClientRequest.setHeader("range", `bytes=${have}-`)
              : (request) => request,
          ),
        )
        .pipe(Effect.mapError(() => fail("unreachable")));
      const appending = have > 0 && response.status === 206;
      if (!appending && response.status !== 200) return yield* fail("unreachable");
      let received = appending ? have : 0;
      const arriving = response.stream.pipe(
        Stream.mapError(() => fail("unreachable")),
        Stream.mapEffect((chunk) => {
          received += chunk.byteLength;
          return received > release.size ? Effect.fail(fail("checksum")) : Effect.succeed(chunk);
        }),
      );
      yield* writeInPlace(folders.partial, appending, arriving).pipe(
        Effect.catchTag("InPlaceFailure", () => Effect.fail(fail("files"))),
      );
    }).pipe(Effect.scoped);
  }

  yield* checked(folders.partial);
  const hash = sha256();
  let size = 0;
  yield* fs.stream(folders.partial).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        hash.update(chunk);
      }),
    ),
    Effect.mapError(filesFailed),
  );
  if (size !== release.size || hash.hex() !== release.sha256) {
    // A wrong download fails the same way forever: the next attempt starts over.
    yield* remove(folders.partial);
    return yield* fail("checksum");
  }

  yield* checked(folders.staging);
  yield* remove(folders.staging);
  yield* fs.makeDirectory(folders.staging, { mode: 0o700 }).pipe(Effect.mapError(filesFailed));
  yield* unzip(folders.partial, folders.staging).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("The server's browser could not be unpacked", cause),
    ),
    Effect.mapError(filesFailed),
    Effect.tapError(() => remove(folders.staging).pipe(Effect.ignore)),
  );
  yield* checked(folders.target);
  yield* remove(folders.target);
  yield* fs.rename(folders.staging, folders.target).pipe(Effect.mapError(filesFailed));
  yield* remove(folders.partial);
  return folders.executable;
});
