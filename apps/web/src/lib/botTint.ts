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
  tomato: "[--tint:var(--bot-tomato)] [--tint-bubble:var(--bot-bubble-tomato)]",
  tangerine: "[--tint:var(--bot-tangerine)] [--tint-bubble:var(--bot-bubble-tangerine)]",
  honey: "[--tint:var(--bot-honey)] [--tint-bubble:var(--bot-bubble-honey)]",
  lime: "[--tint:var(--bot-lime)] [--tint-bubble:var(--bot-bubble-lime)]",
  mint: "[--tint:var(--bot-mint)] [--tint-bubble:var(--bot-bubble-mint)]",
  teal: "[--tint:var(--bot-teal)] [--tint-bubble:var(--bot-bubble-teal)]",
  sky: "[--tint:var(--bot-sky)] [--tint-bubble:var(--bot-bubble-sky)]",
  cobalt: "[--tint:var(--bot-cobalt)] [--tint-bubble:var(--bot-bubble-cobalt)]",
  iris: "[--tint:var(--bot-iris)] [--tint-bubble:var(--bot-bubble-iris)]",
  orchid: "[--tint:var(--bot-orchid)] [--tint-bubble:var(--bot-bubble-orchid)]",
  rose: "[--tint:var(--bot-rose)] [--tint-bubble:var(--bot-bubble-rose)]",
  slate: "[--tint:var(--bot-slate)] [--tint-bubble:var(--bot-bubble-slate)]",
} as const satisfies Record<BotColor, string>;

/** Where no one bot speaks, as in a room's composer: the neutral ink and bubble. */
const neutral = "[--tint:var(--foreground)] [--tint-bubble:var(--bubble-bot)]";

/**
 * Sets `--tint`, the bot's color, and `--tint-bubble`, its bubbles' fill, on
 * an element and what it holds; the neutral ones without a bot.
 */
export const tintOf = (avatar: Avatar | null): string =>
  avatar === null ? neutral : tints[botColorOf(avatar)];
