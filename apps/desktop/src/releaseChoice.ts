// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import { releaseFolder } from "@j3-bots/desktop-bridge";
import { type Candidate, GitHubRelease, GitHubReleases, newestOn } from "@j3-bots/release";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Which release the app updates to. electron-updater's own GitHub feed takes,
// on a channel it is given, only releases of that channel (read in
// electron-updater 6.8.9, `providers/GitHubProvider.js`), so a nightly build
// would never be offered a stable release. The app picks the release itself,
// by the policy the server's feed follows (`newestOn` in `@j3-bots/release`):
// on stable, the newest stable release; on nightly, the newest of the stable
// releases and the nightly builds. electron-updater then reads that release's
// own feed file, from its own folder, and installs only a version newer than
// the running one.

/** The repository's releases, as GitHub's REST API serves them. */
const RELEASES_API = "https://api.github.com/repos/JPSAUD501/j3-bots/releases";

/** How many of the newest releases a nightly check reads, as the server's feed does. */
const NIGHTLY_PAGE = 30;

/** How long GitHub may take to answer before the check fails. */
const RELEASES_WITHIN = Duration.seconds(30);

/** The releases could not be read: no answer in time, another status than 200 or 404, or JSON the API does not send. */
export class ReleasesUnreadable extends Schema.TaggedError<ReleasesUnreadable>()(
  "ReleasesUnreadable",
  {},
) {}

export interface ReleaseChoicePorts {
  /** The JSON GitHub answers at `url`, or null for a 404. `signal` aborts the request. */
  readonly getJson: (url: string, signal: AbortSignal) => Promise<unknown>;
}

const decodeLatest = Schema.decodeUnknownEffect(GitHubRelease);
const decodeReleases = Schema.decodeUnknownEffect(GitHubReleases);

/** The newest release `channel` offers, or none while it has none. */
export const newestRelease = Effect.fn("desktop.newestRelease")(function* (
  channel: UpdateChannel,
  ports: ReleaseChoicePorts,
) {
  const json = yield* Effect.tryPromise({
    try: (signal) =>
      ports.getJson(
        channel === "stable"
          ? `${RELEASES_API}/latest`
          : `${RELEASES_API}?per_page=${NIGHTLY_PAGE}`,
        signal,
      ),
    catch: () => new ReleasesUnreadable(),
  }).pipe(
    Effect.timeoutOrElse({
      duration: RELEASES_WITHIN,
      orElse: () => Effect.fail(new ReleasesUnreadable()),
    }),
  );
  // `releases/latest` answers 404 while there is no stable release yet.
  if (json === null) return Option.none<Candidate>();
  const releases = yield* (
    channel === "stable"
      ? Effect.map(decodeLatest(json), (release) => [release])
      : decodeReleases(json)
  ).pipe(Effect.mapError(() => new ReleasesUnreadable()));
  return newestOn(releases, channel);
});

/**
 * The feed electron-updater reads for `release`: the folder of its files,
 * and the feed file its kind of release publishes there, `latest*.yml` for a
 * stable release and `nightly*.yml` for a nightly build.
 */
export const feedOf = (release: Candidate) => ({
  provider: "generic" as const,
  url: releaseFolder(release.version),
  channel: release.channel === "nightly" ? "nightly" : "latest",
});

/**
 * What electron-updater read from a release's feed file, as far as where it
 * downloads from and what version it says it is: the files, and the older
 * `path` and Windows `packages` it also downloads from when present.
 */
const FeedInfo = Schema.Struct({
  version: Schema.String,
  files: Schema.Array(Schema.Struct({ url: Schema.String })),
  path: Schema.optional(Schema.String),
  packages: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ path: Schema.String }))),
  ),
});
const decodeFeedInfo = Schema.decodeUnknownOption(FeedInfo);

/**
 * Whether `info`, the feed file electron-updater read for `release`, is that
 * release's own: it names the same version, and every file it would download
 * is a file directly in the release's folder, resolved as electron-updater
 * resolves it (`new URL(url, folder)`). Anyone who can change a release's
 * files can change its feed file; without this, it could send the download to
 * another release, another path or another host, or name another version.
 * The app reads the feed without downloading and downloads only once this
 * holds, so nothing is asked of another place first.
 */
export const feedKeeps = (release: Candidate, info: unknown): boolean => {
  const folder = releaseFolder(release.version);
  const inFolder = (url: string): boolean => {
    if (!URL.canParse(url, folder)) return false;
    const resolved = new URL(url, folder);
    const name = resolved.href.startsWith(folder) ? resolved.href.slice(folder.length) : "";
    return name.length > 0 && !name.includes("/") && resolved.search === "" && resolved.hash === "";
  };
  return Option.match(decodeFeedInfo(info), {
    onNone: () => false,
    onSome: (feed) =>
      feed.version === release.version &&
      feed.files.length > 0 &&
      feed.files.every((file) => inFolder(file.url)) &&
      (feed.path === undefined || inFolder(feed.path)) &&
      Object.values(feed.packages ?? {}).every((entry) => inFolder(entry.path)),
  });
};
