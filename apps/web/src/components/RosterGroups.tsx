// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import {
  type BotId,
  type RosterItem,
  type RosterItemKey,
  type Section,
  type SectionId,
  SECTION_NAME_LENGTH,
} from "@j3-bots/contracts";
import { type BotItem, rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, EyeOffIcon } from "lucide-react";
import { type ComponentProps, type ReactElement, type ReactNode, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { DataAttributes } from "../lib/dataAttributes";
import { LiveBotAvatar } from "./avatar/mood";
import { PrimaryBadge } from "./avatar/PrimaryBadge";
import { type RosterMenuContext, RosterItemRows, SectionRowsOf, WithMenu } from "./RosterMenu";
import { RosterRow } from "./RosterRow";
import { Button } from "./ui/button";

const isSelected = (item: BotItem, selected: RosterItemKey | null) =>
  selected?._tag === "bot" && selected.botId === item.bot.id;

const FOLDED_KEY = "j3:roster:folded";
const Folded = Schema.fromJsonString(Schema.Array(Schema.String));

/** Which sections are folded, and the way to fold or unfold one. */
export interface FoldedSections {
  readonly has: (sectionId: SectionId) => boolean;
  readonly set: (sectionId: SectionId, fold: boolean) => void;
}

/**
 * The sections the operator has folded, remembered in this browser: folding
 * is how one screen shows the roster, not part of the roster itself. What it
 * remembers is only ever the sections that still exist.
 */
export function useFoldedSections(sections: ReadonlyArray<Section> | null): FoldedSections {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(FOLDED_KEY);
    } catch {
      // Storage can be unavailable (private windows, blocked site data): every section starts open.
    }
    return new Set(
      Option.getOrElse(Schema.decodeUnknownOption(Folded)(raw), (): ReadonlyArray<string> => []),
    );
  });
  return {
    has: (id) => folded.has(id),
    set: (id, fold) => {
      const existing = new Set<string>((sections ?? []).map((section) => section.id));
      const next = new Set([...folded].filter((known) => existing.has(known)));
      if (fold) next.add(id);
      else next.delete(id);
      setFolded(next);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
      } catch {
        // The fold still applies to this page; it is just not remembered.
      }
    },
  };
}

interface PinnedTileProps extends useRender.ComponentProps<"button"> {
  readonly item: BotItem;
  readonly selected: boolean;
}

/** A pinned bot: its avatar large, its name under it, and a dot while something is unread. */
function PinnedTile({ item, selected, render, ...props }: PinnedTileProps) {
  const { t } = useI18n();
  const { bot } = item;
  const own: ComponentProps<"button"> & DataAttributes = {
    className:
      "group/row pressable flex w-full flex-col items-center gap-1.5 rounded-lg px-1 pt-2.5 pb-2 hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent data-selected:bg-muted",
    type: render ? undefined : "button",
    "data-selected": selected ? "" : undefined,
    "aria-current": selected ? "page" : undefined,
    "data-roster-row": rosterKeyText(rosterKeyOf(item)),
    children: (
      <>
        <span className="[--avatar-cutout:var(--sidebar)] group-hover/row:[--avatar-cutout:var(--row-hover)] group-data-selected/row:[--avatar-cutout:var(--muted)]">
          <PrimaryBadge primary={bot.primary} size={52}>
            <LiveBotAvatar bot={bot} unread={item.unread} lastEntry={item.lastEntry} size={52} />
          </PrimaryBadge>
        </span>
        <span className="flex max-w-full items-center gap-1">
          <span className={cn("truncate text-xs", item.unread ? "font-semibold" : "font-medium")}>
            {bot.profile.name}
          </span>
          {item.unread && (
            <span className="size-1.5 shrink-0 rounded-pill bg-accent">
              <span className="sr-only">{t("roster.unread")}</span>
            </span>
          )}
        </span>
      </>
    ),
  };
  return useRender({ defaultTagName: "button", render, props: mergeProps<"button">(own, props) });
}

/** The pinned bots, above everything else, as a grid of large avatars. */
export function PinnedBots({
  items,
  selected,
  rowLink,
  menu,
}: {
  items: ReadonlyArray<BotItem>;
  selected: RosterItemKey | null;
  rowLink: (item: RosterItem) => ReactElement;
  menu: RosterMenuContext;
}) {
  const { t } = useI18n();
  return (
    <section aria-label={t("roster.pinned")} className="grid grid-cols-4 gap-1 pb-2">
      {items.map((item) => (
        <WithMenu
          key={item.bot.id}
          rows={<RosterItemRows item={item} menu={menu} />}
          label={t("roster.menu", { name: item.bot.profile.name })}
          className="min-w-0"
          buttonClassName="top-0.5 right-0.5"
        >
          <PinnedTile item={item} selected={isSelected(item, selected)} render={rowLink(item)} />
        </WithMenu>
      ))}
    </section>
  );
}

/** A section's name, being typed: Enter or leaving the field keeps it, Escape does not. */
function SectionNameField({
  name,
  onDone,
}: {
  name: string;
  /** The name typed, or null to leave the section as it was. */
  onDone: (name: string | null) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(name);
  const done = () => {
    const trimmed = value.trim();
    onDone(trimmed === "" ? null : trimmed);
  };
  return (
    <input
      // The field appears because the operator asked to name the section: it takes focus.
      autoFocus
      value={value}
      maxLength={SECTION_NAME_LENGTH}
      aria-label={t("roster.section.name")}
      onChange={(event) => setValue(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={done}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          done();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDone(null);
        }
      }}
      className="h-8 w-full rounded-md bg-muted px-2.5 text-xs font-semibold text-foreground outline-2 outline-accent"
    />
  );
}

/**
 * A named group of bots: its header folds and unfolds it, and carries its
 * menu. An empty section says so, so it stays a place a bot can be moved to.
 */
export function SectionBlock({
  section,
  index,
  sections,
  unread,
  folded,
  onFold,
  renaming,
  onStartRename,
  onRename,
  menu,
  children,
}: {
  section: Section;
  index: number;
  sections: ReadonlyArray<Section>;
  /** Whether a bot in it has something unread: a folded section still says so. */
  unread: boolean;
  folded: boolean;
  onFold: (fold: boolean) => void;
  renaming: boolean;
  onStartRename: () => void;
  onRename: (name: string | null) => void;
  menu: RosterMenuContext;
  /** Its rows, or nothing when it has no bot. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const Chevron = folded ? ChevronRightIcon : ChevronDownIcon;
  const bodyId = `roster-section-${section.id}`;
  return (
    <section aria-label={section.name} className="mt-2">
      {renaming ? (
        <SectionNameField name={section.name} onDone={onRename} />
      ) : (
        <WithMenu
          rows={
            <SectionRowsOf
              section={section}
              index={index}
              sections={sections}
              menu={menu}
              onRename={onStartRename}
            />
          }
          label={t("roster.section.menu", { section: section.name })}
          className=""
          buttonClassName="top-0 right-0"
        >
          <button
            type="button"
            aria-expanded={!folded}
            aria-controls={bodyId}
            onClick={() => onFold(!folded)}
            className="pressable flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md ps-2.5 pe-10 text-start text-xs font-semibold text-muted-foreground hover:bg-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Chevron aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{section.name}</span>
            {folded && unread && (
              <span className="size-1.5 shrink-0 rounded-pill bg-accent">
                <span className="sr-only">{t("roster.unread")}</span>
              </span>
            )}
          </button>
        </WithMenu>
      )}
      {!folded && (
        <div id={bodyId}>
          {children ?? (
            <p className="px-2.5 py-2 ps-7 text-xs text-muted-foreground italic">
              {t("roster.section.empty")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** The last row of the roster: how many bots are hidden, and the way to them. */
export function HiddenRow({
  items,
  onOpen,
}: {
  items: ReadonlyArray<BotItem>;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const unread = items.some((item) => item.unread);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pressable mt-2 flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-start text-sm text-muted-foreground hover:bg-row-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent pointer-coarse:h-(--layout-touch-target)"
    >
      <EyeOffIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("roster.hidden")}</span>
      {unread && (
        <span className="size-2 shrink-0 rounded-pill bg-accent">
          <span className="sr-only">{t("roster.unread")}</span>
        </span>
      )}
      <span className="tabular-nums">{items.length}</span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0" />
    </button>
  );
}

/** The hidden bots, each still a way into its conversation, and each with Unhide. */
export function HiddenBots({
  items,
  selected,
  rowLink,
  onBack,
  onUnhide,
}: {
  items: ReadonlyArray<BotItem>;
  selected: RosterItemKey | null;
  rowLink: (item: RosterItem) => ReactElement;
  onBack: () => void;
  onUnhide: (botId: BotId) => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="roster-hidden-title" className="appear">
      <div className="flex items-center gap-1 pb-1">
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={t("roster.hidden.back")}
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <h2 id="roster-hidden-title" className="text-sm font-semibold">
          {t("roster.hidden")}
        </h2>
      </div>
      {items.length === 0 ? (
        <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
          {t("roster.hidden.empty")}
        </p>
      ) : (
        items.map((item) => (
          <div key={item.bot.id} className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <RosterRow item={item} selected={isSelected(item, selected)} render={rowLink(item)} />
            </div>
            <Button variant="secondary" size="sm" onClick={() => onUnhide(item.bot.id)}>
              {t("roster.unhide")}
            </Button>
          </div>
        ))
      )}
    </section>
  );
}
