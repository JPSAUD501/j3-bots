// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { sprung } from "./sprung";

const frames: Array<FrameRequestCallback> = [];
let now = 0;

beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames.length = 0;
  });
});

const moving: Array<{ readonly stop: () => void }> = [];

afterEach(() => {
  // The loop is the page's one: each test leaves it at rest for the next.
  for (const value of moving.splice(0)) value.stop();
  run(2);
  vi.unstubAllGlobals();
});

/** Runs `count` frames, 16 ms apart, as far as the loop keeps asking for them. */
function run(count: number) {
  for (let i = 0; i < count; i++) {
    now += 16;
    for (const callback of frames.splice(0)) callback(now);
  }
}

/** A value on `slide`, with every place it was drawn at. */
function travelling() {
  const drawn: Array<number> = [];
  let rests = 0;
  const value = sprung(
    { y: 0 },
    "slide",
    ({ y }) => drawn.push(y),
    () => rests++,
  );
  moving.push(value);
  const speed = () => (drawn.at(-1) ?? 0) - (drawn.at(-2) ?? 0);
  return { value, drawn, speed, rests: () => rests };
}

it("bends a move toward a new target from where it is, at the speed it has", () => {
  const { value, drawn, speed } = travelling();
  value.to({ y: 100 });
  run(7);
  const before = speed();
  expect(before).toBeGreaterThan(2);
  value.to({ y: 300 });
  run(1);
  // It went on, a little faster for the farther target: an easing begun again would have stood still.
  expect(speed()).toBeGreaterThan(before * 0.8);
  run(200);
  expect(drawn.at(-1)).toBe(300);
});

it("moves what was laid out elsewhere without touching its speed", () => {
  const { value, drawn, speed } = travelling();
  value.to({ y: 100 });
  run(7);
  const before = speed();
  const at = drawn.at(-1) ?? 0;
  value.shift({ y: -40 });
  expect(drawn.at(-1)).toBeCloseTo(at - 40, 6);
  run(1);
  expect(speed()).toBeGreaterThan(before * 0.8);
});

it("waits out its delay where it is, then sets off", () => {
  const { value, drawn } = travelling();
  value.jump({ y: 50 });
  value.to({ y: 0 }, { delay: 80 });
  run(4);
  expect(drawn.at(-1)).toBe(50);
  run(8);
  expect(drawn.at(-1)).toBeLessThan(50);
});

it("asks for no more frames once it has arrived, and says so once", () => {
  const { value, rests } = travelling();
  value.to({ y: 100 });
  run(200);
  expect(rests()).toBe(1);
  expect(frames).toHaveLength(0);
});
