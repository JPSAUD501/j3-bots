// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { type GitHubRelease, newestOn, offer } from "./github.ts";

const release = (
  tag: string,
  prerelease: boolean,
  extra: Partial<GitHubRelease> = {},
): GitHubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease,
  published_at: "2026-11-24T03:17:00Z",
  html_url: `https://example.test/releases/tag/${tag}`,
  ...extra,
});

const versionOf = (found: ReturnType<typeof newestOn>) =>
  Option.getOrNull(Option.map(found, (candidate) => candidate.version));

describe("the release a channel offers", () => {
  // As the API lists them: by creation, not by version.
  const listed = [
    release("0.3.2-nightly.20261125.1", true),
    release("0.3.2-nightly.20261126.1", true, { draft: true, published_at: null }),
    release("v0.3.1", false),
    release("0.3.2-nightly.20261124.3", true),
    release("v0.3.2-rc.1", true),
    release("0.3.9-nightly.20261124.1", false),
    release("v0.9.0", true),
    release("nightly-latest", true),
    // A tag that does not name its version as releases are tagged.
    release("v0.4.0-nightly.20261124.1", true),
    release("0.4.0", false),
  ];

  it("offers nightly the newest published nightly or stable release, passing over drafts, candidates, other tags and contradictions", () => {
    assert.strictEqual(versionOf(newestOn(listed, "nightly")), "0.3.2-nightly.20261125.1");
    assert.strictEqual(
      versionOf(newestOn([...listed, release("v0.3.2", false)], "nightly")),
      "0.3.2",
    );
  });

  it("offers stable only stable releases", () => {
    assert.strictEqual(versionOf(newestOn(listed, "stable")), "0.3.1");
    assert.isTrue(Option.isNone(newestOn([release("0.3.2-nightly.20261125.1", true)], "stable")));
  });

  it("never offers a release that is not newer than the one running", () => {
    const newest = newestOn([release("v0.3.1", false)], "stable");
    assert.isTrue(Option.isSome(offer({ newest, running: "0.3.0", channel: "stable" }).available));
    assert.deepStrictEqual(offer({ newest, running: "0.3.1", channel: "stable" }), {
      available: Option.none(),
      waitingForStable: false,
    });
  });

  it("waits for a stable release newer than the nightly running after a move to stable", () => {
    const running = "0.3.2-nightly.20261125.1";
    assert.deepStrictEqual(
      offer({ newest: newestOn(listed, "stable"), running, channel: "stable" }),
      { available: Option.none(), waitingForStable: true },
    );
    const moved = offer({
      newest: newestOn([release("v0.3.2", false)], "stable"),
      running,
      channel: "stable",
    });
    assert.strictEqual(versionOf(moved.available), "0.3.2");
    assert.isFalse(moved.waitingForStable);
  });
});
