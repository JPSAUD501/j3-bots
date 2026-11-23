// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItem, RosterItemKey, Section, SectionId } from "@j3-bots/contracts";
import { BotIcon, PlusIcon, SearchIcon, SearchXIcon, UsersIcon, XIcon } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
} from "react";
import {
  arrangeRoster,
  type BotItem,
  filterRoster,
  orderRoster,
  ROOM_MEMBERS,
  rosterKeyOf,
  rosterKeyText,
} from "@j3-bots/client-runtime/presentation";
import { useBots, useI18n } from "../app/context";
import type { AvatarHandle } from "./avatar/BotAvatar";
import { ReorderList, ReorderRow } from "./ReorderList";
import {
  type FoldedSections,
  HiddenBots,
  HiddenRow,
  PinnedBots,
  SectionBlock,
} from "./RosterGroups";
import {
  RosterItemRows,
  type RosterIntents,
  type RosterMenuContext,
  type RosterQuestion,
  RosterQuestionDialog,
  WithMenu,
} from "./RosterMenu";
import { RosterRow } from "./RosterRow";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

const sameKey = (item: RosterItem, key: RosterItemKey | null) =>
  key !== null &&
  (item._tag === "bot"
    ? key._tag === "bot" && key.botId === item.bot.id
    : key._tag === "room" && key.roomId === item.room.id);

/** The bot rows' avatars, by row key, so a row that rises can make its bot hop. */
class RowAvatars {
  private readonly handles = new Map<string, AvatarHandle>();
  private readonly refs = new Map<string, RefCallback<AvatarHandle>>();

  /** The row's avatar ref, the same from render to render, so React keeps it attached. */
  ref(key: string): RefCallback<AvatarHandle> {
    const known = this.refs.get(key);
    if (known !== undefined) return known;
    const ref: RefCallback<AvatarHandle> = (handle) => {
      if (handle === null) return;
      this.handles.set(key, handle);
      return () => {
        if (this.handles.get(key) === handle) this.handles.delete(key);
      };
    };
    this.refs.set(key, ref);
    return ref;
  }

  hop(key: string): void {
    this.handles.get(key)?.poke("hop");
  }
}

/**
 * Arrow keys move from the search field into the rows and between them; Home
 * and End jump to the ends of the list. Up from the first row returns to search.
 * Only unmodified keys: `Alt+↑` and `Alt+↓` belong to the shell, which moves
 * between conversations with them.
 */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-roster-row]")];
  const search = event.currentTarget.querySelector<HTMLElement>("[data-roster-search]");
  const inSearch = search !== null && document.activeElement === search;
  const index = inSearch ? -1 : rows.findIndex((row) => row === document.activeElement);
  if (!inSearch && index === -1) return;
  const next =
    event.key === "ArrowDown"
      ? rows[index + 1]
      : event.key === "ArrowUp"
        ? index === 0
          ? search
          : rows[index - 1]
        : // In the search field, Home and End move the caret.
          inSearch
          ? undefined
          : event.key === "Home"
            ? rows[0]
            : event.key === "End"
              ? rows.at(-1)
              : undefined;
  if (next === undefined || next === null) return;
  event.preventDefault();
  next.focus();
}

interface RosterProps {
  readonly items: ReadonlyArray<RosterItem>;
  /** Null while the server has not said it has sections. */
  readonly sections: ReadonlyArray<Section> | null;
  readonly selected: RosterItemKey | null;
  /** The link a row navigates with, such as a router link to its conversation. */
  readonly rowLink: (item: RosterItem) => ReactElement;
  readonly onNewBot: () => void;
  readonly onNewRoom: () => void;
  readonly intents: RosterIntents;
  /** The sections folded on this device: the shell's, since its keys skip what they hide. */
  readonly folded: FoldedSections;
  readonly footer?: ReactNode;
  /**
   * The roster's landmark. It takes focus only from code, where neither a row
   * nor the search should: see `Shell`.
   */
  readonly ref?: Ref<HTMLElement>;
}

/**
 * Answers: who do I have, who needs me, what is each of them doing. Without
 * a search it draws the pinned bots apart, then the rooms and the bots in no
 * section, then each section, then a row that opens the hidden bots; a
 * search lists every match, hidden bots included, as one list.
 */
export function Roster({
  items,
  sections,
  selected,
  rowLink,
  onNewBot,
  onNewRoom,
  intents,
  folded,
  footer,
  ref,
}: RosterProps) {
  const { t } = useI18n();
  const bots = useBots();
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [question, setQuestion] = useState<RosterQuestion | null>(null);
  const [renaming, setRenaming] = useState<SectionId | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [avatars] = useState(() => new RowAvatars());

  const searching = query.trim() !== "";
  const ordered = orderRoster(items);
  const arranged = arrangeRoster(ordered, sections ?? []);
  const menu: RosterMenuContext = {
    intents,
    sections,
    primary:
      items.find((item): item is BotItem => item._tag === "bot" && item.bot.primary)?.bot ?? null,
    ask: setQuestion,
    renameSection: setRenaming,
  };

  const row = (item: RosterItem) => {
    const key = rosterKeyText(rosterKeyOf(item));
    const name = item._tag === "bot" ? item.bot.profile.name : item.room.name;
    return (
      <ReorderRow key={key} rowKey={key}>
        <WithMenu
          rows={<RosterItemRows item={item} menu={menu} />}
          label={t("roster.menu", { name })}
          className=""
          buttonClassName="top-1/2 right-2 -translate-y-1/2"
        >
          <RosterRow
            item={item}
            withMenu
            avatarRef={avatars.ref(key)}
            selected={sameKey(item, selected)}
            render={rowLink(item)}
            memberAvatars={
              item._tag === "room"
                ? item.room.members.flatMap((id) => {
                    const bot = bots.get(id);
                    return bot ? [{ id: bot.id, avatar: bot.profile.avatar }] : [];
                  })
                : []
            }
          />
        </WithMenu>
      </ReorderRow>
    );
  };

  /** One run of rows that travel together as their order changes. */
  const list = (rows: ReadonlyArray<RosterItem>, view: string) => (
    <ReorderList
      view={{ keys: rows.map((item) => rosterKeyText(rosterKeyOf(item))), query: view }}
      scroller={scroller}
      onRise={(key) => avatars.hop(key)}
    >
      {rows.map(row)}
    </ReorderList>
  );

  let body: ReactNode;
  if (showHidden && !searching) {
    body = (
      <HiddenBots
        items={arranged.hidden}
        selected={selected}
        rowLink={rowLink}
        onBack={() => setShowHidden(false)}
        onUnhide={(botId) => intents.placeBot(botId, { hidden: false })}
      />
    );
  } else if (searching) {
    const rows = orderRoster(filterRoster(items, query));
    body = rows.length === 0 ? <RosterEmpty query={query.trim()} /> : list(rows, query.trim());
  } else if (items.length === 0) {
    body = <RosterEmpty query="" />;
  } else {
    body = (
      <>
        {arranged.pinned.length > 0 && (
          <PinnedBots items={arranged.pinned} selected={selected} rowLink={rowLink} menu={menu} />
        )}
        {arranged.main.length > 0 && list(arranged.main, "")}
        {arranged.sections.map(({ section, items: rows }, index) => (
          <SectionBlock
            key={section.id}
            section={section}
            index={index}
            sections={sections ?? []}
            unread={rows.some((item) => item.unread)}
            folded={folded.has(section.id)}
            onFold={(fold) => folded.set(section.id, fold)}
            renaming={renaming === section.id}
            onRename={(name) => {
              setRenaming(null);
              if (name !== null && name !== section.name) {
                intents.updateSection(section.id, { name });
              }
            }}
            onStartRename={() => setRenaming(section.id)}
            menu={menu}
          >
            {rows.length > 0 ? list(rows, `section:${section.id}`) : null}
          </SectionBlock>
        ))}
        {arranged.hidden.length > 0 && (
          <HiddenRow items={arranged.hidden} onOpen={() => setShowHidden(true)} />
        )}
      </>
    );
  }

  return (
    <nav
      ref={ref}
      aria-label={t("roster.label")}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={moveFocus}
    >
      {/* A phone shows the roster alone, so it is titled; beside a conversation it needs no title. */}
      <h1 className="display-type hidden px-4 pt-4 pb-1 text-3xl @max-tablet:block">
        {t("roster.label")}
      </h1>
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 @max-tablet:pt-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted px-3 text-muted-foreground transition-colors duration-(--duration-fast) ease-out focus-within:outline-2 focus-within:outline-accent hover:bg-muted-strong focus-within:hover:bg-muted pointer-coarse:h-(--layout-touch-target)">
          <SearchIcon className="size-4 shrink-0" aria-hidden />
          <input
            type="search"
            data-roster-search=""
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={t("roster.search")}
            aria-label={t("roster.search")}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query !== "" && (
            <button
              type="button"
              aria-label={t("roster.search.clear")}
              onClick={() => setQuery("")}
              className="pressable-round -me-1.5 flex size-6 shrink-0 pointer-coarse:-me-3 pointer-coarse:size-11 cursor-pointer items-center justify-center rounded-pill hover:bg-muted-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
            >
              <XIcon className="size-3.5" aria-hidden />
            </button>
          )}
        </label>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={t("roster.new")} />}>
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuItem onClick={onNewBot} icon={<BotIcon />}>
              {t("roster.newBot")}
            </MenuItem>
            {/* A room needs two bots: with fewer, the row says so and makes a bot instead. */}
            {bots.size >= ROOM_MEMBERS.min ? (
              <MenuItem onClick={onNewRoom} icon={<UsersIcon />}>
                {t("roster.newRoom")}
              </MenuItem>
            ) : (
              <MenuItem
                onClick={onNewBot}
                icon={<UsersIcon />}
                hint={t("roster.newRoom.needsBots")}
              >
                {t("roster.newRoom")}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      </div>
      {/* The lists keep their own place as rows move (`ReorderList`), so the browser's anchoring stays out. */}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [overflow-anchor:none]"
      >
        {body}
      </div>
      {footer}
      <RosterQuestionDialog
        question={question}
        onClose={() => setQuestion(null)}
        intents={intents}
        primary={menu.primary}
      />
    </nav>
  );
}

/** What the roster says when it has no row to show: none yet, or none matching the search. */
function RosterEmpty({ query }: { query: string }) {
  const { t } = useI18n();
  return (
    <div className="appear flex flex-col items-center gap-2 px-6 py-10 text-center">
      {query !== "" && (
        <span className="flex size-10 items-center justify-center rounded-pill bg-muted text-muted-foreground">
          <SearchXIcon aria-hidden className="size-5" />
        </span>
      )}
      <p className="text-sm text-muted-foreground">
        {query === "" ? t("roster.empty") : t("roster.noMatch", { query })}
      </p>
    </div>
  );
}
