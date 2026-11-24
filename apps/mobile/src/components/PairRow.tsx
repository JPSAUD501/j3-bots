// SPDX-License-Identifier: AGPL-3.0-or-later
import { activityTime, pairLine, pairOrder, pairTitle } from "@j3-bots/client-runtime/wording";
import type { TeammatePair } from "@j3-bots/contracts";
import { type ComponentRef, useRef, useState } from "react";
import { View } from "react-native";
import { feelLongPress } from "../platform/haptics.ts";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { RoomAvatar } from "./avatar/BotAvatar.tsx";
import type { MenuAnchor } from "./Menu.tsx";

/**
 * A teammate conversation in the roster, laid out as a room's row: the two
 * bots' faces overlapping, their names, the time of the latest message and
 * that message after who wrote it ("Wren: …"). It is never unread: the two
 * bots wrote it to each other, not to the operator. A press opens it; a long
 * press, with the system's long-press tick, opens what `onMenu` shows.
 */
export function PairRow({
  pair,
  height,
  onOpen,
  onMenu,
}: {
  readonly pair: TeammatePair;
  /** As the list counts it (`RosterSizes`). */
  readonly height: number;
  readonly onOpen: () => void;
  readonly onMenu: (anchor: MenuAnchor) => void;
}) {
  const ctx = usePresentation();
  const bots = useBots();
  const title = pairTitle(pair.botIds, ctx);
  const line = pairLine(pair, ctx);
  const time = activityTime(pair.lastMessage.createdAt, ctx);
  const members = pairOrder(pair.botIds, ctx).flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [{ id, avatar: bot.profile.avatar }];
  });
  // The row turns muted while pressed: the faces' cutout keeps that color.
  const [pressed, setPressed] = useState(false);
  const row = useRef<ComponentRef<typeof View>>(null);
  return (
    <PressScale
      ref={row}
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={[title, time, line].join(", ")}
      onPress={onOpen}
      onLongPress={() => {
        feelLongPress();
        row.current?.measureInWindow((x, y, width, height) => onMenu({ x, y, width, height }));
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      className="mx-2 flex-row items-center gap-3 rounded-lg px-2 active:bg-muted"
      style={{ height }}
    >
      <RoomAvatar size={40} ground={pressed ? "muted" : "background"} members={members} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="flex-1 text-base font-medium text-foreground">
            {title}
          </Text>
          <Text className="text-2xs text-muted-foreground">{time}</Text>
        </View>
        <Text numberOfLines={1} className="text-sm text-muted-foreground">
          {line}
        </Text>
      </View>
    </PressScale>
  );
}
