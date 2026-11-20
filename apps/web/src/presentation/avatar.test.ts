// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState } from "@j3-bots/contracts";
import { EntryId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../test/fixtures";
import { avatarAppearance } from "./avatar";

const since = at("2026-11-20T10:00:00Z");
const states: ReadonlyArray<readonly [BotState, boolean]> = [
  [{ _tag: "idle" }, false],
  [{ _tag: "idle" }, true],
  [{ _tag: "thinking", since, stalled: false }, false],
  [{ _tag: "working", since, stalled: false, activity: null }, false],
  [{ _tag: "waiting", entryId: EntryId.make("q") }, false],
  [{ _tag: "blocked", failure: "unknown", retryAt: null }, false],
  [{ _tag: "working", since, stalled: true, activity: null }, false],
];

describe("avatarAppearance", () => {
  it("gives every state, and done, its own mark, so the avatar reads without motion", () => {
    const marks = states.map(([state, unread]) => avatarAppearance(state, unread).mark);
    expect(new Set(marks).size).toBe(states.length);
  });

  it("stops a stalled turn's motion, thinking or working alike", () => {
    expect(avatarAppearance({ _tag: "thinking", since, stalled: true }, false)).toEqual(
      avatarAppearance({ _tag: "working", since, stalled: true, activity: "Reading" }, false),
    );
    expect(
      avatarAppearance({ _tag: "working", since, stalled: true, activity: null }, false).motion,
    ).toBe("none");
  });
});
