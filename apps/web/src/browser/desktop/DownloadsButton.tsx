// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import type { DesktopBrowserCommand, DesktopDownload } from "@j3-bots/desktop-bridge";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { control, popup } from "./controls";
import { sizeText } from "./state";

// The downloads, the person's and the bots', from the bar's button, its
// shortcut or the menu.

export function DownloadsButton({
  downloads,
  command,
  open,
  onOpen,
}: {
  readonly downloads: ReadonlyArray<DesktopDownload>;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly open: boolean;
  /** The list opens or closes, over the page. */
  readonly onOpen: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  // A dot until the person looks at what came in.
  const [seen, setSeen] = useState(downloads.length);
  const fresh = downloads.length > seen;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        onOpen(next);
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
