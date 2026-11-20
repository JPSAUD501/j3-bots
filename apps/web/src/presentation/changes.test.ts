// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { firstSeen, see } from "./changes";

describe("see", () => {
  it("counts changes from the first value seen, which is not one", () => {
    const first = firstSeen("dot");
    expect(first.changes).toBe(0);
    const ring = see(first, "ring");
    expect(ring).toEqual({ value: "ring", changes: 1 });
    expect(see(see(ring, "dot"), "ring").changes).toBe(3);
  });

  it("returns the same record while the value stays, so nothing is stored again", () => {
    const seen = see(firstSeen("dot"), "ring");
    expect(see(seen, "ring")).toBe(seen);
  });
});
