// SPDX-License-Identifier: AGPL-3.0-or-later
import { needsOperator } from "@j3-bots/client-runtime";
import { avatarAppearance } from "@j3-bots/client-runtime/presentation";
import { activityTime, type LineTone, rosterLine } from "@j3-bots/client-runtime/wording";
import type { RosterItem } from "@j3-bots/contracts";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { useI18n } from "../i18n.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { itemName } from "../screens/rosterItem.ts";
import { BotAvatar, RoomAvatar } from "./Avatar.tsx";
import { PressScale } from "../press.tsx";

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
 * and in the avatar's badge. Unread shows once: as a done bot's badge, or as
 * a dot under the time; screen readers hear "Unread" either way.
 */
export function RosterRow({
  item,
  selected,
  onOpen,
}: {
  readonly item: RosterItem;
  /** Its conversation is open beside the roster. */
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const bots = useBots();
  const line = rosterLine(item, ctx);
  const needs = needsOperator(item);
  const name = itemName(item);
  const time = item.lastActivityAt === null ? null : activityTime(item.lastActivityAt, ctx);
  const unreadDot =
    item.unread &&
    (item._tag === "room" || avatarAppearance(item.bot.state, item.unread).badge !== "unread");
  const ground = selected ? "muted" : "background";
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[name, time, line.text, item.unread ? t("roster.unread") : null]
        .filter((part) => part !== null)
        .join(", ")}
      onPress={onOpen}
      className={`mx-2 h-(--layout-row-touch) flex-row items-center gap-3 rounded-lg px-2 active:bg-muted ${selected ? "bg-muted" : ""}`}
    >
      {item._tag === "bot" ? (
        <BotAvatar
          avatar={item.bot.profile.avatar}
          state={item.bot.state}
          unread={item.unread}
          size={36}
          ground={ground}
        />
      ) : (
        <RoomAvatar
          size={36}
          ground={ground}
          members={item.room.members.flatMap((id) => {
            const bot = bots.get(id);
            return bot === undefined ? [] : [bot.profile.avatar];
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
          <Text numberOfLines={1} className={`flex-1 text-sm ${toneClass[line.tone]}`}>
            {line.text}
          </Text>
          {unreadDot && <View className="size-2 rounded-pill bg-accent" />}
        </View>
      </View>
    </PressScale>
  );
}
