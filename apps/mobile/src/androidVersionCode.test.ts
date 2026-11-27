// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { androidVersionCode } from "./androidVersionCode.ts";

/** Each version in the order a phone must accept them as updates. */
const releases = [
  "0.0.0",
  "0.1.0-rc.1",
  "0.1.0-rc.2",
  "0.1.0-rc.98",
  "0.1.0",
  "0.1.1",
  "0.1.99",
  "0.2.0-rc.1",
  "0.2.0",
  "0.3.0-rc.1",
  "0.3.0",
  "0.3.1-nightly.20260101.1",
  "0.3.1-nightly.20261124.57",
  "0.3.1-nightly.20261125.58",
  "0.3.1-nightly.20500821.9000",
  "0.3.1-rc.1",
  "0.3.1-rc.98",
  "0.3.1",
  "0.3.2-nightly.20261201.70",
  "0.3.2",
  "0.99.99",
  "1.0.0",
  "1.4.1",
  "1.5.0",
  "20.99.99",
];

describe("androidVersionCode", () => {
  it("grows with the version: nightlies, then release candidates, then the release", () => {
    const codes = releases.map(androidVersionCode);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("puts each part of the version in a fixed place", () => {
    expect(androidVersionCode("0.3.1-nightly.20261124.57")).toBe(3_010_328);
    expect(androidVersionCode("1.5.0-rc.3")).toBe(105_009_003);
    expect(androidVersionCode("1.4.1")).toBe(104_019_999);
    expect(androidVersionCode("20.99.99")).toBeLessThanOrEqual(2_100_000_000);
  });

  it("refuses a version it cannot order", () => {
    for (const version of [
      "1.4",
      "v1.4.0",
      "01.4.0",
      "1.4.0-beta.1",
      "1.4.0-rc",
      "1.4.0-rc.0",
      "1.4.0-rc.99",
      "0.2.0-rc.99",
      "1.4.0-rc.1.2",
      "1.100.0",
      "1.4.100",
      "21.0.0",
      "0.3.1-nightly.20251231.1",
      "0.3.1-nightly.20500822.1",
      "0.3.1-nightly.20261131.1",
      "0.3.1-nightly.2026112.1",
      "0.3.1-nightly.20261124.0",
      "0.3.1-nightly.20261124",
    ])
      expect(() => androidVersionCode(version), version).toThrow(version);
  });
});
