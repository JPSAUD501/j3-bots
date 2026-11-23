// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import { ROOM_MEMBERS, roomStopFailed } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { Bot, Room } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { useSay } from "../toast.tsx";

/**
 * Leaves for the roster once what the screen showed is deleted, unless the
 * operator moved on meanwhile.
 */
const useLeaveDeleted = () => {
  const navigation = useNavigation<Navigation>();
  return () => {
    if (navigation.isFocused()) navigation.popTo("roster", { item: undefined });
  };
};

/** What the details do to a bot. Each says in a toast what did not happen. */
export function useBotActions() {
  const client = useJ3Client();
  const { t } = useI18n();
  const say = useSay();
  const leaveDeleted = useLeaveDeleted();
  return {
    /** Stops the bot's work under way at once. */
    stop: (bot: Bot) => void client.stopBot(bot.id),
    freshStart: (bot: Bot) =>
      void client
        .freshStart(bot.id)
        .then((result) =>
          say(
            result._tag === "done"
              ? t("details.freshStart.done", { name: bot.profile.name })
              : t("details.freshStart.failed"),
          ),
        ),
    /** Resolves once the server answered, whatever it said. */
    remove: (bot: Bot): Promise<void> =>
      client.deleteBot(bot.id, false).then((result) => {
        if (result._tag === "done") leaveDeleted();
        else say(t("details.deleteFailed"));
      }),
  };
}

/** What the details and an archived room's conversation do to a room. */
export function useRoomActions() {
  const client = useJ3Client();
  const { t } = useI18n();
  const say = useSay();
  const navigation = useNavigation<Navigation>();
  const leaveDeleted = useLeaveDeleted();
  /** Opens the form that gives the room the members and the host it needs. */
  const askForMembers = (room: Room) =>
    navigation.navigate("roomForm", { form: { _tag: "unarchive", roomId: room.id } });
  return {
    /** Stops the work addressed to the room, once the operator confirmed it. */
    stop: (room: Room) =>
      void client.stopRoom(room.id).then((result) => {
        if (roomStopFailed(result)) say(t("room.stopFailed", { name: room.name }));
      }),
    /** Resolves once the server answered, whatever it said. */
    archive: (room: Room): Promise<void> =>
      client.updateRoom(room.id, { archived: true }).then((result) => {
        if (result._tag === "failed") say(t("room.archiveFailed", { name: room.name }));
      }),
    /**
     * Unarchives the room, or opens the form first when it lacks the members
     * or the host it needs, as a room left too small by deleted bots does.
     * Resolves like `archive`.
     */
    unarchive: (room: Room): Promise<void> => {
      if (room.members.length < ROOM_MEMBERS.min || room.hostId === null) {
        askForMembers(room);
        return Promise.resolve();
      }
      return client.updateRoom(room.id, { archived: false }).then((result) => {
        if (result._tag === "done") return;
        if (refusedWith(result, "room-members")) askForMembers(room);
        else say(t("room.unarchiveFailed", { name: room.name }));
      });
    },
    /** Resolves like `archive`. */
    remove: (room: Room): Promise<void> =>
      client.deleteRoom(room.id).then((result) => {
        if (result._tag === "done") leaveDeleted();
        else say(t("room.deleteFailed", { name: room.name }));
      }),
  };
}
