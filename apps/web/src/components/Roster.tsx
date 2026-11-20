// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { useBots, useI18n } from "../app/context";
import { filterRoster, orderRoster } from "../presentation/roster";
import { RosterRow } from "./RosterRow";
import { Button } from "./ui/button";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

const keyOf = (item: RosterItem): string =>
  item._tag === "bot" ? `bot:${item.bot.id}` : `room:${item.room.id}`;

const sameKey = (item: RosterItem, key: RosterItemKey | null) =>
  key !== null &&
  (item._tag === "bot"
    ? key._tag === "bot" && key.botId === item.bot.id
    : key._tag === "room" && key.roomId === item.room.id);

/**
 * Arrow keys move from the search field into the rows and between them; Home
 * and End jump to the ends of the list. Up from the first row returns to search.
 */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
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
  readonly selected: RosterItemKey | null;
  /** The link a row navigates with, such as a router link to its conversation. */
  readonly rowLink: (item: RosterItem) => ReactElement;
  readonly onNewBot: () => void;
  readonly onNewRoom: () => void;
  readonly footer?: ReactNode;
}

/** Answers: who do I have, who needs me, what is each of them doing. */
export function Roster({ items, selected, rowLink, onNewBot, onNewRoom, footer }: RosterProps) {
  const { t } = useI18n();
  const bots = useBots();
  const [query, setQuery] = useState("");
  const rows = orderRoster(filterRoster(items, query));
  return (
    <nav
      aria-label={t("roster.label")}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={moveFocus}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted px-2.5 text-muted-foreground focus-within:outline-2 focus-within:outline-accent pointer-coarse:h-(--layout-touch-target)">
          <SearchIcon className="size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            data-roster-search=""
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={t("roster.search")}
            aria-label={t("roster.search")}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={t("roster.new")} />}>
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuPrimitive.Item
              onClick={onNewBot}
              className="flex h-8 items-center rounded-md px-2 outline-none data-highlighted:bg-muted"
            >
              {t("roster.newBot")}
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              onClick={onNewRoom}
              className="flex h-8 items-center rounded-md px-2 outline-none data-highlighted:bg-muted"
            >
              {t("roster.newRoom")}
            </MenuPrimitive.Item>
          </MenuPopup>
        </Menu>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {query.trim() === "" ? t("roster.empty") : t("roster.noMatch", { query: query.trim() })}
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {rows.map((item) => (
              <li key={keyOf(item)}>
                <RosterRow
                  item={item}
                  selected={sameKey(item, selected)}
                  render={rowLink(item)}
                  memberAvatars={
                    item._tag === "room"
                      ? item.room.members.flatMap((id) => {
                          const bot = bots.get(id);
                          return bot ? [bot.profile.avatar] : [];
                        })
                      : []
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {footer}
    </nav>
  );
}
