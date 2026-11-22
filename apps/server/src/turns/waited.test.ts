// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { waitedWithin } from "./waited.ts";

const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 22, 10, 0, seconds));

describe("waitedWithin", () => {
  it("leaves the time a card waited on the operator out of the work", () => {
    expect(waitedWithin([{ from: at(10), until: at(40) }], at(0), at(45))).toBe(30_000);
  });

  it("counts time two cards waited together once, and a card still open until the end", () => {
    const spans = [
      { from: at(10), until: at(30) },
      { from: at(20), until: null },
    ];
    expect(waitedWithin(spans, at(0), at(50))).toBe(40_000);
  });

  it("counts only the part inside the span", () => {
    expect(waitedWithin([{ from: at(0), until: at(20) }], at(10), at(15))).toBe(5_000);
    expect(waitedWithin([{ from: at(30), until: at(40) }], at(0), at(20))).toBe(0);
  });
});
