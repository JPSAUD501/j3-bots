// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar } from "@j3-bots/contracts";
import { type BotColor, resolveAvatar } from "@j3-bots/design-tokens";

/**
 * The color a conversation takes from a bot. Everything that tints with a
 * bot reads it here, so a change of how bots are colored changes only this.
 */
const botColorOf = (avatar: Avatar): BotColor => resolveAvatar(avatar).color;

// Written out whole, so Tailwind finds each class.
const tints = {
  red: "[--tint:var(--bot-red)] [--tint-bubble:var(--bot-bubble-red)]",
  orange: "[--tint:var(--bot-orange)] [--tint-bubble:var(--bot-bubble-orange)]",
  yellow: "[--tint:var(--bot-yellow)] [--tint-bubble:var(--bot-bubble-yellow)]",
  green: "[--tint:var(--bot-green)] [--tint-bubble:var(--bot-bubble-green)]",
  teal: "[--tint:var(--bot-teal)] [--tint-bubble:var(--bot-bubble-teal)]",
  blue: "[--tint:var(--bot-blue)] [--tint-bubble:var(--bot-bubble-blue)]",
  indigo: "[--tint:var(--bot-indigo)] [--tint-bubble:var(--bot-bubble-indigo)]",
  violet: "[--tint:var(--bot-violet)] [--tint-bubble:var(--bot-bubble-violet)]",
  pink: "[--tint:var(--bot-pink)] [--tint-bubble:var(--bot-bubble-pink)]",
  gray: "[--tint:var(--bot-gray)] [--tint-bubble:var(--bot-bubble-gray)]",
} as const satisfies Record<BotColor, string>;

/** Where no one bot speaks, as in a room's composer: the neutral ink and bubble. */
const neutral = "[--tint:var(--foreground)] [--tint-bubble:var(--bubble-bot)]";

/**
 * Sets `--tint`, the bot's color, and `--tint-bubble`, its bubbles' fill, on
 * an element and what it holds; the neutral ones without a bot.
 */
export const tintOf = (avatar: Avatar | null): string =>
  avatar === null ? neutral : tints[botColorOf(avatar)];
