// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, assert, beforeEach, describe, it, vi } from "vite-plus/test";
import { conversationVisuals } from "./visuals.ts";

describe("whether a conversation's list is moving", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves from the first scroll until scrolls stop, telling its visuals once each way", () => {
    const visuals = conversationVisuals();
    const heard: Array<boolean> = [];
    visuals.subscribe(() => heard.push(visuals.moving()));

    visuals.scrolled();
    vi.advanceTimersByTime(100);
    visuals.scrolled();
    vi.advanceTimersByTime(100);
    assert.isTrue(visuals.moving());
    vi.advanceTimersByTime(50);

    assert.isFalse(visuals.moving());
    assert.deepStrictEqual(heard, [true, false]);
  });

  it("leaves no timer behind when the conversation closes mid-scroll", () => {
    const visuals = conversationVisuals();
    visuals.scrolled();
    visuals.end();
    assert.isFalse(visuals.moving());
    assert.strictEqual(vi.getTimerCount(), 0);
  });

  it("tells nothing to a visual that left", () => {
    const visuals = conversationVisuals();
    let heard = 0;
    const leave = visuals.subscribe(() => heard++);
    leave();
    visuals.scrolled();
    vi.runAllTimers();
    assert.strictEqual(heard, 0);
  });
});
