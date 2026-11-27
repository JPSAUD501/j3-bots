// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItem } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import { Info, ListPlus, Pin, PinOff, Theater } from "lucide-react-native";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { useRoomPlacing } from "../screens/placing.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "./Menu.tsx";
import { RosterRow } from "./RosterRow.tsx";

type RoomItem = Extract<RosterItem, { readonly _tag: "room" }>;

/** A room whose row the operator long-pressed, and where that row is on screen. */
export interface PressedRoom {
  readonly item: RoomItem;
  readonly anchor: MenuAnchor;
}

/**
 * What the operator can do to a room from the roster, opened by a long press
 * on its row: pin or unpin it at the top of the list, move it behind the
 * scenes, and open its details. A room behind the scenes, which a search
 * finds, offers Bring back to the list in place of Pin and Move behind the
 * scenes, as a bot there does.
 * `onLeave` hears of a row about to leave the list by the operator's hand,
 * before the server has it, so it can go smoothly.
 */
export function RoomMenu({
  pressed,
  onClose,
  onLeave,
}: {
  readonly pressed: PressedRoom | null;
  readonly onClose: () => void;
  readonly onLeave: (room: RoomItem) => void;
}) {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const placing = useRoomPlacing();
  if (pressed === null) {
    return <Menu anchor={null} onClose={onClose} label="" entries={[]} />;
  }
  const { item } = pressed;
  const { room } = item;
  const entries: ReadonlyArray<MenuEntry> = room.hidden
    ? [{ label: t("backstage.bringBack"), icon: ListPlus, onPress: () => placing.bringBack(room) }]
    : [
        room.pinned
          ? { label: t("roster.unpin"), icon: PinOff, onPress: () => placing.unpin(room) }
          : { label: t("roster.pin"), icon: Pin, onPress: () => placing.pin(room) },
        {
          label: t("backstage.move"),
          icon: Theater,
          onPress: () => {
            onLeave(item);
            placing.moveBackstage(room);
          },
        },
      ];
  return (
    <Menu
      anchor={pressed.anchor}
      onClose={onClose}
      label={t("roster.menu", { name: room.name })}
      entries={[
        ...entries,
        {
          label: t("roster.openDetails"),
          icon: Info,
          onPress: () =>
            navigation.navigate("details", { item: { _tag: "room", roomId: room.id } }),
        },
      ]}
      edge="start"
      preview={<RosterRow item={item} height={pressed.anchor.height} selected lifted />}
    />
  );
}
