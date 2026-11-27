// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { claimsSwipe, REACH, REPLY_AT, swipeOffset } from "./swipe.ts";

describe("swiping a message to reply", () => {
  it("takes a mostly sideways move forward, and leaves a scroll or a jitter to the list", () => {
    expect(claimsSwipe(20, 4, false)).toBe(true);
    // Up or down as much as across: a scroll.
    expect(claimsSwipe(20, 12, false)).toBe(false);
    // A finger that barely moved: still a press.
    expect(claimsSwipe(8, 0, false)).toBe(false);
    // Backward.
    expect(claimsSwipe(-20, 0, false)).toBe(false);
  });

  it("goes forward the other way in a right-to-left layout", () => {
    expect(claimsSwipe(-20, 0, true)).toBe(true);
    expect(claimsSwipe(20, 0, true)).toBe(false);
  });

  it("follows the finger to where releasing replies, then slows and stops short", () => {
    expect(swipeOffset(-30)).toBe(0);
    expect(swipeOffset(REPLY_AT / 2)).toBe(REPLY_AT / 2);
    expect(swipeOffset(REPLY_AT)).toBe(REPLY_AT);
    const past = swipeOffset(REPLY_AT + 40);
    expect(past).toBeGreaterThan(REPLY_AT);
    expect(past).toBeLessThan(REPLY_AT + 40);
    // However far the finger goes, the message goes no farther than its reach.
    expect(swipeOffset(10_000)).toBeGreaterThan(past);
    expect(swipeOffset(10_000)).toBeLessThanOrEqual(REACH);
  });
});
