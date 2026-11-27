// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MessageEntry, type Reaction, ReactionEmoji, type Reactor } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";

const decodeEmoji = Schema.decodeSync(ReactionEmoji);
const emoji = (text: string): ReactionEmoji => decodeEmoji(text);

/** The quick bar's reactions, in its order; "more" opens the picker after them. */
export const QUICK_REACTIONS: ReadonlyArray<ReactionEmoji> = [
  "👍",
  "👎",
  "❤️",
  "😂",
  "🎉",
  "😮",
].map(emoji);

/** A group of the picker, which the interface names. */
export type ReactionGroupId =
  | "smileys"
  | "gestures"
  | "hearts"
  | "nature"
  | "food"
  | "activities"
  | "objects";

/**
 * The picker's reactions, by group: the system's own emoji, drawn by its
 * font, so no emoji library or image ships with the app. Each is one emoji as
 * Unicode defines one, which is all the server takes.
 */
export const REACTION_GROUPS: ReadonlyArray<{
  readonly id: ReactionGroupId;
  readonly emoji: ReadonlyArray<ReactionEmoji>;
}> = (
  [
    [
      "smileys",
      "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤯 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖",
    ],
    [
      "gestures",
      "👍 👎 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 👀 🧠",
    ],
    [
      "hearts",
      "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 ✅ ❌ ❓ ❗ ⭐ 🌟 ✨ ⚡ 🔥 💥 💫 💤 💬",
    ],
    [
      "nature",
      "🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦉 🐝 🦋 🐢 🐙 🐳 🌸 🌻 🌱 🌳 🍀 🌈 ☀️ 🌙 ☔ ❄️",
    ],
    [
      "food",
      "🍎 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥑 🌶️ 🥕 🍞 🧀 🍕 🍔 🍟 🌮 🍣 🍜 🍪 🍰 🎂 🍫 🍿 ☕ 🍵 🍺 🍷 🥂",
    ],
    ["activities", "🎉 🎊 🎈 🎁 🏆 🥇 ⚽ 🏀 🎾 🎮 🎲 🎯 🎨 🎵 🎶 🎸 🚀 ✈️ 🚗 🏖️ 🏠"],
    ["objects", "💡 📌 📎 📝 📅 📈 📉 📦 🔍 🔒 🔑 🔔 💰 💸 💻 📱 ⏰ ⌛ 🛠️ ⚙️ 🧩"],
  ] as const
).map(([id, list]) => ({ id, emoji: list.split(" ").map(emoji) }));

/** The reactions on a message under one emoji, as the message shows them. */
export interface ReactionPill {
  readonly emoji: ReactionEmoji;
  /** Shown beside the emoji when more than one. */
  readonly count: number;
  /** One of them is the operator's: tapping the pill takes it off. */
  readonly mine: boolean;
  /** Who reacted with it, in the order they did: shown on a long press or a hover. */
  readonly by: ReadonlyArray<Reactor>;
}

/** A message's reactions grouped by emoji, in the order each emoji first appeared. */
export const reactionPills = (reactions: ReadonlyArray<Reaction>): ReadonlyArray<ReactionPill> => {
  const pills = new Map<ReactionEmoji, { mine: boolean; by: Array<Reactor> }>();
  for (const reaction of reactions) {
    const pill = pills.get(reaction.emoji) ?? { mine: false, by: [] };
    pill.by.push(reaction.by);
    pill.mine ||= reaction.by._tag === "operator";
    pills.set(reaction.emoji, pill);
  }
  return Array.from(pills, ([emoji, pill]) => ({
    emoji,
    count: pill.by.length,
    mine: pill.mine,
    by: pill.by,
  }));
};

/** The operator's reaction on a message, if any. */
export const ownReaction = (reactions: ReadonlyArray<Reaction>): ReactionEmoji | null =>
  reactions.find((reaction) => reaction.by._tag === "operator")?.emoji ?? null;

/**
 * What picking `picked` leaves as the operator's reaction: it replaces theirs,
 * or, picked again, takes it off.
 */
export const reactionAfterPick = (
  reactions: ReadonlyArray<Reaction>,
  picked: ReactionEmoji,
): ReactionEmoji | null => (ownReaction(reactions) === picked ? null : picked);

/**
 * Whether the operator can react to the message: one the server sends with
 * its reactions, which a server that takes `message.react` does.
 */
export const canReact = (message: MessageEntry): boolean =>
  message.reactions !== undefined && message.author._tag !== "system";
