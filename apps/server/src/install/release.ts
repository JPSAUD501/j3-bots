// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  checkDigest,
  expectedDigest,
  releaseTag,
  SIGNATURE_FILE,
  type SignatureCheck,
  SUMS_FILE,
  verifySums,
} from "@j3-bots/release";
import { sha256 } from "@j3-bots/release/node";
import { VerificationFailure } from "@j3-bots/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { RELEASE_MANIFEST, ReleaseManifest } from "../installation.ts";
import { checkOwnFolder, VERSIONS } from "./layout.ts";
import { onlyToReleaseHosts } from "../releases/hosts.ts";

// A release of J3 Bots from its releases page, found, downloaded and checked
// as `scripts/install.sh` does (docs/decisions/0015-a-release-is-a-self-contained-archive.md),
// into `<install>/versions/<version>/`: the latest stable release, or the one
// named; its archive for this platform, checked against the release's
// SHA256SUMS once the release key's signature over that file verified
// (`@j3-bots/release`); unpacked into a staging folder beside the versions,
// and renamed into place only once it runs. A release with no signature, or
// one that does not verify, is refused before its archive is downloaded.

const RELEASES = "https://github.com/JPSAUD501/j3-bots/releases";

/**
 * The releases page, or a mirror of it that serves `<base>/latest` and
 * `<base>/download/<tag>/<file>`, the tag as `releaseTag` names it:
 * `J3_RELEASE_BASE_URL`, as install.sh reads it. A mirror is trusted for
 * nothing: what it serves must carry the release key's signature, as the
 * releases page's does.
 */
export const releaseBase = Config.String("J3_RELEASE_BASE_URL").pipe(
  Config.withDefault(RELEASES),
  Config.map((base) => base.replace(/\/+$/, "")),
);

/** A version as install.sh takes one: a digit first, then digits, letters, `.` and `-`. */
const VERSION = /^[0-9][0-9A-Za-z.-]*$/;

/** The tag of a stable release, the only kind `latest` may name. */
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** What GitHub's page of the latest release answers when asked for JSON. */
const LatestRelease = Schema.Struct({ tag_name: Schema.String });

/** Why a release could not be found, downloaded or checked. Nothing was installed. */
export class ReleaseNotFetched extends Schema.TaggedError<ReleaseNotFetched>()(
  "ReleaseNotFetched",
  {
    reason: Schema.Literals([
      "invalid-version",
      "latest-unreadable",
      "latest-not-stable",
      "checksums-unreadable",
      "unsigned",
      "no-archive",
      "download",
      "checksum",
      "unpack",
      "not-a-release",
      "does-not-run",
      "occupied",
    ]),
    /** The version, or for `latest-*` the releases page. */
    subject: Schema.String,
    /** With `unsigned`, why its SHA256SUMS did not verify. */
    failure: Schema.optionalKey(VerificationFailure),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-version":
        return `${this.subject} is not a version, such as 0.1.0 or 0.1.0-rc.1.`;
      case "latest-unreadable":
        return `Could not read the latest release from ${this.subject}/latest. Check the network, or name the release with --version.`;
      case "latest-not-stable":
        return `The latest release at ${this.subject}/latest is not a stable version. Name the one to install with --version.`;
      case "checksums-unreadable":
        return `Could not download the SHA256SUMS of J3 Bots ${this.subject}. Check the version (a pre-release by its full name, such as 0.1.0-rc.1) and the network.`;
      case "unsigned":
        return `The SHA256SUMS of J3 Bots ${this.subject} does not carry the release key's signature (${this.failure ?? "unverified"}), so nothing of it was installed. If you got it from a mirror, the mirror changed it or did not copy SHA256SUMS.sig; the releases page has both.`;
      case "no-archive":
        return `J3 Bots ${this.subject} has no archive for this machine.`;
      case "download":
        return `Could not download J3 Bots ${this.subject}. Check the network, then run this again.`;
      case "checksum":
        return `The archive of J3 Bots ${this.subject} does not match its checksum in SHA256SUMS, so it was not installed. Run this again; if it happens again, the download is being changed on the way.`;
      case "unpack":
        return `Could not unpack J3 Bots ${this.subject}.`;
      case "not-a-release":
        return `The archive of J3 Bots ${this.subject} is not a J3 Bots release of that version.`;
      case "does-not-run":
        return `J3 Bots ${this.subject} does not run on this machine, so it was not installed.`;
      case "occupied":
        return `${this.subject} is there, but it is not a J3 Bots release. If it is yours, move it away; if it is a damaged J3 Bots release, delete it. Then run this again.`;
    }
  }
}

/** The latest stable release on the releases page at `base`. */
const latestVersion = Effect.fn("release.latestVersion")(function* (base: string) {
  const client = (yield* HttpClient.HttpClient).pipe(onlyToReleaseHosts([base]));
  const latest = yield* client
    .execute(
      HttpClientRequest.get(`${base}/latest`).pipe(
        HttpClientRequest.setHeader("Accept", "application/json"),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(LatestRelease)),
      Effect.mapError(() => new ReleaseNotFetched({ reason: "latest-unreadable", subject: base })),
    );
  const stable = STABLE_TAG.exec(latest.tag_name)?.[1];
  if (stable === undefined) {
    return yield* new ReleaseNotFetched({ reason: "latest-not-stable", subject: base });
  }
  return stable;
});

/** The version to install: `wanted`, without a leading `v`, or the latest stable release. */
export const targetVersion = Effect.fn("release.targetVersion")(function* (
  wanted: Option.Option<string>,
) {
  if (Option.isNone(wanted)) return yield* latestVersion(yield* releaseBase);
  const version = wanted.value.replace(/^v/, "");
  if (!VERSION.test(version)) {
    return yield* new ReleaseNotFetched({ reason: "invalid-version", subject: wanted.value });
  }
  return version;
});

/** Whether `folder` holds a release, as install.sh tells: a `release.json` and a `bin/j3-bots`. */
export const isRelease = Effect.fn("release.isRelease")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs.lstat(path.join(folder, RELEASE_MANIFEST)).pipe(Effect.option);
  const launcher = yield* fs.stat(path.join(folder, "bin", "j3-bots")).pipe(Effect.option);
  return (
    Option.isSome(manifest) &&
    manifest.value.type === "File" &&
    Option.isSome(launcher) &&
    launcher.value.type === "File"
  );
});

/** Where fetching a release is, for whoever follows it. */
export type FetchStage =
  | {
      readonly _tag: "downloading";
      readonly receivedBytes: number;
      /** The archive's size, once the download says it. */
      readonly totalBytes: number | null;
    }
  | { readonly _tag: "verifying" }
  | { readonly _tag: "installing" };

/**
 * J3 Bots `version` for `platform` (such as `linux-x64`) in
 * `<install>/versions/<version>/`: used as it is when a release is there
 * already, otherwise downloaded with its SHA256SUMS and their signature,
 * which `check` must accept, checked, unpacked into a staging folder in
 * `versions/`, run once, and renamed into place. A folder there that is not a
 * release is refused and kept. The install folder, its `versions/` and a
 * release already there must be this user's alone to change. `progress` is
 * told each stage, and the bytes as they come. Answers the release's folder,
 * and whether it was there already.
 */
/**
 * In a release unpacked here, the SHA-256 of the archive it was unpacked
 * from, once that archive matched the verified `SHA256SUMS`.
 */
const ARCHIVE_PROOF = ".archive-sha256";

export const fetchRelease = Effect.fn("release.fetchRelease")(function* <R>(options: {
  readonly install: string;
  readonly version: string;
  readonly platform: string;
  readonly check: SignatureCheck;
  readonly progress: (stage: FetchStage) => Effect.Effect<void, never, R>;
  /**
   * Whether a release already in `versions/` is taken only once it is proven
   * to be the signed one: unpacked from the archive the verified `SHA256SUMS`
   * names. One that is not is downloaded again and replaces it. A client's
   * update sets it; an operator's own folder is otherwise theirs.
   */
  readonly provenOnly: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { version, platform } = options;
  const failed = (reason: ReleaseNotFetched["reason"], subject = version) =>
    new ReleaseNotFetched({ reason, subject });
  const unsigned = (failure: VerificationFailure) =>
    new ReleaseNotFetched({ reason: "unsigned", subject: version, failure });

  const versions = path.join(options.install, VERSIONS);
  yield* checkOwnFolder(options.install);
  yield* fs.makeDirectory(versions, { recursive: true });
  yield* checkOwnFolder(versions);
  const target = path.join(versions, version);
  const cached = yield* isRelease(target);
  if (cached) {
    yield* checkOwnFolder(target);
    if (!options.provenOnly) {
      yield* options.progress({ _tag: "installing" });
      return { root: target, alreadyThere: true };
    }
  } else if (Option.isSome(yield* fs.lstat(target).pipe(Effect.option))) {
    return yield* failed("occupied", target);
  }

  const base = yield* releaseBase;
  const download = `${base}/download/${releaseTag(version)}`;
  const stem = `j3-bots-${version}-${platform}`;
  const archive = `${stem}.tar.gz`;
  // Only to the releases page and where it sends downloads: a redirect elsewhere is refused.
  const client = (yield* HttpClient.HttpClient).pipe(onlyToReleaseHosts([base]));
  const get = (file: string) =>
    client
      .execute(HttpClientRequest.get(`${download}/${file}`))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));

  const sums = yield* get(SUMS_FILE).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(() => failed("checksums-unreadable")),
  );
  // A release with no signature is answered 404; anything else that fails is not knowing.
  const signature = yield* client
    .execute(HttpClientRequest.get(`${download}/${SIGNATURE_FILE}`))
    .pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(null)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap((ok) => ok.arrayBuffer),
              Effect.map((buffer) => new Uint8Array(buffer)),
            ),
      ),
      Effect.mapError(() => failed("checksums-unreadable")),
    );
  const verified = verifySums({ version, sums, signature, check: options.check });
  if (Result.isFailure(verified)) return yield* unsigned(verified.failure);
  const expected = expectedDigest(verified.success, archive);
  if (Result.isFailure(expected)) return yield* failed("no-archive");
  const proof = path.join(target, ARCHIVE_PROOF);
  if (cached) {
    const unpackedFrom = yield* fs.readFileString(proof).pipe(Effect.option);
    if (
      Option.contains(
        Option.map(unpackedFrom, (text) => text.trim()),
        expected.success,
      )
    ) {
      yield* options.progress({ _tag: "installing" });
      return { root: target, alreadyThere: true };
    }
  }

  // Unpacked beside the versions, so the move into place is a rename; gone
  // afterwards whatever happened, unless it was moved.
  const staging = yield* fs.makeTempDirectory({ directory: versions, prefix: ".staging-" });
  return yield* Effect.gen(function* () {
    const downloaded = path.join(staging, archive);
    const hash = sha256();
    yield* options.progress({ _tag: "downloading", receivedBytes: 0, totalBytes: null });
    yield* get(archive).pipe(
      Effect.flatMap((response) => {
        const length = Number(response.headers["content-length"]);
        const totalBytes = Number.isSafeInteger(length) && length >= 0 ? length : null;
        let receivedBytes = 0;
        return response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.suspend(() => {
              hash.update(chunk);
              receivedBytes += chunk.byteLength;
              return options.progress({ _tag: "downloading", receivedBytes, totalBytes });
            }),
          ),
          Stream.run(fs.sink(downloaded, { flag: "wx", mode: 0o600 })),
        );
      }),
      Effect.mapError(() => failed("download")),
    );
    yield* options.progress({ _tag: "verifying" });
    if (Result.isFailure(checkDigest(verified.success, archive, hash.hex()))) {
      return yield* failed("checksum");
    }
    yield* options.progress({ _tag: "installing" });

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const untar = yield* spawner
      .exitCode(
        ChildProcess.make("tar", ["-xzf", downloaded, "-C", staging], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
        }),
      )
      .pipe(Effect.orElseSucceed(() => -1));
    if (untar !== 0) return yield* failed("unpack");
    const unpacked = path.join(staging, stem);
    const manifest = yield* fs
      .readFileString(path.join(unpacked, RELEASE_MANIFEST))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseManifest))),
        Effect.option,
      );
    if (
      Option.isNone(manifest) ||
      manifest.value.version !== version ||
      manifest.value.platform !== platform
    ) {
      return yield* failed("not-a-release");
    }
    const runs = yield* spawner
      .exitCode(
        ChildProcess.make(path.join(unpacked, "bin", "j3-bots"), ["--version"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
        }),
      )
      .pipe(Effect.orElseSucceed(() => -1));
    if (runs !== 0) return yield* failed("does-not-run");
    yield* fs.writeFileString(path.join(unpacked, ARCHIVE_PROOF), `${expected.success}\n`, {
      mode: 0o600,
    });
    // A release there that nothing proved signed goes with the staging folder.
    if (cached) yield* fs.rename(target, path.join(staging, "replaced"));
    yield* fs.rename(unpacked, target);
    return { root: target, alreadyThere: false };
  }).pipe(
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});
