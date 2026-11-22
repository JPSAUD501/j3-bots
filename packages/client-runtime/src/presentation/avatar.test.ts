// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState, NotificationKind } from "@j3-bots/contracts";
import { EntryId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import { avatarAppearance, notificationLook } from "./avatar.ts";

const since = at("2026-11-20T10:00:00Z");
const states: ReadonlyArray<readonly [BotState, boolean]> = [
  [{ _tag: "idle" }, false],
  [{ _tag: "idle" }, true],
  [{ _tag: "thinking", since, stalled: false }, false],
  [{ _tag: "working", since, stalled: false, activity: null, tool: null }, false],
  [{ _tag: "waiting", entryId: EntryId.make("q") }, false],
  [{ _tag: "blocked", failure: "unknown", retryAt: null }, false],
  [{ _tag: "working", since, stalled: true, activity: null, tool: null }, false],
];

describe("avatarAppearance", () => {
  it("gives every state, and done, its own mark, so the avatar reads without motion", () => {
    const marks = states.map(([state, unread]) => avatarAppearance(state, unread).mark);
    expect(new Set(marks).size).toBe(states.length);
  });

  it("stops a stalled turn's motion, thinking or working alike", () => {
    expect(avatarAppearance({ _tag: "thinking", since, stalled: true }, false)).toEqual(
      avatarAppearance(
        { _tag: "working", since, stalled: true, activity: "Reading", tool: null },
        false,
      ),
    );
    expect(
      avatarAppearance({ _tag: "working", since, stalled: true, activity: null, tool: null }, false)
        .motion,
    ).toBe("none");
  });
});

describe("notificationLook", () => {
  const about = (kind: NotificationKind) => ({ kind, entryId: EntryId.make("e") });
  const working: BotState = { _tag: "working", since, stalled: false, activity: null, tool: null };
  const look = (kind: NotificationKind, state: BotState) => {
    const { mark, badge } = notificationLook(about(kind), state);
    return { mark, badge };
  };

  it.each(["question", "approval", "secret-request"] as const)(
    "shows a %s as waiting on the operator, though the roster still has the bot working",
    (kind) => {
      expect(look(kind, working)).toEqual({ mark: "notch", badge: "waiting" });
    },
  );

  it.each(["message", "handoff"] as const)(
    "shows a %s as done and not read yet, even while the turn goes on",
    (kind) => {
      expect(look(kind, working)).toEqual({ mark: "check", badge: "unread" });
      expect(look(kind, { _tag: "idle" })).toEqual({ mark: "check", badge: "unread" });
    },
  );

  it.each(["message", "question"] as const)("shows a blocked bot's %s as blocked", (kind) => {
    expect(look(kind, { _tag: "blocked", failure: "usage-limit", retryAt: null })).toEqual({
      mark: "slash",
      badge: "blocked",
    });
  });

  it("shows a message from a bot waiting on another card as waiting", () => {
    expect(look("message", { _tag: "waiting", entryId: EntryId.make("q") })).toEqual({
      mark: "notch",
      badge: "waiting",
    });
  });
});
