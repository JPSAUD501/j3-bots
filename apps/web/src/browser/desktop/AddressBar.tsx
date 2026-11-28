// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import type {
  BrowserPlace,
  BrowserSuggestion,
  DesktopBrowserCommand,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import { siteOf } from "@j3-bots/client-runtime/presentation";
import { EyeOffIcon, GlobeIcon, SearchIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { popup } from "./controls";
import { SiteTile } from "./SiteTile";

// The address of the tab in front, and the suggestions as the person types
// one. Away from it, the bar shows the address quieter than typed: no
// scheme, the path in a softer color.

/** The address, as the bar shows it while no one types: no scheme, the path quieter. */
function ShownAddress({ url }: { readonly url: string }) {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return <span className="truncate">{url}</span>;
  }
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  return (
    <span className="flex min-w-0">
      <span className="shrink-0 text-foreground">{siteOf(url)}</span>
      <span className="truncate text-muted-foreground">{rest}</span>
    </span>
  );
}

export function AddressBar({
  bridge,
  tab,
  place,
  command,
  addressRef,
  onCover,
  leading,
  trailing,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab | null;
  readonly place: BrowserPlace;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly addressRef: RefObject<HTMLInputElement | null>;
  /** The suggestions lie over the page, or no longer do. */
  readonly onCover: (what: string, covers: boolean) => void;
  /** At the start of the bar, before the site's icon. */
  readonly leading?: ReactNode;
  /** At the end of the bar, after the private tab's mark. */
  readonly trailing?: ReactNode;
}) {
  const { t } = useI18n();
  // What was typed, on the tab it was typed on: another tab in front, and it goes.
  const ref = tab?.ref ?? null;
  const [typed, setTyped] = useState<{
    readonly on: BrowserTabRef | null;
    readonly text: string;
  } | null>(null);
  const typing = typed !== null && typed.on === ref ? typed.text : null;
  const setTyping = (text: string | null) => setTyped(text === null ? null : { on: ref, text });
  const [suggestions, setSuggestions] = useState<ReadonlyArray<BrowserSuggestion>>([]);
  const [chosen, setChosen] = useState(0);
  const listId = useId();
  const asked = useRef(0);
  const listed = typing !== null && typing.trim() !== "" && suggestions.length > 0;
  useEffect(() => {
    onCover("suggestions", listed);
  }, [listed, onCover]);
  // A new tab waits for an address.
  const blankTab = tab !== null && tab.url === "" ? ref : null;
  useEffect(() => {
    if (blankTab !== null) addressRef.current?.focus();
  }, [blankTab, addressRef]);

  const type = (text: string) => {
    setTyping(text);
    setChosen(0);
    const mine = ++asked.current;
    void bridge.suggest(text).then((found) => {
      if (mine === asked.current) setSuggestions(found);
    });
  };
  const done = () => {
    setTyping(null);
    setSuggestions([]);
    addressRef.current?.blur();
  };
  const take = (suggestion: BrowserSuggestion | undefined, text: string) => {
    if (suggestion?._tag === "tab") command({ _tag: "show", tab: suggestion.tab, place });
    else {
      const input = suggestion?._tag === "visited" ? suggestion.url : text;
      if (input.trim() === "") return;
      if (tab === null) command({ _tag: "open", input, private: false, place });
      else command({ _tag: "go", tab: tab.ref, input });
    }
    done();
  };

  const focused = typing !== null;
  return (
    <div className="relative min-w-0 flex-1 px-1">
      <div
        className={cn(
          "relative flex h-8 items-center gap-1.5 overflow-hidden rounded-full bg-muted px-3 text-sm",
          focused && "bg-surface outline-2 outline-accent",
        )}
      >
        {/* Loading fills the bar slowly from behind the text. */}
        {tab?.loading === true && (
          <span
            aria-hidden
            className="absolute inset-y-0 start-0 w-0 animate-[address-fill_8s_var(--ease-out)_forwards] bg-muted-strong/60"
          />
        )}
        {leading}
        {tab?.private === true ? (
          <EyeOffIcon aria-hidden className="relative size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GlobeIcon aria-hidden className="relative size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="relative flex min-w-0 flex-1 items-center self-stretch">
          <input
            ref={addressRef}
            role="combobox"
            aria-expanded={listed}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={t("desktopBrowser.address")}
            placeholder={t("desktopBrowser.address")}
            spellCheck={false}
            // Away from it, the address is still its value, drawn by the shown address over it.
            value={typing ?? tab?.url ?? ""}
            onFocus={(event) => {
              setTyping(tab?.url ?? "");
              // Clicking the address takes all of it.
              event.currentTarget.select();
            }}
            onBlur={() => {
              setTyping(null);
              setSuggestions([]);
            }}
            onChange={(event) => type(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && listed) {
                event.preventDefault();
                setChosen((at) => Math.min(at + 1, suggestions.length - 1));
              } else if (event.key === "ArrowUp" && listed) {
                event.preventDefault();
                setChosen((at) => Math.max(at - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                take(listed ? suggestions[chosen] : undefined, event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                done();
              }
            }}
            className={cn(
              "relative min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground",
              !focused && tab !== null && tab.url !== "" && "text-transparent",
            )}
          />
          {!focused && tab !== null && tab.url !== "" && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 start-0.5 end-0 flex items-center"
            >
              <ShownAddress url={tab.url} />
            </span>
          )}
        </span>
        {tab?.private === true && (
          <span
            className="relative shrink-0 rounded-full border border-border px-1.5 text-2xs text-muted-foreground"
            title={t("desktopBrowser.privateHint")}
          >
            {t("desktopBrowser.private")}
          </span>
        )}
        {trailing}
      </div>
      {listed && (
        <ul
          id={listId}
          role="listbox"
          className={cn(popup, "absolute inset-x-1 top-full z-40 mt-1.5 flex flex-col")}
          // A click on the list keeps the address focused until it is taken.
          onMouseDown={(event) => event.preventDefault()}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion._tag === "search" ? "search" : `${suggestion._tag}:${suggestion.url}`}
              role="option"
              aria-selected={index === chosen}
              onMouseEnter={() => setChosen(index)}
              onClick={() => take(suggestion, typing)}
              className="flex h-10 cursor-default items-center gap-2.5 rounded-md px-2.5 aria-selected:bg-muted"
            >
              <Suggestion suggestion={suggestion} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row of the suggestions, or of the history: the site, its title, and where it comes from. */
export function Suggestion({ suggestion }: { readonly suggestion: BrowserSuggestion }) {
  const { t } = useI18n();
  if (suggestion._tag === "search") {
    return (
      <>
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {t("desktopBrowser.suggest.search", { text: suggestion.text })}
        </span>
      </>
    );
  }
  const note =
    suggestion._tag === "tab"
      ? t("desktopBrowser.suggest.goToTab")
      : suggestion.byBot
        ? t("desktopBrowser.suggest.byBot")
        : null;
  return (
    <>
      <SiteTile url={suggestion.url} title={suggestion.title} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{suggestion.title || siteOf(suggestion.url)}</span>
        <span className="truncate text-xs text-muted-foreground">
          {note === null ? suggestion.url : `${note} · ${siteOf(suggestion.url)}`}
        </span>
      </span>
    </>
  );
}
