// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import type {
  BrowserPlace,
  BrowserSuggestion,
  DesktopBrowserCommand,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { Suggestion } from "./AddressBar";
import { popup } from "./controls";

// The latest visits, opened from the menu or its shortcut.

export function HistoryPopover({
  bridge,
  tab,
  place,
  command,
  open,
  onOpen,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab | null;
  readonly place: BrowserPlace;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly open: boolean;
  /** The list opens or closes, over the page. */
  readonly onOpen: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [visits, setVisits] = useState<ReadonlyArray<BrowserSuggestion>>([]);
  useEffect(() => {
    if (open) void bridge.suggest("", true).then(setVisits);
  }, [bridge, open]);
  return (
    <Popover.Root open={open} onOpenChange={onOpen}>
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
                          onOpen(false);
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
