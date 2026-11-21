// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 of a 50 MB archive needs an incremental hash; Effect has none.
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { RELEASE_MANIFEST, ReleaseManifest } from "../installation.ts";
import { checkOwnFolder, VERSIONS } from "./layout.ts";

// A release of J3 Bots from its releases page, found, downloaded and checked
// as `scripts/install.sh` does (docs/decisions/0015-a-release-is-a-self-contained-archive.md),
// into `<install>/versions/<version>/`: the latest stable release, or the one
// named; its archive for this platform, checked against the release's
// SHA256SUMS; unpacked into a staging folder beside the versions, and renamed
// into place only once it runs.

const RELEASES = "https://github.com/JPSAUD501/j3-bots/releases";

/**
 * The releases page, or a mirror of it that serves `<base>/latest` and
 * `<base>/download/v<version>/<file>`: `J3_RELEASE_BASE_URL`, as install.sh
 * reads it. The mirror is trusted as the publisher, since it serves the
 * SHA256SUMS an archive is checked against.
 */
const releaseBase = Config.String("J3_RELEASE_BASE_URL").pipe(
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

/** The SHA-256 SUMS line for `archive`: `<digest>  <name>`, or `<digest> *<name>`. */
const digestOf = (sums: string, archive: string) => {
  for (const line of sums.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (digest !== undefined && (name === archive || name === `*${archive}`)) {
      return Option.some(digest.toLowerCase());
    }
  }
  return Option.none<string>();
};

/** The latest stable release on the releases page at `base`. */
const latestVersion = Effect.fn("release.latestVersion")(function* (base: string) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
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

/**
 * J3 Bots `version` for `platform` (such as `linux-x64`) in
 * `<install>/versions/<version>/`: used as it is when a release is there
 * already, otherwise downloaded with its SHA256SUMS, checked, unpacked into a
 * staging folder in `versions/`, run once, and renamed into place. A folder
 * there that is not a release is refused and kept. The install folder, its
 * `versions/` and a release already there must be this user's alone to
 * change. Answers the release's
 * folder, and whether it was there already.
 */
export const fetchRelease = Effect.fn("release.fetchRelease")(function* (options: {
  readonly install: string;
  readonly version: string;
  readonly platform: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { version, platform } = options;
  const failed = (reason: ReleaseNotFetched["reason"], subject = version) =>
    new ReleaseNotFetched({ reason, subject });

  const versions = path.join(options.install, VERSIONS);
  yield* checkOwnFolder(options.install);
  yield* fs.makeDirectory(versions, { recursive: true });
  yield* checkOwnFolder(versions);
  const target = path.join(versions, version);
  if (yield* isRelease(target)) {
    yield* checkOwnFolder(target);
    return { root: target, alreadyThere: true };
  }
  if (Option.isSome(yield* fs.lstat(target).pipe(Effect.option))) {
    return yield* failed("occupied", target);
  }

  const base = yield* releaseBase;
  const download = `${base}/download/v${version}`;
  const stem = `j3-bots-${version}-${platform}`;
  const archive = `${stem}.tar.gz`;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const get = (file: string) =>
    client
      .execute(HttpClientRequest.get(`${download}/${file}`))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));

  const sums = yield* get("SHA256SUMS").pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError(() => failed("checksums-unreadable")),
  );
  const expected = digestOf(sums, archive);
  if (Option.isNone(expected)) return yield* failed("no-archive");

  // Unpacked beside the versions, so the move into place is a rename; gone
  // afterwards whatever happened, unless it was moved.
  const staging = yield* fs.makeTempDirectory({ directory: versions, prefix: ".staging-" });
  return yield* Effect.gen(function* () {
    const downloaded = path.join(staging, archive);
    const hash = NodeCrypto.createHash("sha256");
    yield* get(archive).pipe(
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
          Stream.run(fs.sink(downloaded, { flag: "wx", mode: 0o600 })),
        ),
      ),
      Effect.mapError(() => failed("download")),
    );
    if (hash.digest("hex") !== expected.value) return yield* failed("checksum");

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
    yield* fs.rename(unpacked, target);
    return { root: target, alreadyThere: false };
  }).pipe(
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});
