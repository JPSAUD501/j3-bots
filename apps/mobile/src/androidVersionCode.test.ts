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
  "0.99.99",
  "1.0.0",
  "1.4.1",
  "1.5.0",
  "2099.99.99",
];

describe("androidVersionCode", () => {
  it("grows with the version, a release candidate below its release", () => {
    const codes = releases.map(androidVersionCode);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("is major, minor, patch and stage in fixed places", () => {
    expect(androidVersionCode("1.4.1")).toBe(1_040_199);
    expect(androidVersionCode("1.5.0-rc.3")).toBe(1_050_003);
    expect(androidVersionCode("2099.99.99")).toBeLessThanOrEqual(2_100_000_000);
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
      "1.4.0-rc.1.2",
      "1.100.0",
      "1.4.100",
      "2100.0.0",
    ])
      expect(() => androidVersionCode(version), version).toThrow(version);
  });
});
