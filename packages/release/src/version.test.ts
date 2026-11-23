// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { channelOf, compareVersions, isNewer } from "./version.ts";

describe("version order", () => {
  it("orders versions as releases are numbered, nightly builds between the stable releases around them", () => {
    const ordered = [
      "0.2.9",
      "0.3.0-alpha",
      "0.3.0-alpha.1",
      "0.3.0-beta",
      "0.3.0-rc.2",
      "0.3.0-rc.10",
      "0.3.0",
      "0.3.1-nightly.20261123.1",
      "0.3.1-nightly.20261124.2",
      "0.3.1-nightly.20261124.10",
      "0.3.1-nightly.20261201.1",
      "0.3.1-rc.1",
      "0.3.1",
      "0.3.2-nightly.20261202.1",
      "0.10.0",
      "1.0.0",
    ];
    for (const [index, version] of ordered.entries()) {
      for (const [other, than] of ordered.entries()) {
        assert.deepStrictEqual(
          compareVersions(version, than),
          Option.some(Math.sign(index - other)),
          `${version} against ${than}`,
        );
      }
    }
  });

  it("orders two builds of one version as equal, and a version that is not one as nothing", () => {
    assert.deepStrictEqual(compareVersions("0.3.0+a", "0.3.0+b"), Option.some(0));
    assert.deepStrictEqual(compareVersions("0.3.0+a", "0.3.1"), Option.some(-1));
    assert.isTrue(Option.isNone(compareVersions("nightly", "0.3.0")));
    assert.isTrue(Option.isNone(compareVersions("0.3", "0.3.0")));
  });

  it("calls newer only what sorts strictly after, never what cannot be ordered", () => {
    assert.isTrue(isNewer("0.3.2", "0.3.1"));
    assert.isFalse(isNewer("0.3.1", "0.3.1"));
    assert.isFalse(isNewer("0.3.0", "0.3.1-nightly.20261124.1"));
    assert.isFalse(isNewer("0.3.1", "unversioned"));
  });

  it("tells the channel from the version, and no channel for a release candidate or a stray shape", () => {
    assert.deepStrictEqual(channelOf("0.3.1"), Option.some("stable"));
    assert.deepStrictEqual(channelOf("0.3.2-nightly.20261124.7"), Option.some("nightly"));
    for (const version of [
      "0.3.1-rc.1",
      "0.3.1+build",
      "0.3.2-nightly.2026112.7",
      "0.3.2-nightly.20261124.07",
      "0.3.2-nightly.20261124",
      "v0.3.1",
    ]) {
      assert.isTrue(Option.isNone(channelOf(version)), version);
    }
  });
});
