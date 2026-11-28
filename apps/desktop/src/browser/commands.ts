// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import type { BrowserPlace, DesktopBrowserCommand, DesktopDownload } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import { type DownloadItem, shell, type WebContents } from "electron";
import { typedAddress } from "./address.ts";
import type { DesktopBrowser } from "./host.ts";
import type { Places } from "./places.ts";

// What the person asks of the browser from the app's windows: the toolbar,
// the menu, the tab strip and the shortcuts.

/** The zoom steps a browser takes, in percent. */
const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

/** The zoom step after `current` in the direction asked, or 100. */
const zoomTo = (current: number, to: "in" | "out" | "reset") => {
  if (to === "reset") return 100;
  const steps = to === "in" ? ZOOM_STEPS : ZOOM_STEPS.toReversed();
  return steps.find((step) => (to === "in" ? step > current : step < current)) ?? current;
};

/** Zooms the page a step in or out, or back to 100%. */
export const zoomPage = (contents: WebContents, to: "in" | "out" | "reset") => {
  // The zoom holds for the page's whole site, as Chromium keeps it per host.
  const current = Math.round(contents.getZoomFactor() * 100);
  contents.setZoomFactor(zoomTo(current, to) / 100);
};

/** A download the list shows, with the file behind it. */
interface Download {
  readonly item: DownloadItem;
  readonly entry: DesktopDownload;
  /** Where a bot's file went once it became the person's. */
  readonly handedOver: string | null;
}

/** Carries out the person's commands on `browser`. */
export const makeCommand = (options: {
  readonly browser: DesktopBrowser;
  readonly places: Places;
  readonly downloads: ReadonlyMap<string, Download>;
  /** Shows the tab in front in `place`, opening the browser's window for it. */
  readonly show: (ref: BrowserTabRef, place: BrowserPlace) => void;
  readonly closeWindow: () => void;
  readonly changed: () => void;
  readonly runFork: (effect: Effect.Effect<void>) => void;
}): ((asked: DesktopBrowserCommand) => void) => {
  const { browser, places, downloads, show, runFork } = options;
  const command = (asked: DesktopBrowserCommand) => {
    const used = (ref: BrowserTabRef) => runFork(browser.personUsed(ref));
    switch (asked._tag) {
      case "open": {
        const { input, place } = asked;
        runFork(
          Effect.gen(function* () {
            const tab = yield* browser.openForPerson({ private: asked.private });
            places.openedInPlace(tab.ref, tab.private, place);
            show(tab.ref, place);
            if (input !== undefined && input.trim() !== "") {
              tab.contents.loadURL(typedAddress(input)).catch(() => undefined);
            }
          }).pipe(Effect.catch((error) => Effect.logWarning("Opening a tab failed", error))),
        );
        return;
      }
      case "reopen": {
        const last = places.reopen();
        if (last === undefined) return;
        command({ _tag: "open", input: last.url, private: false, place: asked.place });
        return;
      }
      case "closeWindow":
        options.closeWindow();
        return;
      case "openDownload":
      case "showDownload":
      case "cancelDownload": {
        const download = downloads.get(asked.id);
        if (download === undefined) return;
        if (asked._tag === "cancelDownload") download.item.cancel();
        else if (download.entry.inDownloads && download.entry.state === "completed") {
          // Only files in the person's downloads folder: a bot's is the server's.
          const file = download.handedOver ?? download.item.getSavePath();
          if (asked._tag === "showDownload") shell.showItemInFolder(file);
          else void shell.openPath(file);
        }
        return;
      }
      default:
        break;
    }
    const tab = browser.tab(asked.tab);
    if (tab === undefined || tab.contents.isDestroyed()) return;
    const { contents } = tab;
    switch (asked._tag) {
      case "close":
        runFork(browser.close(asked.tab));
        return;
      case "show":
        show(asked.tab, asked.place);
        return;
      case "go":
        used(asked.tab);
        contents.loadURL(typedAddress(asked.input)).catch(() => undefined);
        return;
      case "back":
        used(asked.tab);
        contents.navigationHistory.goBack();
        return;
      case "forward":
        used(asked.tab);
        contents.navigationHistory.goForward();
        return;
      case "reload": {
        used(asked.tab);
        const failed = places.at(asked.tab)?.failed ?? null;
        if (failed === null) contents.reload();
        else contents.loadURL(failed).catch(() => undefined);
        return;
      }
      case "stop":
        contents.stop();
        return;
      case "zoom":
        zoomPage(contents, asked.to);
        options.changed();
        return;
      case "find": {
        // Finding is looking, not using the page: the bots go on.
        const at = places.at(asked.tab);
        if (at === undefined || asked.text === "") return;
        const again = at.finding === asked.text;
        at.finding = asked.text;
        contents.findInPage(asked.text, { forward: asked.forward, findNext: !again });
        return;
      }
      case "stopFinding": {
        const at = places.at(asked.tab);
        if (at !== undefined) at.finding = "";
        contents.stopFindInPage("keepSelection");
        return;
      }
      case "print":
        contents.print();
        return;
    }
  };
  return command;
};
