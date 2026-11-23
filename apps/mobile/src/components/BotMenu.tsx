// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotItem } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { Section } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import {
  CheckCheck,
  ChevronLeft,
  CircleDot,
  Ellipsis,
  Eye,
  EyeOff,
  Folder,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Info,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react-native";
import { useState } from "react";
import { useConfirm } from "../confirm.tsx";
import { useBotActions } from "../details/actions.ts";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { useFolded } from "../screens/folded.ts";
import { useBotPlacing } from "../screens/placing.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "./Menu.tsx";
import { PinnedBot } from "./PinnedBots.tsx";
import { RosterRow } from "./RosterRow.tsx";

/**
 * A bot the operator long-pressed: its row, or its avatar in the pinned band,
 * and where that is on screen, which is drawn again over the scrim.
 */
export interface PressedBot {
  readonly item: BotItem;
  readonly from: "row" | "pinned";
  readonly anchor: MenuAnchor;
}

/** The menu's width when there is room for it: wide enough for its longest row on one line. */
const WIDTH = 264;

type Page = "main" | "sections" | "more";

/**
 * What the operator can do to a bot from the roster, opened by a long press
 * on its row or its pinned avatar: mark its conversation read or unread, pin
 * or unpin it, put it in a section, make it the primary bot, hide it, and
 * under More what its details offer (the details, its profile, a fresh start
 * and deleting it). A hidden bot, which a search finds, offers Unhide in
 * place of Pin and Hide. The system's Back on a page a row opened goes back
 * to the first page. Sections and Mark as unread are offered only by a server
 * that has them, which says so with its sections; Mark as read, only with
 * the preview's place to read through. `onLeave` hears of a row about to
 * leave the list by the operator's hand, before the server has it, so it can
 * go smoothly.
 */
export function BotMenu({
  pressed,
  onClose,
  onLeave,
}: {
  readonly pressed: PressedBot | null;
  readonly onClose: () => void;
  readonly onLeave: (bot: BotItem) => void;
}) {
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const placing = useBotPlacing();
  const actions = useBotActions();
  const confirm = useConfirm();
  const sections = useReadable(useJ3Client().sections);
  const folded = useFolded();
  const bots = useBots();
  const [page, setPage] = useState<Page>("main");
  // Each long press opens on the first page.
  const [shownFor, setShownFor] = useState(pressed);
  if (pressed !== shownFor) {
    setShownFor(pressed);
    setPage("main");
  }
  if (pressed === null) {
    return <Menu anchor={null} onClose={onClose} label="" entries={[]} />;
  }
  const { item } = pressed;
  const { bot } = item;
  const name = bot.profile.name;
  // A row moved into a folded section leaves the list; a pinned bot stays in its band.
  const moveTo = (section: Section | null) => {
    if (section !== null && folded.has(section.id) && pressed.from === "row") onLeave(item);
    placing.move(bot, section);
  };
  const order = item.lastEntry?.order ?? null;
  const reading: ReadonlyArray<MenuEntry> = item.unread
    ? order === null
      ? []
      : [
          {
            label: t("roster.markRead"),
            icon: CheckCheck,
            onPress: () => placing.markRead(item),
          },
        ]
    : sections === null || item.lastEntry === null
      ? []
      : [
          {
            label: t("roster.markUnread"),
            icon: CircleDot,
            onPress: () => placing.markUnread(bot),
          },
        ];
  const filing: ReadonlyArray<MenuEntry> =
    sections === null
      ? []
      : sections.length === 0
        ? [
            {
              label: t("roster.newSection"),
              icon: FolderPlus,
              onPress: () => placing.moveToNew(bot),
            },
          ]
        : [
            {
              label: t("roster.moveToSection"),
              icon: FolderInput,
              opens: "page",
              onPress: () => setPage("sections"),
            },
          ];
  // A hidden bot, which only a search lists, is pinned or hidden again by nothing but showing it.
  const placement: ReadonlyArray<MenuEntry> = bot.hidden
    ? []
    : [
        bot.pinned
          ? { label: t("roster.unpin"), icon: PinOff, onPress: () => placing.unpin(bot) }
          : {
              label: t("roster.pin"),
              icon: Pin,
              onPress: () => {
                onLeave(item);
                placing.pin(bot);
              },
            },
      ];
  const main: ReadonlyArray<MenuEntry> = [
    ...reading,
    ...placement,
    ...filing,
    ...(bot.primary
      ? []
      : [
          {
            // With a primary bot already, this one takes its place, and the row says so.
            label: [...bots.values()].some((each) => each.primary)
              ? t("roster.replacePrimary")
              : t("roster.makePrimary"),
            icon: Star,
            onPress: () => placing.makePrimary(bot),
          },
        ]),
    bot.hidden
      ? { label: t("roster.unhide"), icon: Eye, onPress: () => placing.unhide(bot) }
      : {
          label: t("roster.hide"),
          icon: EyeOff,
          onPress: () => {
            onLeave(item);
            placing.hide(bot);
          },
        },
    { label: t("roster.more"), icon: Ellipsis, opens: "page", onPress: () => setPage("more") },
  ];
  const back: MenuEntry = {
    label: t("roster.menu.back"),
    icon: ChevronLeft,
    opens: "back",
    onPress: () => setPage("main"),
  };
  const current = sections?.find((section) => section.id === bot.sectionId) ?? null;
  const filed: ReadonlyArray<MenuEntry> = [
    back,
    // Two sections may share a name, so each row is known by its section. The bot's own is
    // checked, and choosing it only closes the menu.
    ...(sections ?? []).map((section): MenuEntry => ({
      key: section.id,
      label: section.name,
      icon: Folder,
      ...(section.id === current?.id ? { checked: true } : {}),
      onPress: () => {
        if (section.id !== current?.id) moveTo(section);
      },
    })),
    { label: t("roster.newSection"), icon: FolderPlus, onPress: () => placing.moveToNew(bot) },
    ...(current === null
      ? []
      : [
          {
            label: t("roster.leaveSection", { section: current.name }),
            icon: FolderMinus,
            onPress: () => moveTo(null),
          },
        ]),
  ];
  const key = { _tag: "bot", botId: bot.id } as const;
  const more: ReadonlyArray<MenuEntry> = [
    back,
    {
      label: t("roster.openDetails"),
      icon: Info,
      onPress: () => navigation.navigate("details", { item: key }),
    },
    {
      label: t("details.editProfile", { name }),
      icon: Pencil,
      onPress: () => navigation.navigate("editBot", { botId: bot.id }),
    },
    {
      label: t("details.freshStart"),
      icon: RotateCcw,
      onPress: () =>
        confirm({
          title: t("details.freshStart.title", { name }),
          body: t("details.freshStart.body", { name }),
          cancel: t("details.freshStart.cancel"),
          confirm: t("details.freshStart"),
          onConfirm: () => actions.freshStart(bot),
        }),
    },
    {
      label: t("details.delete", { name }),
      icon: Trash2,
      tone: "destructive",
      onPress: () =>
        confirm({
          title: t("details.delete.title", { name }),
          body: t("details.delete.body", { name }),
          cancel: t("details.delete.cancel", { name }),
          confirm: t("details.delete", { name }),
          onConfirm: () => {
            onLeave(item);
            void actions.remove(bot);
          },
        }),
    },
  ];
  return (
    <Menu
      anchor={pressed.anchor}
      onClose={onClose}
      label={t("roster.menu", { name })}
      entries={page === "main" ? main : page === "sections" ? filed : more}
      page={page}
      {...(page === "main" ? {} : { onBack: () => setPage("main") })}
      edge="start"
      width={WIDTH}
      preview={
        pressed.from === "row" ? (
          <RosterRow item={item} height={pressed.anchor.height} selected lifted />
        ) : (
          <PinnedBot item={item} height={pressed.anchor.height} selected />
        )
      }
    />
  );
}
