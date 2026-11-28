// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { BrowserTabRef } from "@j3-bots/contracts";
import type {
  BrowserPlace,
  BrowserSuggestion,
  DesktopBrowserCommand,
  DesktopBrowserTab,
  DesktopDownload,
} from "@j3-bots/desktop-bridge";
import { siteOf } from "@j3-bots/client-runtime/presentation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EyeOffIcon,
  GlobeIcon,
  PanelRightIcon,
  PictureInPicture2Icon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../app/context";
import { Kbd } from "../../components/ui/kbd";
import { MenuItem, MenuSeparator } from "../../components/ui/menu";
import { cn } from "../../lib/cn";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { siteLetter, sizeText } from "./state";

// The browser's top bar, left to right as the design has it: back, forward,
// reload, the address, the zoom when it is not 100%, who is on the tab, the
// downloads, the other place, and the menu.

const control =
  "pressable-round inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";

const popup =
  "origin-(--transform-origin) rounded-lg border border-border bg-surface p-1.5 text-sm text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out";

/** The shortcut of a menu row, as the system writes it. */
const keys = (mac: boolean, ...parts: ReadonlyArray<string>) =>
  parts.map((part) => (part === "Ctrl" && mac ? "⌘" : part)).join(mac ? "" : "+");

export interface ToolbarProps {
  readonly bridge: DesktopBrowserBridge;
  readonly place: BrowserPlace;
  readonly tab: DesktopBrowserTab | null;
  readonly downloads: ReadonlyArray<DesktopDownload>;
  readonly canReopen: boolean;
  readonly mac: boolean;
  readonly addressRef: RefObject<HTMLInputElement | null>;
  /** Who is on the tab, from the server: the faces and what they do. */
  readonly presence?: ReactNode;
  /** Something of the bar lies over the page, or no longer does. */
  readonly onCover: (what: string, covers: boolean) => void;
  readonly open: { readonly downloads: boolean; readonly history: boolean };
  readonly setOpen: (what: "downloads" | "history", open: boolean) => void;
  readonly onFind: () => void;
  readonly onSignIns?: (() => void) | undefined;
  /** Closes the panel beside the conversation. */
  readonly onClose?: (() => void) | undefined;
  readonly command: (command: DesktopBrowserCommand) => void;
}

export function Toolbar(props: ToolbarProps) {
  const { t } = useI18n();
  const { tab, place, command, mac } = props;
  const on = (asked: (ref: BrowserTabRef) => DesktopBrowserCommand) => () => {
    if (tab !== null) command(asked(tab.ref));
  };
  const other: BrowserPlace = place === "panel" ? "window" : "panel";
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
      <button
        type="button"
        className={control}
        aria-label={t("desktopBrowser.back")}
        disabled={tab?.canGoBack !== true}
        onClick={on((ref) => ({ _tag: "back", tab: ref }))}
      >
        <ArrowLeftIcon className="rtl:-scale-x-100" />
      </button>
      <button
        type="button"
        className={control}
        aria-label={t("desktopBrowser.forward")}
        disabled={tab?.canGoForward !== true}
        onClick={on((ref) => ({ _tag: "forward", tab: ref }))}
      >
        <ArrowRightIcon className="rtl:-scale-x-100" />
      </button>
      {tab?.loading === true ? (
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.stop")}
          onClick={on((ref) => ({ _tag: "stop", tab: ref }))}
        >
          <XIcon />
        </button>
      ) : (
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.reload")}
          disabled={tab === null || tab.url === ""}
          onClick={on((ref) => ({ _tag: "reload", tab: ref }))}
        >
          <RotateCwIcon />
        </button>
      )}
      <AddressBar {...props} />
      {tab !== null && tab.zoom !== 100 && (
        <button
          type="button"
          className="pressable h-7 shrink-0 rounded-full px-2 text-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("desktopBrowser.zoomReset", { percent: String(tab.zoom) })}
          onClick={() => command({ _tag: "zoom", tab: tab.ref, to: "reset" })}
        >
          {tab.zoom}%
        </button>
      )}
      {props.presence}
      <Downloads {...props} />
      <History {...props} />
      <button
        type="button"
        className={control}
        aria-label={t(place === "panel" ? "desktopBrowser.toWindow" : "desktopBrowser.toPanel")}
        title={`${t(place === "panel" ? "desktopBrowser.toWindow" : "desktopBrowser.toPanel")} (${keys(mac, "Ctrl", "Shift", "D")})`}
        disabled={tab === null}
        onClick={on((ref) => ({ _tag: "show", tab: ref, place: other }))}
      >
        {place === "panel" ? <PictureInPicture2Icon /> : <PanelRightIcon />}
      </button>
      <BrowserMenu {...props} />
      {props.onClose !== undefined && (
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.close")}
          onClick={props.onClose}
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}

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

function AddressBar({ bridge, tab, place, command, addressRef, onCover }: ToolbarProps) {
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
        {tab?.private === true ? (
          <EyeOffIcon aria-hidden className="relative size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GlobeIcon aria-hidden className="relative size-4 shrink-0 text-muted-foreground" />
        )}
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
            className="pointer-events-none absolute inset-y-0 start-9 end-3 flex items-center"
          >
            <ShownAddress url={tab.url} />
          </span>
        )}
        {tab?.private === true && (
          <span
            className="relative shrink-0 rounded-full border border-border px-1.5 text-2xs text-muted-foreground"
            title={t("desktopBrowser.privateHint")}
          >
            {t("desktopBrowser.private")}
          </span>
        )}
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

function Suggestion({ suggestion }: { readonly suggestion: BrowserSuggestion }) {
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

/** A site's letter, where its icon would be. */
export function SiteTile({
  url,
  title,
  className,
}: {
  readonly url: string;
  readonly title: string;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-2xs font-semibold text-muted-foreground",
        className,
      )}
    >
      {siteLetter(url, title)}
    </span>
  );
}

function Downloads({ downloads, command, open, setOpen, onCover }: ToolbarProps) {
  const { t, locale } = useI18n();
  // A dot until the person looks at what came in.
  const [seen, setSeen] = useState(downloads.length);
  const fresh = downloads.length > seen;
  return (
    <Popover.Root
      open={open.downloads}
      onOpenChange={(next) => {
        setOpen("downloads", next);
        onCover("downloads", next);
        if (next) setSeen(downloads.length);
      }}
    >
      <Popover.Trigger
        className={cn(control, "relative")}
        aria-label={t("desktopBrowser.downloads")}
      >
        <DownloadIcon />
        {fresh && (
          <span
            aria-hidden
            className="absolute end-1.5 top-1.5 size-1.5 rounded-full bg-foreground"
          />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className={cn(popup, "w-80")}>
            <Popover.Title className="px-2.5 pt-1.5 pb-2 font-medium">
              {t("desktopBrowser.downloads")}
            </Popover.Title>
            {downloads.length === 0 ? (
              <p className="px-2.5 pb-2 text-muted-foreground">
                {t("desktopBrowser.downloads.empty")}
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col overflow-y-auto">
                {downloads.map((download) => {
                  const size =
                    download.state === "progressing"
                      ? t("desktopBrowser.downloads.progress", {
                          received: sizeText(download.received, locale),
                          total: download.total > 0 ? sizeText(download.total, locale) : "…",
                        })
                      : download.state === "completed"
                        ? sizeText(download.total || download.received, locale)
                        : t(
                            download.state === "cancelled"
                              ? "desktopBrowser.downloads.cancelled"
                              : "desktopBrowser.downloads.interrupted",
                          );
                  const mine = download.by === "person";
                  return (
                    <li
                      key={download.id}
                      className="flex items-center gap-2 rounded-md px-2.5 py-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate">{download.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {t(
                            mine
                              ? "desktopBrowser.downloads.byYou"
                              : "desktopBrowser.downloads.byBot",
                            {
                              size,
                            },
                          )}
                        </span>
                      </span>
                      {download.state === "progressing" ? (
                        <button
                          type="button"
                          className="pressable h-7 rounded-full px-2.5 text-xs hover:bg-muted"
                          onClick={() => command({ _tag: "cancelDownload", id: download.id })}
                        >
                          {t("desktopBrowser.downloads.stop")}
                        </button>
                      ) : (
                        download.inDownloads &&
                        download.state === "completed" && (
                          <button
                            type="button"
                            className="pressable h-7 rounded-full px-2.5 text-xs hover:bg-muted"
                            onClick={() => command({ _tag: "openDownload", id: download.id })}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              command({ _tag: "showDownload", id: download.id });
                            }}
                            title={t("desktopBrowser.downloads.show")}
                          >
                            {t("desktopBrowser.downloads.open")}
                          </button>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function History({ bridge, tab, place, command, open, setOpen, onCover }: ToolbarProps) {
  const { t } = useI18n();
  const [visits, setVisits] = useState<ReadonlyArray<BrowserSuggestion>>([]);
  useEffect(() => {
    if (open.history) void bridge.suggest("", true).then(setVisits);
  }, [bridge, open.history]);
  return (
    <Popover.Root
      open={open.history}
      onOpenChange={(next) => {
        setOpen("history", next);
        onCover("history", next);
      }}
    >
      {/* Opened from the menu or its shortcut: the bar has no button of its own for it. */}
      <span className="relative self-end">
        <Popover.Trigger
          className="absolute end-0 bottom-0 size-px opacity-0"
          tabIndex={-1}
          aria-hidden
        />
      </span>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className={cn(popup, "w-96")}>
            <Popover.Title className="px-2.5 pt-1.5 pb-2 font-medium">
              {t("desktopBrowser.menu.history")}
            </Popover.Title>
            {visits.length === 0 ? (
              <p className="px-2.5 pb-2 text-muted-foreground">
                {t("desktopBrowser.history.empty")}
              </p>
            ) : (
              <ul className="flex max-h-96 flex-col overflow-y-auto">
                {visits.map((visit) =>
                  visit._tag === "visited" ? (
                    <li key={visit.url}>
                      <button
                        type="button"
                        className="flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-start hover:bg-muted"
                        onClick={() => {
                          if (tab === null)
                            command({ _tag: "open", input: visit.url, private: false, place });
                          else command({ _tag: "go", tab: tab.ref, input: visit.url });
                          setOpen("history", false);
                          onCover("history", false);
                        }}
                      >
                        <Suggestion suggestion={visit} />
                      </button>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BrowserMenu({
  tab,
  place,
  command,
  canReopen,
  mac,
  setOpen,
  onCover,
  onFind,
  onSignIns,
}: ToolbarProps) {
  const { t } = useI18n();
  const shortcut = (...parts: ReadonlyArray<string>) => (
    <Kbd className="ms-auto">{keys(mac, ...parts)}</Kbd>
  );
  const other: BrowserPlace = place === "panel" ? "window" : "panel";
  return (
    <MenuPrimitive.Root onOpenChange={(next) => onCover("menu", next)}>
      <MenuPrimitive.Trigger className={control} aria-label={t("desktopBrowser.menu")}>
        <EllipsisVerticalIcon />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <MenuPrimitive.Popup className={cn(popup, "min-w-60")}>
            <MenuItem onClick={() => command({ _tag: "open", private: false, place })}>
              <span className="flex items-center gap-4">
                {t("desktopBrowser.newTab")}
                {shortcut("Ctrl", "T")}
              </span>
            </MenuItem>
            <MenuItem onClick={() => command({ _tag: "open", private: true, place })}>
              <span className="flex items-center gap-4">
                {t("desktopBrowser.newPrivateTab")}
                {shortcut("Ctrl", "Shift", "N")}
              </span>
            </MenuItem>
            {canReopen && (
              <MenuItem onClick={() => command({ _tag: "reopen", place })}>
                <span className="flex items-center gap-4">
                  {t("desktopBrowser.menu.reopen")}
                  {shortcut("Ctrl", "Shift", "T")}
                </span>
              </MenuItem>
            )}
            {tab !== null && (
              <>
                <MenuSeparator />
                <div className="flex h-9 items-center gap-2 px-2.5">
                  <span className="flex-1">{t("desktopBrowser.menu.zoom")}</span>
                  <button
                    type="button"
                    className={control}
                    aria-label={t("desktopBrowser.menu.zoomOut")}
                    onClick={() => command({ _tag: "zoom", tab: tab.ref, to: "out" })}
                  >
                    −
                  </button>
                  <span className="w-10 text-center tabular-nums">{tab.zoom}%</span>
                  <button
                    type="button"
                    className={control}
                    aria-label={t("desktopBrowser.menu.zoomIn")}
                    onClick={() => command({ _tag: "zoom", tab: tab.ref, to: "in" })}
                  >
                    +
                  </button>
                </div>
                <MenuItem onClick={onFind}>
                  <span className="flex items-center gap-4">
                    {t("desktopBrowser.menu.find")}
                    {shortcut("Ctrl", "F")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => command({ _tag: "print", tab: tab.ref })}>
                  <span className="flex items-center gap-4">
                    {t("desktopBrowser.menu.print")}
                    {shortcut("Ctrl", "P")}
                  </span>
                </MenuItem>
              </>
            )}
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                setOpen("history", true);
                onCover("history", true);
              }}
            >
              <span className="flex items-center gap-4">
                {t("desktopBrowser.menu.history")}
                {shortcut("Ctrl", mac ? "Y" : "H")}
              </span>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setOpen("downloads", true);
                onCover("downloads", true);
              }}
            >
              <span className="flex items-center gap-4">
                {t("desktopBrowser.downloads")}
                {shortcut("Ctrl", "J")}
              </span>
            </MenuItem>
            {onSignIns !== undefined && (
              <MenuItem onClick={onSignIns}>{t("desktopBrowser.menu.signIns")}</MenuItem>
            )}
            {tab !== null && (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => command({ _tag: "show", tab: tab.ref, place: other })}>
                  <span className="flex items-center gap-4">
                    {t(place === "panel" ? "desktopBrowser.toWindow" : "desktopBrowser.toPanel")}
                    {shortcut("Ctrl", "Shift", "D")}
                  </span>
                </MenuItem>
              </>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
