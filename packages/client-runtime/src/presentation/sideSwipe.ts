// SPDX-License-Identifier: AGPL-3.0-or-later

// A sideways swipe over a live view's bar or a tab's card, the same on a
// phone and in a narrow web page: taken from what is under the finger only
// once it has gone clearly sideways, so the buttons there keep their presses.

/** How far a finger goes sideways before the swipe is taken from what is under it. */
const CLAIM = 16;
/** How far a swipe goes to count, unless it is quick. */
const ENOUGH = 64;
/** How fast a short swipe goes to count, in points per millisecond. */
const QUICK = 0.5;

/** Whether a finger that moved `dx`, `dy` from where it touched now swipes. */
export const claimsSwipe = (dx: number, dy: number): boolean =>
  Math.abs(dx) > CLAIM && Math.abs(dx) > 2 * Math.abs(dy);

/**
 * Which way a swipe of `dx` over `ms` went: 1 toward the end, the finger
 * going toward the start (right to left, but for a language written right
 * to left), -1 the other way, or null when it fell short.
 */
export const swipeDirection = (dx: number, ms: number, rtl: boolean): -1 | 1 | null => {
  const far = Math.abs(dx) > ENOUGH || Math.abs(dx) / Math.max(ms, 1) > QUICK;
  if (!far) return null;
  const toStart = rtl ? dx > 0 : dx < 0;
  return toStart ? 1 : -1;
};
