// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { animate, type Running } from "./ticker";

const frames: Array<FrameRequestCallback> = [];
let now = 0;

beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames.length = 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs the frame the loop asked for. */
function nextFrame() {
  now += 16;
  for (const callback of frames.splice(0)) callback(now);
}

/** An avatar that always may move, and records each time it is drawn and in which state. */
function avatar(size: number) {
  const avatar = { state: "idle", drawn: [] as Array<string> };
  const running: Running = animate({
    size,
    moving: () => true,
    measure: null,
    step: () => avatar.drawn.push(`moving ${avatar.state}`),
    still: () => avatar.drawn.push(`still ${avatar.state}`),
  });
  return Object.assign(avatar, running);
}

it("draws the new state of an avatar it holds over its cap, once", () => {
  const large = Array.from({ length: 24 }, () => avatar(96));
  const held = avatar(48);
  nextFrame();
  expect(large.every(({ drawn }) => drawn.at(-1) === "moving idle")).toBe(true);
  expect(held.drawn).toEqual(["still idle"]);

  held.state = "working";
  held.restate();
  nextFrame();
  nextFrame();
  expect(held.drawn).toEqual(["still idle", "still working"]);

  for (const each of [...large, held]) each.stop();
});
