// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import {
  type BrowserPlace,
  type BrowserShortcut,
  browserShortcutOf,
  type DesktopBrowserCommand,
} from "@j3-bots/desktop-bridge";
import { ChevronLeftIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useI18n } from "../../app/context";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { PageArea } from "./PageArea";
import { frontOf, tabsIn, useDesktopBrowser } from "./state";
import { TabStrip } from "./TabStrip";
import { Toolbar } from "./Toolbar";

// The desktop app's own browser in one of its places: beside the
// conversation in the main window (`panel`), or filling the browser's own
// window (`window`). Nothing in it is there only for bots but the faces and
// the line of who is on a tab: someone who never used a bot sees an
// ordinary browser.

const mac = /Macintosh|Mac OS X/.test(navigator.userAgent);

const TAB_SHORTCUTS: Partial<Record<BrowserShortcut, number>> = {
  tab1: 0,
  tab2: 1,
  tab3: 2,
  tab4: 3,
  tab5: 4,
  tab6: 5,
  tab7: 6,
  tab8: 7,
};

export function DesktopBrowser({
  bridge,
  place,
  held = false,
  presence,
  onClose,
  onToConversation,
  onSignIns,
  onBotConversation,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly place: BrowserPlace;
  /** Something of the window moves over the page's place, as a divider being dragged: a still stands in for it. */
  readonly held?: boolean | undefined;
  /** Who is on a tab, from the server: the faces on its tab, and the line in the bar. */
  readonly presence?:
    | {
        readonly faces: (tab: BrowserTabRef) => ReactNode;
        readonly line: (tab: BrowserTabRef) => ReactNode;
      }
    | undefined;
  /** Closes the panel beside the conversation. */
  readonly onClose?: (() => void) | undefined;
  /** Over the conversation, in a narrow window: back to it. */
  readonly onToConversation?: (() => void) | undefined;
  readonly onSignIns?: (() => void) | undefined;
  /** Goes to the conversation of the bot on the tab. */
  readonly onBotConversation?: ((tab: BrowserTabRef) => void) | undefined;
}) {
  const { t } = useI18n();
  const state = useDesktopBrowser(bridge);
  const root = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [covering, setCovering] = useState<ReadonlySet<string>>(new Set());
  // The tab being searched; another in front, and finding ends.
  const [findingIn, setFindingIn] = useState<BrowserTabRef | null>(null);
  const [open, setOpenState] = useState({ downloads: false, history: false });
  const onCover = useCallback((what: string, covers: boolean) => {
    setCovering((current) => {
      if (current.has(what) === covers) return current;
      const next = new Set(current);
      if (covers) next.add(what);
      else next.delete(what);
      return next;
    });
  }, []);
  const setOpen = useCallback((what: "downloads" | "history", next: boolean) => {
    setOpenState((current) => ({ ...current, [what]: next }));
  }, []);
  const command = useCallback((asked: DesktopBrowserCommand) => bridge.command(asked), [bridge]);

  const tabs = state === null ? [] : tabsIn(state, place);
  const tab = state === null ? null : frontOf(state, place);
  const ref = tab?.ref ?? null;
  const finding = ref !== null && findingIn === ref;

  const shortcut = useEffectEvent((pressed: BrowserShortcut) => {
    const index = TAB_SHORTCUTS[pressed];
    if (index !== undefined || pressed === "lastTab") {
      const to = pressed === "lastTab" ? tabs.at(-1) : tabs[index ?? 0];
      if (to !== undefined) command({ _tag: "show", tab: to.ref, place });
      return;
    }
    const at = tabs.findIndex((each) => each.ref === ref);
    switch (pressed) {
      case "newTab":
        return command({ _tag: "open", private: false, place });
      case "newPrivateTab":
        return command({ _tag: "open", private: true, place });
      case "reopenTab":
        return command({ _tag: "reopen", place });
      case "nextTab":
      case "previousTab": {
        if (tabs.length === 0) return;
        const step = pressed === "nextTab" ? 1 : -1;
        const to = tabs[(at + step + tabs.length) % tabs.length];
        if (to !== undefined) command({ _tag: "show", tab: to.ref, place });
        return;
      }
      case "address":
        addressRef.current?.focus();
        addressRef.current?.select();
        return;
      case "downloads":
        setOpen("downloads", true);
        onCover("downloads", true);
        return;
      case "history":
        setOpen("history", true);
        onCover("history", true);
        return;
      default:
        break;
    }
    if (ref === null) return;
    switch (pressed) {
      case "closeTab":
        return command({ _tag: "close", tab: ref });
      case "back":
        return command({ _tag: "back", tab: ref });
      case "forward":
        return command({ _tag: "forward", tab: ref });
      case "reload":
        return command({ _tag: "reload", tab: ref });
      case "stop":
        return command({ _tag: "stop", tab: ref });
      case "find":
        return setFindingIn(ref);
      case "zoomIn":
        return command({ _tag: "zoom", tab: ref, to: "in" });
      case "zoomOut":
        return command({ _tag: "zoom", tab: ref, to: "out" });
      case "zoomReset":
        return command({ _tag: "zoom", tab: ref, to: "reset" });
      case "print":
        return command({ _tag: "print", tab: ref });
      case "togglePlace":
        return command({ _tag: "show", tab: ref, place: place === "panel" ? "window" : "panel" });
      case "botConversation":
        return onBotConversation?.(ref);
      default:
        return;
    }
  });
  // Pressed while the page had the keys, or in the browser's own controls.
  useEffect(() => bridge.onShortcut(shortcut), [bridge]);
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      // In the main window, only while the browser has the keys; its own window is all browser.
      const target = event.target;
      if (
        place === "panel" &&
        !(target instanceof Node && root.current?.contains(target) === true)
      ) {
        return;
      }
      const found = browserShortcutOf(
        {
          key: event.key,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
          alt: event.altKey,
        },
        { mac, loading: false },
      );
      if (found === null || event.isComposing) return;
      event.preventDefault();
      shortcut(found);
    };
    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, [place]);

  return (
    <div ref={root} className="flex h-full min-h-0 w-full flex-col bg-sidebar">
      <div className="flex items-end">
        {onToConversation !== undefined && (
          <button
            type="button"
            onClick={onToConversation}
            className="pressable mb-1 ms-1.5 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full ps-1 pe-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
          >
            <ChevronLeftIcon className="rtl:-scale-x-100" />
            {t("desktopBrowser.toConversation")}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <TabStrip
            tabs={tabs}
            front={ref}
            faces={presence?.faces}
            onShow={(shown) => command({ _tag: "show", tab: shown, place })}
            onClose={(closed) => command({ _tag: "close", tab: closed })}
            onNew={() => command({ _tag: "open", private: false, place })}
            onCover={onCover}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <Toolbar
          bridge={bridge}
          place={place}
          tab={tab}
          downloads={state?.downloads ?? []}
          canReopen={state?.canReopen ?? false}
          mac={mac}
          addressRef={addressRef}
          presence={ref === null ? undefined : presence?.line(ref)}
          onCover={onCover}
          open={open}
          setOpen={setOpen}
          onFind={() => setFindingIn(ref)}
          onSignIns={onSignIns}
          onClose={onClose}
          command={command}
        />
        <PageArea
          bridge={bridge}
          tab={tab}
          place={place}
          covered={held || covering.size > 0}
          finding={finding}
          addressRef={addressRef}
          command={command}
          onStopFinding={() => setFindingIn(null)}
        />
      </div>
    </div>
  );
}
