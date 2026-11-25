// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotPlacement, RoomChanges, SectionChanges } from "@j3-bots/client-runtime";
import type {
  Bot,
  BotId,
  EntryOrder,
  EntryTarget,
  RoomId,
  RosterItem,
  RosterItemKey,
  Section,
  SectionId,
} from "@j3-bots/contracts";
import { rosterKeyOf, rosterTarget } from "@j3-bots/client-runtime/presentation";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  MessageSquareDotIcon,
  MessageSquareIcon,
  PanelRightIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm";
import {
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSubmenu,
  MenuTrigger,
} from "./ui/menu";

/** Where a room sits in the roster: pinned at the top, or among the hidden. Fields left out keep their value. */
export type RoomPlacement = Pick<RoomChanges, "pinned" | "hidden">;

/** What the roster's menus ask for. The shell carries each out and says when one did not take. */
export interface RosterIntents {
  readonly placeBot: (botId: BotId, placement: BotPlacement) => void;
  readonly placeRoom: (roomId: RoomId, placement: RoomPlacement) => void;
  /** Marks everything in the conversation or room read, through its latest entry. */
  readonly markRead: (target: EntryTarget, through: EntryOrder) => void;
  readonly markUnread: (target: EntryTarget) => void;
  /** Resolves with the new section's id, or null when it was not made. */
  readonly createSection: (name: string, botId: BotId | null) => Promise<SectionId | null>;
  readonly updateSection: (sectionId: SectionId, changes: SectionChanges) => void;
  readonly deleteSection: (sectionId: SectionId) => void;
  /** Opens the conversation or room with its details beside it. */
  readonly openDetails: (key: RosterItemKey) => void;
  /** Absent where there is no form to edit a bot. */
  readonly editProfile?: (botId: BotId) => void;
  readonly deleteBot: (botId: BotId) => void;
}

/** A question a menu row asks before it acts, shown once the menu has closed. */
export type RosterQuestion =
  | { readonly _tag: "replace-primary"; readonly bot: Bot }
  | { readonly _tag: "delete-bot"; readonly bot: Bot }
  | { readonly _tag: "delete-section"; readonly section: Section };

/** What every roster menu needs to know about the roster around it. */
export interface RosterMenuContext {
  readonly intents: RosterIntents;
  /** Null while the server has not said it has sections: no section rows, no Mark as unread. */
  readonly sections: ReadonlyArray<Section> | null;
  /** The bot that is primary now, if one is. */
  readonly primary: Bot | null;
  readonly ask: (question: RosterQuestion) => void;
  /** A section was just made from a menu: its name is ready to type. */
  readonly renameSection: (sectionId: SectionId) => void;
}

/** Mark as read, for what has something unread, or Mark as unread, for what has none. */
function ReadRow({ item, menu }: { item: RosterItem; menu: RosterMenuContext }) {
  const { t } = useI18n();
  const target = rosterTarget(rosterKeyOf(item));
  const through = item.lastEntry?.order ?? null;
  if (item.unread) {
    if (through === null) return null;
    return (
      <MenuItem icon={<MessageSquareIcon />} onClick={() => menu.intents.markRead(target, through)}>
        {t("roster.markRead")}
      </MenuItem>
    );
  }
  if (menu.sections === null || item.lastEntry === null) return null;
  return (
    <MenuItem icon={<MessageSquareDotIcon />} onClick={() => menu.intents.markUnread(target)}>
      {t("roster.markUnread")}
    </MenuItem>
  );
}

/** New section with this bot in it, or, once there are sections, the sections to move it to. */
function SectionRows({ bot, menu }: { bot: Bot; menu: RosterMenuContext }) {
  const { t } = useI18n();
  const { sections } = menu;
  if (sections === null) return null;
  const create = () =>
    void menu.intents.createSection(t("roster.newSection"), bot.id).then((id) => {
      if (id !== null) menu.renameSection(id);
    });
  if (sections.length === 0) {
    return (
      <MenuItem icon={<FolderPlusIcon />} onClick={create}>
        {t("roster.newSection")}
      </MenuItem>
    );
  }
  const current = sections.find((section) => section.id === bot.sectionId) ?? null;
  return (
    <MenuSubmenu icon={<FolderInputIcon />} label={t("roster.moveToSection")}>
      {sections.map((section) => (
        <MenuItem
          key={section.id}
          checked={section.id === bot.sectionId}
          onClick={() => {
            if (section.id !== bot.sectionId) {
              menu.intents.placeBot(bot.id, { sectionId: section.id });
            }
          }}
        >
          <span className="truncate">{section.name}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<FolderPlusIcon />} onClick={create}>
        {t("roster.newSection")}
      </MenuItem>
      {current !== null && (
        <MenuItem
          icon={<FolderMinusIcon />}
          onClick={() => menu.intents.placeBot(bot.id, { sectionId: null })}
        >
          {t("roster.leaveSection", { section: current.name })}
        </MenuItem>
      )}
    </MenuSubmenu>
  );
}

/** Everything the operator can do to a bot from the roster. */
function BotRows({
  item,
  menu,
}: {
  item: Extract<RosterItem, { readonly _tag: "bot" }>;
  menu: RosterMenuContext;
}) {
  const { t } = useI18n();
  const { bot } = item;
  const { intents, primary } = menu;
  const name = bot.profile.name;
  return (
    <>
      <ReadRow item={item} menu={menu} />
      {!bot.hidden &&
        (bot.pinned ? (
          <MenuItem
            icon={<PinOffIcon />}
            onClick={() => intents.placeBot(bot.id, { pinned: false })}
          >
            {t("roster.unpin")}
          </MenuItem>
        ) : (
          <MenuItem icon={<PinIcon />} onClick={() => intents.placeBot(bot.id, { pinned: true })}>
            {t("roster.pin")}
          </MenuItem>
        ))}
      <SectionRows bot={bot} menu={menu} />
      {!bot.primary &&
        (primary === null ? (
          <MenuItem icon={<StarIcon />} onClick={() => intents.placeBot(bot.id, { primary: true })}>
            {t("roster.makePrimary")}
          </MenuItem>
        ) : (
          <MenuItem icon={<StarIcon />} onClick={() => menu.ask({ _tag: "replace-primary", bot })}>
            {t("roster.replacePrimary")}
          </MenuItem>
        ))}
      {bot.hidden ? (
        <MenuItem icon={<EyeIcon />} onClick={() => intents.placeBot(bot.id, { hidden: false })}>
          {t("roster.unhide")}
        </MenuItem>
      ) : (
        <MenuItem icon={<EyeOffIcon />} onClick={() => intents.placeBot(bot.id, { hidden: true })}>
          {t("roster.hide")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuSubmenu icon={<EllipsisIcon />} label={t("roster.more")}>
        <MenuItem
          icon={<PanelRightIcon />}
          onClick={() => intents.openDetails({ _tag: "bot", botId: bot.id })}
        >
          {t("roster.openDetails")}
        </MenuItem>
        {intents.editProfile !== undefined && (
          <MenuItem icon={<PencilIcon />} onClick={() => intents.editProfile?.(bot.id)}>
            {t("details.editProfile", { name })}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Trash2Icon />}
          destructive
          onClick={() => menu.ask({ _tag: "delete-bot", bot })}
        >
          {t("details.delete", { name })}
        </MenuItem>
      </MenuSubmenu>
    </>
  );
}

/**
 * A room keeps its own pin, is read or unread like a conversation, and hides
 * as a bot does: a hidden room's pin waits until it is shown again.
 */
function RoomRows({
  item,
  menu,
}: {
  item: Extract<RosterItem, { readonly _tag: "room" }>;
  menu: RosterMenuContext;
}) {
  const { t } = useI18n();
  const { room } = item;
  const place = (placement: RoomPlacement) => menu.intents.placeRoom(room.id, placement);
  return (
    <>
      <ReadRow item={item} menu={menu} />
      {!room.hidden && (
        <MenuItem
          icon={room.pinned ? <PinOffIcon /> : <PinIcon />}
          onClick={() => place({ pinned: !room.pinned })}
        >
          {room.pinned ? t("roster.unpin") : t("roster.pin")}
        </MenuItem>
      )}
      {room.hidden ? (
        <MenuItem icon={<EyeIcon />} onClick={() => place({ hidden: false })}>
          {t("roster.unhide")}
        </MenuItem>
      ) : (
        <MenuItem icon={<EyeOffIcon />} onClick={() => place({ hidden: true })}>
          {t("roster.hide")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<PanelRightIcon />}
        onClick={() => menu.intents.openDetails({ _tag: "room", roomId: room.id })}
      >
        {t("roster.openDetails")}
      </MenuItem>
    </>
  );
}

/** A roster item's menu rows. */
export function RosterItemRows({ item, menu }: { item: RosterItem; menu: RosterMenuContext }) {
  return item._tag === "bot" ? (
    <BotRows item={item} menu={menu} />
  ) : (
    <RoomRows item={item} menu={menu} />
  );
}

/**
 * One thing in the roster with its menu: right-click or a long press on
 * `children`, the row or tile, opens it where the pointer is, and a "…"
 * button over its end, shown while it is hovered or holds focus, opens it
 * beside itself. The wrapper is the `group/entry` the row reads.
 */
export function WithMenu({
  rows,
  label,
  className,
  buttonClassName,
  children,
}: {
  /** The menu's rows: both popups draw them, and only while open. */
  rows: ReactNode;
  /** The "…" button's accessible name. */
  label: string;
  className: string;
  /** Where the "…" button sits over the row or tile. */
  buttonClassName: string;
  /** A link or button, which becomes what the context menu opens on. */
  children: ReactElement;
}) {
  return (
    <div className={cn("group/entry relative", className)}>
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuPopup>{rows}</ContextMenuPopup>
      </ContextMenu>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={label}
              className={cn(
                "absolute opacity-0 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 data-popup-open:opacity-100 pointer-coarse:hidden",
                buttonClassName,
              )}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup side="bottom" align="end">
          {rows}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** A section header's rows: rename it, move it among the others, delete it. */
export function SectionRowsOf({
  section,
  index,
  sections,
  menu,
  onRename,
}: {
  section: Section;
  index: number;
  sections: ReadonlyArray<Section>;
  menu: RosterMenuContext;
  onRename: () => void;
}) {
  const { t } = useI18n();
  const above = sections[index - 1];
  const below = sections[index + 1];
  return (
    <>
      <MenuItem icon={<PencilIcon />} onClick={onRename}>
        {t("roster.section.rename")}
      </MenuItem>
      {above !== undefined && (
        <MenuItem
          icon={<ArrowUpIcon />}
          onClick={() => menu.intents.updateSection(section.id, { before: above.id })}
        >
          {t("roster.section.moveUp")}
        </MenuItem>
      )}
      {below !== undefined && (
        <MenuItem
          icon={<ArrowDownIcon />}
          onClick={() =>
            menu.intents.updateSection(section.id, { before: sections[index + 2]?.id ?? null })
          }
        >
          {t("roster.section.moveDown")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<Trash2Icon />}
        destructive
        onClick={() => menu.ask({ _tag: "delete-section", section })}
      >
        {t("roster.section.delete")}
      </MenuItem>
    </>
  );
}

/** The question a menu row asked, until the operator answers it. */
export function RosterQuestionDialog({
  question,
  onClose,
  intents,
  primary,
}: {
  question: RosterQuestion | null;
  onClose: () => void;
  intents: RosterIntents;
  /** The primary bot as the roster has it now, which the question names. */
  primary: Bot | null;
}) {
  const { t } = useI18n();
  const open = question !== null;
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };
  if (question === null) return null;
  switch (question._tag) {
    case "replace-primary": {
      // Named as it is when the question shows, not when the menu opened.
      if (primary === null || primary.id === question.bot.id) return null;
      const name = question.bot.profile.name;
      const previous = primary.profile.name;
      return (
        <ConfirmDialog
          open={open}
          onOpenChange={onOpenChange}
          tone="primary"
          title={t("roster.replacePrimary.title", { name })}
          body={t("roster.replacePrimary.body", { name, previous })}
          cancel={t("roster.replacePrimary.cancel", { previous })}
          confirm={t("roster.replacePrimary.confirm", { name })}
          onConfirm={() => intents.placeBot(question.bot.id, { primary: true })}
        />
      );
    }
    case "delete-bot": {
      const name = question.bot.profile.name;
      return (
        <ConfirmDialog
          open={open}
          onOpenChange={onOpenChange}
          title={t("details.delete.title", { name })}
          body={t("details.delete.body", { name })}
          cancel={t("details.delete.cancel", { name })}
          confirm={t("details.delete", { name })}
          onConfirm={() => intents.deleteBot(question.bot.id)}
        />
      );
    }
    case "delete-section": {
      const section = question.section.name;
      return (
        <ConfirmDialog
          open={open}
          onOpenChange={onOpenChange}
          title={t("roster.section.delete.title", { section })}
          body={t("roster.section.delete.body")}
          cancel={t("roster.section.delete.cancel")}
          confirm={t("roster.section.delete")}
          onConfirm={() => intents.deleteSection(question.section.id)}
        />
      );
    }
  }
}
