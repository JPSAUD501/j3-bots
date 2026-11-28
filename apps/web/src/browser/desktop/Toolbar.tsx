// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import type {
  BrowserPlace,
  DesktopBrowserCommand,
  DesktopBrowserTab,
  DesktopDownload,
} from "@j3-bots/desktop-bridge";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  PanelRightIcon,
  PictureInPicture2Icon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useI18n } from "../../app/context";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { AddressBar } from "./AddressBar";
import { BrowserMenu } from "./BrowserMenu";
import { control, keys } from "./controls";
import { DownloadsButton } from "./DownloadsButton";
import { HistoryPopover } from "./HistoryPopover";

// The browser's top bar, left to right as the design has it: back, forward,
// reload, the address, the zoom when it is not 100%, who is on the tab, the
// downloads, the other place, and the menu.

interface ToolbarProps {
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
  /** One of the bar's lists opens or closes, over the page. */
  const list = (what: "downloads" | "history") => (open: boolean) => {
    props.setOpen(what, open);
    props.onCover(what, open);
  };
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
      <AddressBar
        bridge={props.bridge}
        tab={tab}
        place={place}
        command={command}
        addressRef={props.addressRef}
        onCover={props.onCover}
      />
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
      <DownloadsButton
        downloads={props.downloads}
        command={command}
        open={props.open.downloads}
        onOpen={list("downloads")}
      />
      <HistoryPopover
        bridge={props.bridge}
        tab={tab}
        place={place}
        command={command}
        open={props.open.history}
        onOpen={list("history")}
      />
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
      <BrowserMenu
        tab={tab}
        place={place}
        command={command}
        canReopen={props.canReopen}
        mac={mac}
        onOpen={(open) => props.onCover("menu", open)}
        onList={(what) => list(what)(true)}
        onFind={props.onFind}
        onSignIns={props.onSignIns}
      />
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
