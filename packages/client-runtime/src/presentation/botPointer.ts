// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState } from "@j3-bots/contracts";
import { pointer } from "@j3-bots/design-tokens";
import type { Point } from "./browser.ts";

// A bot's pointer over a page it browses, the same on a phone, on the web
// and on the desktop: when it thinks, when its tag closes, and where it moves
// while the person holds the tab. How it moves is `pointerMotion.ts`; how it
// looks is `pointer` in the tokens.

/**
 * Whether a bot's pointer drifts, thinking before it acts: its turn runs and no
 * step of it does, as between one action on the page and the next. Not while
 * the turn may be stalled, which holds still.
 */
export const pointerThinks = (state: BotState): boolean => {
  switch (state._tag) {
    case "thinking":
      return !state.stalled;
    case "working":
      return !state.stalled && state.activityKind === null && state.tool === null;
    default:
      return false;
  }
};

/**
 * How long a pointer's tag stays open once the pointer arrives, in ms: through
 * the face's answer to a click, and `pointer.tagLinger` after.
 */
export const tagCloseAfter = (action: "move" | "click"): number =>
  (action === "click" ? pointer.clickAnswer : 0) + pointer.tagLinger;

/**
 * Where a pointer at `at`, as shares of the page, moves to while the person
 * holds the tab, in pixels from where it points: aside, to where the page has
 * room, so it is out of the person's way.
 */
export const pointerAside = (at: Point): Point => ({
  x: (at.x > 0.6 ? -1 : 1) * pointer.aside.x,
  y: (at.y > 0.6 ? -1 : 1) * pointer.aside.y,
});
