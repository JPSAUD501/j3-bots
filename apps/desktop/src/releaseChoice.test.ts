// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { GitHubRelease } from "@j3-bots/release";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { feedKeeps, feedOf, newestRelease, type ReleaseChoicePorts } from "./releaseChoice.ts";

const RELEASES = "https://github.com/JPSAUD501/j3-bots/releases";

/** A published release of `version`, under the tag its kind of release takes. */
const published = (version: string, nightly = false): GitHubRelease => {
  const tag = nightly ? version : `v${version}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: nightly,
    published_at: "2026-11-23T04:41:00Z",
    html_url: `${RELEASES}/tag/${tag}`,
  };
};

/** GitHub, answering `latest` for `releases/latest` and `page` for the newest releases. */
const github = (answers: {
  readonly latest: unknown;
  readonly page: unknown;
}): ReleaseChoicePorts => ({
  getJson: (url) =>
    Promise.resolve(url.endsWith("/releases/latest") ? answers.latest : answers.page),
});

const versionOf = Option.map((release: { readonly version: string }) => release.version);

describe("the release the app updates to", () => {
  const stable = published("0.3.2");
  const nightlyBefore = published("0.3.2-nightly.20261122.1", true);

  it.effect("on nightly is a stable release when it is the newest", () =>
    Effect.gen(function* () {
      const newest = yield* newestRelease(
        "nightly",
        github({ latest: stable, page: [stable, nightlyBefore] }),
      );
      assert.deepStrictEqual(versionOf(newest), Option.some("0.3.2"));
    }),
  );

  it.effect("on nightly is the nightly build after the last stable release", () =>
    Effect.gen(function* () {
      const nightlyAfter = published("0.3.3-nightly.20261124.1", true);
      const newest = yield* newestRelease(
        "nightly",
        github({ latest: stable, page: [nightlyAfter, stable, nightlyBefore] }),
      );
      assert.deepStrictEqual(versionOf(newest), Option.some("0.3.3-nightly.20261124.1"));
    }),
  );

  it.effect("on stable is the latest stable release, and none before there is one", () =>
    Effect.gen(function* () {
      const found = yield* newestRelease("stable", github({ latest: stable, page: [] }));
      const none = yield* newestRelease("stable", github({ latest: null, page: [] }));
      assert.deepStrictEqual([versionOf(found), none], [Option.some("0.3.2"), Option.none()]);
    }),
  );

  it.effect("fails when GitHub answers something that is not its releases", () =>
    Effect.gen(function* () {
      const failure = yield* newestRelease(
        "nightly",
        github({ latest: stable, page: { message: "Not Found" } }),
      ).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ReleasesUnreadable");
    }),
  );
});

describe("the feed electron-updater reads", () => {
  it.effect("is the chosen release's own folder, with the feed file of its kind", () =>
    Effect.gen(function* () {
      const stable = published("0.3.2");
      const nightly = published("0.3.3-nightly.20261124.1", true);
      const feeds = yield* Effect.forEach(
        [
          github({ latest: stable, page: [stable] }),
          github({ latest: stable, page: [nightly, stable] }),
        ],
        (answers) => Effect.map(newestRelease("nightly", answers), Option.map(feedOf)),
      );
      assert.deepStrictEqual(feeds, [
        Option.some({
          provider: "generic",
          url: `${RELEASES}/download/v0.3.2/`,
          channel: "latest",
        }),
        Option.some({
          provider: "generic",
          url: `${RELEASES}/download/0.3.3-nightly.20261124.1/`,
          channel: "nightly",
        }),
      ]);
    }),
  );
});

describe("a release's feed file", () => {
  it.effect("is taken only when it names the release's version and files in its own folder", () =>
    Effect.gen(function* () {
      const chosen = yield* newestRelease(
        "stable",
        github({ latest: published("0.3.2"), page: [] }),
      );
      if (Option.isNone(chosen)) return assert.fail("no release was chosen");
      const appImage = "J3-Bots-x86_64.AppImage";
      const feed = (version: string, url: string) => ({
        version,
        files: [{ url, sha512: "unchecked here" }],
        path: url,
      });
      const taken = (info: unknown) => feedKeeps(chosen.value, info);
      assert.deepStrictEqual(
        [
          taken(feed("0.3.2", appImage)),
          taken(feed("0.3.2", `${RELEASES}/download/v0.3.2/${appImage}`)),
          taken(feed("0.3.3-nightly.20261124.1", appImage)),
          taken(feed("0.3.2", `../0.3.3-nightly.20261124.1/${appImage}`)),
          taken(feed("0.3.2", `https://example.test/${appImage}`)),
          taken(feed("0.3.2", `${appImage}?from=elsewhere`)),
          taken({
            ...feed("0.3.2", appImage),
            packages: { x64: { path: "https://example.test/app.7z" } },
          }),
          taken({ version: "0.3.2", files: [] }),
        ],
        [true, true, false, false, false, false, false, false],
      );
    }),
  );
});
