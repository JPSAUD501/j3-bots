// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { channelOf, compareVersions, isNewer, offeredOn, releaseTag } from "./version.ts";

// Which release a channel offers, from what GitHub's REST API answers for the
// releases of the repository: `releases/latest` (the newest published release
// that is not a pre-release) for stable, and `releases?per_page=N` (the newest
// first, pre-releases included) for nightly.

/** A release as the API answers it: only what the feed reads. */
export const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  /** Null while it is a draft. */
  published_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});
export type GitHubRelease = typeof GitHubRelease.Type;

export const GitHubReleases = Schema.Array(GitHubRelease);

const decodeTime = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

/** A published release the feed may offer. */
export interface Candidate {
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly publishedAt: DateTime.Utc;
  readonly notesUrl: string;
}

/**
 * The release `release` is, when it is one a channel may offer: published
 * under its version's tag (`releaseTag`), a stable release that is not marked
 * pre-release or a nightly build that is. Anything else is passed over: a
 * draft, a release candidate, a tag of another shape, or a flag that
 * contradicts the tag.
 */
export const candidateOf = (release: GitHubRelease): Option.Option<Candidate> => {
  if (release.draft) return Option.none();
  const tag = release.tag_name;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  return Option.flatMap(channelOf(version), (channel) =>
    release.prerelease !== (channel === "nightly") || tag !== releaseTag(version)
      ? Option.none()
      : Option.map(decodeTime(release.published_at), (publishedAt) => ({
          version,
          channel,
          publishedAt,
          notesUrl: release.html_url,
        })),
  );
};

/** Candidates in version order; every candidate's version can be ordered. */
const byVersion: Order.Order<Candidate> = (a, b) =>
  Option.getOrElse(compareVersions(a.version, b.version), () => 0 as const);

/** The newest release among `releases` that `channel` offers. */
export const newestOn = (
  releases: ReadonlyArray<GitHubRelease>,
  channel: UpdateChannel,
): Option.Option<Candidate> => {
  const offered = Arr.filter(Arr.getSomes(releases.map(candidateOf)), (candidate) =>
    offeredOn(candidate.channel, channel),
  );
  return Arr.isArrayNonEmpty(offered) ? Option.some(Arr.max(offered, byVersion)) : Option.none();
};

/**
 * What a server running `running` on `channel` is offered from `newest`, the
 * newest release on the channel: it, when it is newer, and never an older one.
 * `waitingForStable` when the channel is stable and the server runs anything
 * else, and nothing newer is out yet: a move from nightly to stable waits for
 * a stable release newer than the nightly that runs.
 */
export const offer = (input: {
  readonly newest: Option.Option<Candidate>;
  readonly running: string;
  readonly channel: UpdateChannel;
}): { readonly available: Option.Option<Candidate>; readonly waitingForStable: boolean } => {
  const available = Option.filter(input.newest, (candidate) =>
    isNewer(candidate.version, input.running),
  );
  const runsStable = Option.getOrNull(channelOf(input.running)) === "stable";
  return {
    available,
    waitingForStable: input.channel === "stable" && !runsStable && Option.isNone(available),
  };
};
