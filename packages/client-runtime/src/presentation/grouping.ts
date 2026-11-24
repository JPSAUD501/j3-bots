// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a timeline groups what is said in it, the same in a conversation, a
 * room and a teammate conversation.
 */

/** A quiet stretch longer than this gets a time between the rows around it. */
export const DIVIDER_GAP = 15 * 60_000;

/** Consecutive messages from one author closer than this form one group. */
export const GROUP_GAP = 5 * 60_000;
