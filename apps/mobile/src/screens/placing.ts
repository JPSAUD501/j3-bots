// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotPlacement, IntentResult, RoomChanges } from "@j3-bots/client-runtime";
import type { BotItem } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { type Bot, type Room, SECTION_NAME_LENGTH, type Section } from "@j3-bots/contracts";
import { useAskName, useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import { useBots } from "../presentation.tsx";
import { useSay } from "../toast.tsx";

/**
 * Where the operator puts a bot in the roster: pinned, hidden, shown again,
 * made the primary bot or moved between sections, and whether its
 * conversation reads as unread. Each changes nothing on screen until the
 * server has it, and says in a toast when it did not take.
 */
export function useBotPlacing() {
  const client = useJ3Client();
  const { t } = useI18n();
  const confirm = useConfirm();
  const askName = useAskName();
  const bots = useBots();
  const failing = useChangeFailed();
  const place = (bot: Bot, placement: BotPlacement) =>
    void client.placeBot(bot.id, placement).then(failing);
  return {
    pin: (bot: Bot) => place(bot, { pinned: true }),
    unpin: (bot: Bot) => place(bot, { pinned: false }),
    hide: (bot: Bot) => place(bot, { hidden: true }),
    unhide: (bot: Bot) => place(bot, { hidden: false }),
    /** Into the section, or out of the one it is in with null. */
    move: (bot: Bot, section: Section | null) => place(bot, { sectionId: section?.id ?? null }),
    /** Asks for the new section's name, then creates it with the bot in it. */
    moveToNew: (bot: Bot) =>
      askName({
        title: t("roster.section.new.title"),
        label: t("roster.section.name"),
        placeholder: t("roster.section.name.placeholder"),
        initial: "",
        maxLength: SECTION_NAME_LENGTH,
        cancel: t("roster.section.name.cancel"),
        confirm: t("roster.section.new.confirm"),
        onConfirm: (name) => void client.createSection(name, bot.id).then(failing),
      }),
    /** Through the latest entry the roster previews, as opening the conversation would. */
    markRead: (item: BotItem) => {
      const order = item.lastEntry?.order ?? null;
      if (order === null) return;
      void client.markRosterRead({ _tag: "conversation", botId: item.bot.id }, order).then(failing);
    },
    markUnread: (bot: Bot) =>
      void client.markUnread({ _tag: "conversation", botId: bot.id }).then(failing),
    /**
     * Makes `bot` the one primary bot; the server clears the one before in the
     * same step. Replacing another asks first, naming the bot that stops being
     * primary.
     */
    makePrimary: (bot: Bot) => {
      const previous = [...bots.values()].find((each) => each.primary && each.id !== bot.id);
      if (previous === undefined) {
        place(bot, { primary: true });
        return;
      }
      const name = bot.profile.name;
      const before = previous.profile.name;
      confirm({
        title: t("roster.replacePrimary.title", { name }),
        body: t("roster.replacePrimary.body", { name, previous: before }),
        cancel: t("roster.replacePrimary.cancel", { previous: before }),
        confirm: t("roster.replacePrimary.confirm", { name }),
        tone: "primary",
        onConfirm: () => place(bot, { primary: true }),
      });
    },
  };
}

/**
 * Where the operator puts a room in the roster: pinned at the top of the
 * list, hidden among the hidden conversations, or shown again. As with a
 * bot, nothing changes on screen until the server has it, and a toast says
 * when it did not take.
 */
export function useRoomPlacing() {
  const client = useJ3Client();
  const failing = useChangeFailed();
  const place = (room: Room, changes: RoomChanges) =>
    void client.updateRoom(room.id, changes).then(failing);
  return {
    pin: (room: Room) => place(room, { pinned: true }),
    unpin: (room: Room) => place(room, { pinned: false }),
    hide: (room: Room) => place(room, { hidden: true }),
    unhide: (room: Room) => place(room, { hidden: false }),
  };
}

/** What the operator does to a section itself: rename it, or delete it and keep its bots. */
export function useSectionActions() {
  const client = useJ3Client();
  const { t } = useI18n();
  const failing = useChangeFailed();
  const confirm = useConfirm();
  const askName = useAskName();
  return {
    rename: (section: Section) =>
      askName({
        title: t("roster.section.rename.title"),
        label: t("roster.section.name"),
        placeholder: t("roster.section.name.placeholder"),
        initial: section.name,
        maxLength: SECTION_NAME_LENGTH,
        cancel: t("roster.section.name.cancel"),
        confirm: t("roster.section.rename.confirm"),
        onConfirm: (name) => void client.updateSection(section.id, { name }).then(failing),
      }),
    /** Asks first, saying its bots stay; they go back to the main list. */
    remove: (section: Section) =>
      confirm({
        title: t("roster.section.delete.title", { section: section.name }),
        body: t("roster.section.delete.body"),
        cancel: t("roster.section.delete.cancel"),
        confirm: t("roster.section.delete"),
        onConfirm: () => void client.deleteSection(section.id).then(failing),
      }),
  };
}

/** Says in a toast that a roster change did not take; the roster still shows what the server has. */
function useChangeFailed(): (result: IntentResult<unknown>) => void {
  const { t } = useI18n();
  const say = useSay();
  return (result) => {
    if (result._tag === "failed") say(t("roster.changeFailed"));
  };
}
