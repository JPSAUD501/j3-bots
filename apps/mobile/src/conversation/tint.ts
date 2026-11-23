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
  tomato: "accent-bot-tomato",
  tangerine: "accent-bot-tangerine",
  honey: "accent-bot-honey",
  lime: "accent-bot-lime",
  mint: "accent-bot-mint",
  teal: "accent-bot-teal",
  sky: "accent-bot-sky",
  cobalt: "accent-bot-cobalt",
  iris: "accent-bot-iris",
  orchid: "accent-bot-orchid",
  rose: "accent-bot-rose",
  slate: "accent-bot-slate",
} as const satisfies Record<BotColor, string>;

const bubbles = {
  tomato: "accent-bot-bubble-tomato",
  tangerine: "accent-bot-bubble-tangerine",
  honey: "accent-bot-bubble-honey",
  lime: "accent-bot-bubble-lime",
  mint: "accent-bot-bubble-mint",
  teal: "accent-bot-bubble-teal",
  sky: "accent-bot-bubble-sky",
  cobalt: "accent-bot-bubble-cobalt",
  iris: "accent-bot-bubble-iris",
  orchid: "accent-bot-bubble-orchid",
  rose: "accent-bot-bubble-rose",
  slate: "accent-bot-bubble-slate",
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
