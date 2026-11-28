// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { BrowserTabRef } from "@j3-bots/contracts";
import type { DesktopBrowserTab } from "@j3-bots/desktop-bridge";
import { EyeOffIcon, LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../app/context";
import { MenuItem } from "../../components/ui/menu";
import { cn } from "../../lib/cn";
import { usePageNamer } from "./internal/InternalPage";
import { tabName } from "./state";
import { SiteTile } from "./SiteTile";

// The tabs of one place, as a browser shows them: the site's icon, the
// title, the faces of who is on the tab where a browser shows sound
// playing, and the close button on hover. A private tab carries its own
// mark, in the text's color.

/** The narrowest a tab gets before the strip keeps only the one in front. */
const NARROWEST_TAB = 120;

const popup =
  "min-w-56 origin-(--transform-origin) rounded-lg border border-border bg-surface p-1.5 text-sm shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0";

export function TabStrip({
  tabs,
  front,
  faces,
  onShow,
  onClose,
  onNew,
  onCover,
}: {
  readonly tabs: ReadonlyArray<DesktopBrowserTab>;
  readonly front: BrowserTabRef | null;
  /** The faces of who is on a tab, from the server. */
  readonly faces?: ((tab: BrowserTabRef) => ReactNode) | undefined;
  readonly onShow: (tab: BrowserTabRef) => void;
  readonly onClose: (tab: BrowserTabRef) => void;
  readonly onNew: () => void;
  readonly onCover: (what: string, covers: boolean) => void;
}) {
  const { t, plural } = useI18n();
  const named = usePageNamer();
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(Infinity);
  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // When they do not fit, the tab in front stays whole and the others go in a list.
  const fits = tabs.length * NARROWEST_TAB <= width - 80;
  const shown = fits ? tabs : tabs.filter((tab) => tab.ref === front);
  const others = fits ? [] : tabs.filter((tab) => tab.ref !== front);
  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={t("desktopBrowser.tabs")}
      className="flex h-10 shrink-0 items-end gap-0.5 px-1.5 pt-1.5"
    >
      {shown.map((tab) => (
        <Tab
          key={tab.ref}
          tab={tab}
          inFront={tab.ref === front}
          faces={faces?.(tab.ref)}
          onShow={() => onShow(tab.ref)}
          onClose={() => onClose(tab.ref)}
        />
      ))}
      {others.length > 0 && (
        <MenuPrimitive.Root onOpenChange={(open) => onCover("tabs", open)}>
          <MenuPrimitive.Trigger
            className="pressable mb-1 h-7 shrink-0 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={plural("desktopBrowser.otherTabs", others.length)}
          >
            +{others.length}
          </MenuPrimitive.Trigger>
          <MenuPrimitive.Portal>
            <MenuPrimitive.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
              <MenuPrimitive.Popup className={popup}>
                {others.map((tab) => (
                  <MenuItem
                    key={tab.ref}
                    onClick={() => onShow(tab.ref)}
                    icon={<SiteTile url={tab.url} title={tab.title} />}
                  >
                    <span className="flex items-center gap-2">
                      <span className="max-w-56 truncate">{tabName(tab, named)}</span>
                      {faces?.(tab.ref)}
                    </span>
                  </MenuItem>
                ))}
              </MenuPrimitive.Popup>
            </MenuPrimitive.Positioner>
          </MenuPrimitive.Portal>
        </MenuPrimitive.Root>
      )}
      <button
        type="button"
        className="pressable-round mb-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
        aria-label={t("desktopBrowser.newTab")}
        onClick={onNew}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function Tab({
  tab,
  inFront,
  faces,
  onShow,
  onClose,
}: {
  readonly tab: DesktopBrowserTab;
  readonly inFront: boolean;
  readonly faces: ReactNode;
  readonly onShow: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const name = tabName(tab, usePageNamer());
  return (
    <div
      className={cn(
        "group relative flex h-8.5 min-w-0 max-w-60 flex-1 basis-60 items-center gap-2 rounded-t-lg ps-2.5 pe-1.5 text-sm",
        inFront ? "bg-background text-foreground" : "text-muted-foreground hover:bg-muted",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={inFront}
        title={tab.private ? `${name} · ${t("desktopBrowser.privateHint")}` : name}
        onClick={onShow}
        onAuxClick={(event) => {
          // The middle button closes a tab, as in any browser.
          if (event.button === 1) onClose();
        }}
        className="absolute inset-0 rounded-t-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="sr-only">{name}</span>
      </button>
      {tab.loading ? (
        <LoaderCircleIcon
          aria-hidden
          className="pointer-events-none size-4 shrink-0 animate-spin"
        />
      ) : (
        <SiteTile url={tab.url} title={tab.title} className="pointer-events-none" />
      )}
      <span className="pointer-events-none min-w-0 flex-1 truncate">{name}</span>
      {tab.private && (
        <EyeOffIcon
          aria-label={t("desktopBrowser.private")}
          className="pointer-events-none size-3.5 shrink-0"
        />
      )}
      {faces !== undefined && faces !== null && (
        <span className="pointer-events-none shrink-0">{faces}</span>
      )}
      <button
        type="button"
        aria-label={t("desktopBrowser.closeTab")}
        onClick={onClose}
        className={cn(
          "pressable-round relative inline-flex size-5 shrink-0 items-center justify-center rounded-full opacity-0 hover:bg-muted-strong focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-3.5",
          inFront && "opacity-100",
        )}
      >
        <XIcon />
      </button>
    </div>
  );
}
