// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, BotId, ConversationMention } from "@j3-bots/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { View } from "react-native";
import {
  AvatarsAsleep,
  BotAvatar,
  RoomAvatar,
  roomAvatarMembers,
} from "../components/avatar/BotAvatar.tsx";
import { useBotCardPress } from "../components/BotCard.tsx";
import { useI18n } from "../i18n.ts";
import { useBots, useRooms } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { inlineChip } from "./inlineChip.ts";
import { useTint } from "./tint.ts";

/** The side of a mention's face, in px: as small as an event line's, so it sits in a line of text. */
export const MENTION_FACE = 16;

const chip = "flex-row items-center gap-1 rounded-full ps-1 pe-2";

/**
 * A bot's mention where it stands in a message's text: its still face and
 * `@` and the name, on a tint of its color. It carries its own fill and text
 * color, which keep the name readable inside any bubble.
 */
function MentionChip({
  avatar,
  seed,
  name,
}: {
  readonly avatar: Avatar;
  readonly seed: BotId;
  readonly name: string;
}) {
  const { bubble } = useTint(avatar);
  const asleep = useContext(AvatarsAsleep);
  return (
    <View style={{ height: inlineChip.height, backgroundColor: bubble }} className={chip}>
      <BotAvatar
        avatar={avatar}
        seed={seed}
        state={asleep ? "offline" : "idle"}
        size={MENTION_FACE}
        still
      />
      <Text numberOfLines={1} className="shrink text-base font-semibold text-bubble-bot-foreground">
        @{name}
      </Text>
    </View>
  );
}

/**
 * A room's mention where it stands in a message's text: its mark, two of its
 * members, and `@` and its name, on a neutral fill, since a room has no color
 * of its own.
 */
function RoomMentionChip({
  members,
  name,
}: {
  readonly members: ReadonlyArray<{ readonly id: string; readonly avatar: Avatar }>;
  readonly name: string;
}) {
  return (
    <View style={{ height: inlineChip.height }} className={`${chip} bg-muted`}>
      <RoomAvatar members={members} size={MENTION_FACE} ground="muted" />
      <Text numberOfLines={1} className="shrink text-base font-semibold text-foreground">
        @{name}
      </Text>
    </View>
  );
}

/**
 * Opens what a mention in a message names: a bot's conversation, or a room.
 * Where it is null, as in a teammate conversation, a mention opens nothing.
 */
export const OpenMention = createContext<((named: ConversationMention) => void) | null>(null);

/**
 * A chip set in a line of text, centered on it, which opens what it names
 * (`name`, as the roster calls it now) when something can open it, and a
 * bot's card on a long press.
 */
function InlineMention({
  named,
  name,
  children,
}: {
  readonly named: ConversationMention;
  readonly name: string;
  readonly children: ReactNode;
}) {
  const open = useContext(OpenMention);
  const { t } = useI18n();
  // A bot's mention opens its card on a long press (decision 0102).
  const card = useBotCardPress(named._tag === "bot" ? named.botId : null, name);
  return (
    <View style={{ transform: inlineChip.transform }} className="mx-px">
      {open === null && card === null ? (
        children
      ) : (
        <PressScale
          accessibilityRole={open === null ? undefined : "button"}
          accessibilityLabel={open === null ? name : t("mention.open", { name })}
          {...(open === null ? {} : { onPress: () => open(named) })}
          {...card?.props}
        >
          {children}
        </PressScale>
      )}
    </View>
  );
}

/**
 * A mention in a message's text: a bot's or a room's as its chip, which opens
 * that bot's conversation or that room; or, for `@everyone` and one deleted
 * since, the name in the text's own color, set apart by weight.
 */
export function TextMention({
  name,
  of,
}: {
  readonly name: string;
  readonly of: ConversationMention | null;
}) {
  const bots = useBots();
  const rooms = useRooms();
  const plain = <Text className="font-semibold">@{name}</Text>;
  if (of === null) return plain;
  if (of._tag === "bot") {
    const bot = bots.get(of.botId);
    if (bot === undefined) return plain;
    return (
      <InlineMention named={of} name={bot.profile.name}>
        <MentionChip avatar={bot.profile.avatar} seed={bot.id} name={name} />
      </InlineMention>
    );
  }
  const room = rooms.get(of.roomId);
  if (room === undefined) return plain;
  return (
    <InlineMention named={of} name={room.name}>
      <RoomMentionChip members={roomAvatarMembers(room, bots)} name={name} />
    </InlineMention>
  );
}
