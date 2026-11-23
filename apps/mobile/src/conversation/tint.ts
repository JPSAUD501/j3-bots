// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar } from "@j3-bots/contracts";
import { type BotColor, resolveAvatar } from "@j3-bots/design-tokens";
import { useColor } from "../theme.ts";

/**
 * The color a conversation takes from a bot. Everything that tints with a
 * bot reads it here, so a change of how bots are colored changes only this.
 */
const botColorOf = (avatar: Avatar): BotColor => resolveAvatar(avatar).color;

// Written out whole, so Tailwind finds each class.
const inks = {
  red: "accent-bot-red",
  orange: "accent-bot-orange",
  yellow: "accent-bot-yellow",
  green: "accent-bot-green",
  teal: "accent-bot-teal",
  blue: "accent-bot-blue",
  indigo: "accent-bot-indigo",
  violet: "accent-bot-violet",
  pink: "accent-bot-pink",
  gray: "accent-bot-gray",
} as const satisfies Record<BotColor, string>;

const bubbles = {
  red: "accent-bot-bubble-red",
  orange: "accent-bot-bubble-orange",
  yellow: "accent-bot-bubble-yellow",
  green: "accent-bot-bubble-green",
  teal: "accent-bot-bubble-teal",
  blue: "accent-bot-bubble-blue",
  indigo: "accent-bot-bubble-indigo",
  violet: "accent-bot-bubble-violet",
  pink: "accent-bot-bubble-pink",
  gray: "accent-bot-bubble-gray",
} as const satisfies Record<BotColor, string>;

/** A conversation's tint: the bot's color, and its bubbles' fill. */
export interface Tint {
  readonly color: string;
  readonly bubble: string;
}

/**
 * The tint of `avatar`'s bot in the current theme; without a bot, as in a
 * room's composer, the neutral ink and bubble.
 */
export function useTint(avatar: Avatar | null): Tint {
  const color = avatar === null ? null : botColorOf(avatar);
  return {
    color: useColor(color === null ? "accent-foreground" : inks[color]),
    bubble: useColor(color === null ? "accent-bubble-bot" : bubbles[color]),
  };
}
