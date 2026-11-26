// SPDX-License-Identifier: AGPL-3.0-or-later
import { needsOperator } from "@j3-bots/client-runtime";
import { activityTime, type LineTone, rosterLine } from "@j3-bots/client-runtime/wording";
import type { RosterItem } from "@j3-bots/contracts";
import { type ComponentRef, type Ref, useRef, useState } from "react";
import { View } from "react-native";
import { feelLongPress } from "../platform/haptics.ts";
import type { MenuAnchor } from "./Menu.tsx";
import { Text } from "../text.tsx";
import { SwapText } from "./SwapText.tsx";
import { useI18n } from "../i18n.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { itemName } from "../screens/rosterItem.ts";
import { PressScale } from "../press.tsx";
import { type AvatarHandle, RoomAvatar, roomAvatarMembers } from "./avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "./avatar/mood.tsx";

export const toneClass = {
  default: "text-muted-foreground",
  secondary: "text-muted-foreground",
  empty: "text-muted-foreground italic",
  waiting: "text-waiting",
  blocked: "text-blocked",
} as const satisfies Record<LineTone, string>;

/**
 * One bot or room: avatar, name, time, and one line of status, in a row
 * `height` tall (`RosterSizes`), 64 px at the default font size. Rows that need the operator carry it in the line's words and color
 * and in the avatar's light. Unread shows once: as an idle bot's dark light,
 * or as a dot under the time; screen readers hear "Unread" either way. The
 * primary bot's avatar carries its mark, which screen readers hear in the
 * row's name. A long press, with the system's long-press tick, opens what
 * `onMenu` shows, by the row.
 */
export function RosterRow({
  item,
  height,
  selected,
  avatarRef,
  entrance = false,
  onOpen,
  onMenu,
  lifted = false,
}: {
  readonly item: RosterItem;
  readonly height: number;
  /** Its conversation is open beside the roster. */
  readonly selected: boolean;
  /** A bot row's avatar, to make it move: a row that rises makes its bot hop. */
  readonly avatarRef?: Ref<AvatarHandle>;
  /** The bot or room is new to the roster: it comes down into its row. */
  readonly entrance?: boolean;
  /** Opens its conversation; a row drawn only to be seen, as over a menu, has none. */
  readonly onOpen?: () => void;
  /** Opens the row's menu, given where the row is on screen. */
  readonly onMenu?: (anchor: MenuAnchor) => void;
  /**
   * Drawn again over a menu's scrim, exactly where the row is: without the
   * list's inset, which the place it is drawn at already has.
   */
  readonly lifted?: boolean;
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
  const primary = item._tag === "bot" && item.bot.primary;
  const row = useRef<ComponentRef<typeof View>>(null);
  return (
    <PressScale
      ref={row}
      depth="row"
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={[
        name,
        primary ? t("roster.primary") : null,
        time,
        line.text,
        item.unread ? t("roster.unread") : null,
      ]
        .filter((part) => part !== null)
        .join(", ")}
      onPress={onOpen}
      {...(onMenu === undefined
        ? {}
        : {
            onLongPress: () => {
              feelLongPress();
              row.current?.measureInWindow((x, y, width, height) =>
                onMenu({ x, y, width, height }),
              );
            },
          })}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      className={`${lifted ? "" : "mx-2"} flex-row items-center gap-3 rounded-lg px-2 active:bg-muted ${selected ? "bg-muted" : ""}`}
      style={{ height }}
    >
      {item._tag === "bot" ? (
        <LiveBotAvatar
          bot={item.bot}
          unread={item.unread}
          lastEntry={item.lastEntry}
          size={40}
          ground={ground}
          markPrimary
          entrance={entrance}
          {...(avatarRef === undefined ? {} : { ref: avatarRef })}
        />
      ) : (
        <RoomAvatar
          size={40}
          ground={ground}
          members={roomAvatarMembers(item.room, bots)}
          entrance={entrance}
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
