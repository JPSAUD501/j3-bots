// SPDX-License-Identifier: AGPL-3.0-or-later
import { needsOperator } from "@j3-bots/client-runtime";
import { activityTime, type LineTone, rosterLine } from "@j3-bots/client-runtime/wording";
import type { RosterItem } from "@j3-bots/contracts";
import { type Ref, useState } from "react";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { SwapText } from "./SwapText.tsx";
import { useI18n } from "../i18n.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { itemName } from "../screens/rosterItem.ts";
import { PressScale } from "../press.tsx";
import { type AvatarHandle, RoomAvatar } from "./avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "./avatar/mood.tsx";

export const toneClass = {
  default: "text-muted-foreground",
  secondary: "text-muted-foreground",
  empty: "text-muted-foreground italic",
  waiting: "text-waiting",
  blocked: "text-blocked",
} as const satisfies Record<LineTone, string>;

/**
 * One bot or room: avatar, name, time, and one line of status, in a 64 px
 * row. Rows that need the operator carry it in the line's words and color
 * and in the avatar's light. Unread shows once: as an idle bot's dark light,
 * or as a dot under the time; screen readers hear "Unread" either way.
 */
export function RosterRow({
  item,
  selected,
  avatarRef,
  onOpen,
}: {
  readonly item: RosterItem;
  /** Its conversation is open beside the roster. */
  readonly selected: boolean;
  /** A bot row's avatar, to make it move: a row that rises makes its bot hop. */
  readonly avatarRef?: Ref<AvatarHandle>;
  readonly onOpen: () => void;
}) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const bots = useBots();
  const line = rosterLine(item, ctx);
  const needs = needsOperator(item);
  const name = itemName(item);
  const time = item.lastActivityAt === null ? null : activityTime(item.lastActivityAt, ctx);
  const unreadDot = item.unread && (item._tag === "room" || item.bot.state._tag !== "idle");
  // The row turns muted while pressed or selected: the avatar's light keeps its ring in that color.
  const [pressed, setPressed] = useState(false);
  const ground = selected || pressed ? "muted" : "background";
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[name, time, line.text, item.unread ? t("roster.unread") : null]
        .filter((part) => part !== null)
        .join(", ")}
      onPress={onOpen}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      className={`mx-2 h-(--layout-row-touch) flex-row items-center gap-3 rounded-lg px-2 active:bg-muted ${selected ? "bg-muted" : ""}`}
    >
      {item._tag === "bot" ? (
        <LiveBotAvatar
          bot={item.bot}
          unread={item.unread}
          lastEntry={item.lastEntry}
          size={40}
          ground={ground}
          {...(avatarRef === undefined ? {} : { ref: avatarRef })}
        />
      ) : (
        <RoomAvatar
          size={40}
          ground={ground}
          members={item.room.members.flatMap((id) => {
            const bot = bots.get(id);
            return bot === undefined ? [] : [{ id, avatar: bot.profile.avatar }];
          })}
        />
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text
            numberOfLines={1}
            className={`flex-1 text-base text-foreground ${needs ? "font-semibold" : "font-medium"}`}
          >
            {name}
          </Text>
          {time !== null && <Text className="text-2xs text-muted-foreground">{time}</Text>}
        </View>
        <View className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1">
            <SwapText text={line.text} className={`text-sm ${toneClass[line.tone]}`} />
          </View>
          {unreadDot && <View className="size-2 rounded-pill bg-accent" />}
        </View>
      </View>
    </PressScale>
  );
}
