// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, BrowserTab } from "@j3-bots/contracts";
import { GlobeIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "../app/context";
import { useBrowser, useBrowserTabs } from "./context";
import { Faces } from "./Faces";
import { useWaitingBots } from "./waiting";
import { preloadBrowserViewer } from "./live/slots";
import { useBoxOf, useStill } from "./still";
import { TabPlaceholder } from "./TabPlaceholder";
import { botViewerTab, frontTab, siteOf, tabFaces } from "@j3-bots/client-runtime/presentation";

/** Whether the bot's turn is using its browser right now, as its state says. */
export const actsInBrowser = (bot: Bot): boolean =>
  bot.state._tag === "working" && bot.state.tool === "browser" && !bot.state.stalled;

/**
 * In the running turn's row, while the bot has a tab: the last picture of
 * its front tab's page, with the site's name and the faces of the bots on
 * it, never a live picture. A still is taken as the card shows, as the tab
 * navigates, as each action on it ends, and every few seconds while bots work
 * on it; the viewer's own pictures show here while it is open. Until there is
 * a picture of the page the tab is on, its title and site stand in its place.
 * Pressing it opens the viewer.
 */
export function BrowserPanel({
  bot,
  onOpen,
}: {
  readonly bot: Bot;
  readonly onOpen: (tab: BrowserTab) => void;
}) {
  const tabs = useBrowserTabs(bot.id);
  const tab = tabs === null ? null : frontTab(tabs);
  const hasTab = tab !== null;
  useEffect(() => {
    if (hasTab) preloadBrowserViewer();
  }, [hasTab]);
  if (tab === null) return null;
  return <Panel tab={tab} working={bot.state._tag === "working"} onOpen={() => onOpen(tab)} />;
}

function Panel({
  tab,
  working,
  onOpen,
}: {
  readonly tab: BrowserTab;
  readonly working: boolean;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const box = useBoxOf(frame);
  const shown = useShown(frame);
  const { source } = useBrowser();
  const here = useSyncExternalStore(source.pairing.subscribe, source.pairing.get);
  const viewer = botViewerTab(tab, here);
  // Bots are at work on the page while one acts or holds it between its actions. A server from
  // before shared tabs says neither, and its one bot holds its tab: there, while the bot's turn works.
  const atWork =
    tab.heldBy === undefined
      ? working && tab.controller === "bot"
      : viewer.acting !== null || viewer.holder._tag === "bot";
  const picture = useStill(
    { ref: tab.ref, url: tab.url, loading: tab.loading, heldHere: tab.controller === "you" },
    box,
    {
      shown,
      refresh: atWork,
      // Each action's end, and the tab given back, change the page: a still then shows it as it is.
      activity: `${viewer.acting ?? ""} ${viewer.holder._tag}`,
    },
  );
  const site = siteOf(tab.url) || t("browser.panel.newTab");
  const faces = tabFaces(viewer, useWaitingBots());
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("browser.panel.open", { site })}
      className="pressable group mt-2 ms-8.5 flex w-[min(100%_-_2.125rem,22rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface text-start shadow-raised outline-none hover:border-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span ref={setFrame} className="relative block aspect-[16/10] w-full bg-muted">
        {picture === null ? (
          <TabPlaceholder title={tab.title} url={tab.url} />
        ) : (
          <img
            src={picture.url}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full object-cover object-top"
          />
        )}
      </span>
      <span className="flex min-h-8 items-center gap-1.5 border-t border-border px-2.5 text-2xs">
        <GlobeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{site}</span>
        <Faces faces={faces} size={18} className="ms-auto" />
      </span>
    </button>
  );
}

/** Whether `element` is on screen in a page that is in view. */
function useShown(element: HTMLElement | null): boolean {
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (element === null) return;
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry?.isIntersecting ?? false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return inView && visible;
}
