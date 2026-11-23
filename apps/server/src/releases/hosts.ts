// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

// Where a request for releases may go. A release's files are downloaded from
// its releases page, which redirects each one to GitHub's host for release
// files (**Verified** 2026-11-24: `github.com/<repository>/releases/download/
// <tag>/<file>` answers 302 to `release-assets.githubusercontent.com`). A
// redirect anywhere else is refused before any request is sent to it, so an
// answer from the releases page, or from a mirror, never points the server at
// another host, one on its own network included.

/** GitHub's host for release files, where the releases page sends each download. */
export const GITHUB_RELEASE_FILES = "https://release-assets.githubusercontent.com";

/** The most redirects a request for releases follows. */
const MAX_REDIRECTS = 5;

/** A request, or a redirect, to an origin releases are not read from; no request was sent to it. */
class ReleaseHostRefused extends Schema.TaggedError<ReleaseHostRefused>()("ReleaseHostRefused", {
  origin: Schema.String,
}) {}

const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null);

/**
 * `client`, following redirects, that sends requests only to the origins of
 * `bases` (the releases page and the API, or their mirrors) and to
 * `GITHUB_RELEASE_FILES`. Any other origin, whether asked for or redirected
 * to, fails with `ReleaseHostRefused` before a request is sent.
 */
export const onlyToReleaseHosts =
  (bases: ReadonlyArray<string>) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) => {
    const allowed = new Set([
      ...bases.flatMap((base) => originOf(base) ?? []),
      GITHUB_RELEASE_FILES,
    ]);
    return client.pipe(
      HttpClient.transform(
        (
          response,
          request,
        ): Effect.Effect<HttpClientResponse.HttpClientResponse, E | ReleaseHostRefused, R> => {
          const origin = originOf(request.url) ?? request.url;
          return allowed.has(origin) ? response : Effect.fail(new ReleaseHostRefused({ origin }));
        },
      ),
      HttpClient.followRedirects(MAX_REDIRECTS),
    );
  };
