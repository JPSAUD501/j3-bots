// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Swiping a message toward the reading direction to reply to it, as in the
 * messaging apps people know. Distances are in dp, measured forward: to the
 * right in a left-to-right layout, to the left in a right-to-left one.
 */

/** How far forward a finger travels before the swipe takes the touch from the list. */
const CLAIM = 12;
/** How far forward releasing replies. */
export const REPLY_AT = 64;
/** The farthest the message goes, however far the finger does. */
export const REACH = 96;

/**
 * Whether a finger that moved `dx`, `dy` from where it went down is swiping to
 * reply: forward past `CLAIM` and at least twice as far across as up or down,
 * so a scroll stays a scroll and a long press stays a long press.
 */
export const claimsSwipe = (dx: number, dy: number, rtl: boolean): boolean => {
  const forward = rtl ? -dx : dx;
  return forward > CLAIM && forward > 2 * Math.abs(dy);
};

/**
 * How far the message follows a finger `forward` dp along: with it up to
 * `REPLY_AT`, then more and more slowly, never past `REACH`; not at all
 * backward.
 */
export const swipeOffset = (forward: number): number => {
  if (forward <= 0) return 0;
  if (forward <= REPLY_AT) return forward;
  const room = REACH - REPLY_AT;
  return REPLY_AT + room * (1 - Math.exp(-(forward - REPLY_AT) / room));
};

/** How far along to replying a finger `forward` dp along is, from 0 to 1. */
export const swipeProgress = (forward: number): number =>
  Math.min(1, Math.max(0, forward / REPLY_AT));
