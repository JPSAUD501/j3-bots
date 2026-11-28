// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState } from "@j3-bots/contracts";
import { pointer } from "@j3-bots/design-tokens";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import { pointerAside, pointerThinks } from "./botPointer.ts";

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

describe("a bot pointer's drift", () => {
  it("drifts while the turn thinks before its next step, and not while a step runs", () => {
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
  it("moves aside toward the page's middle", () => {
    expect(pointerAside({ x: 0.2, y: 0.2 })).toEqual(pointer.aside);
    expect(pointerAside({ x: 0.9, y: 0.9 })).toEqual({ x: -pointer.aside.x, y: -pointer.aside.y });
  });
});
