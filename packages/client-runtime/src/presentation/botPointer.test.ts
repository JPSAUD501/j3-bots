// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState } from "@j3-bots/contracts";
import { pointer } from "@j3-bots/design-tokens";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import { alongGlide, glideBend, pointerAside, pointerThinks } from "./botPointer.ts";

const since = at("2026-11-28T10:00:00Z");
const turn = { since, stalled: false, typing: false, retrying: false };
const working = (step: Partial<Extract<BotState, { _tag: "working" }>>): BotState => ({
  _tag: "working",
  ...turn,
  activity: null,
  activityKind: null,
  tool: null,
  littleOnes: 0,
  ...step,
});

describe("a bot pointer's glide", () => {
  it("bends square to the move by a share of its length, to the side asked", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    expect(glideBend(from, to, 1)).toEqual({ x: 50, y: 100 * pointer.bend });
    expect(glideBend(from, to, -1)).toEqual({ x: 50, y: -100 * pointer.bend });
  });

  it("leaves from where it was and lands where the bot points", () => {
    const from = { x: 10, y: 40 };
    const to = { x: 300, y: 120 };
    const bend = glideBend(from, to, 1);
    expect(alongGlide(from, bend, to, 0)).toEqual(from);
    expect(alongGlide(from, bend, to, 1)).toEqual(to);
  });

  it("stays put for a move of no length", () => {
    const here = { x: 20, y: 30 };
    expect(glideBend(here, here, 1)).toEqual(here);
  });
});

describe("a bot pointer's bob", () => {
  it("bobs while the turn thinks before its next step, and not while a step runs", () => {
    expect(pointerThinks({ _tag: "thinking", ...turn })).toBe(true);
    expect(pointerThinks(working({}))).toBe(true);
    expect(pointerThinks(working({ activityKind: "tool", tool: "browser" }))).toBe(false);
    expect(pointerThinks({ _tag: "idle" })).toBe(false);
  });

  it("holds still while the turn may be stalled", () => {
    expect(pointerThinks({ _tag: "thinking", ...turn, stalled: true })).toBe(false);
    expect(pointerThinks(working({ stalled: true }))).toBe(false);
  });
});

describe("a bot pointer while the person holds the tab", () => {
  it("steps aside toward the page's middle", () => {
    expect(pointerAside({ x: 0.2, y: 0.2 })).toEqual(pointer.aside);
    expect(pointerAside({ x: 0.9, y: 0.9 })).toEqual({ x: -pointer.aside.x, y: -pointer.aside.y });
  });
});
