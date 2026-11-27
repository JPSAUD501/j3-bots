// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewHandle } from "@j3-bots/client-runtime";
import { botsTab, siteOf, tabFaces, type ViewerTab } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { AppWindowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/context";
import { BotCursors } from "../BotCursors";
import { useBrowser, useViewerTabs } from "../context";
import { Faces } from "../Faces";
import { viewSize, type Size } from "../input";
import { viewLockName } from "../kept";
import { whileFree } from "../locks";
import { opening } from "../source";
import { useWaitingBots } from "../waiting";
import { keepPicture, useLastPicture } from "./pictures";

/** The card's picture at most this tall, as a photo in the conversation is. */
const CARD_HEIGHT = 220;
/** The card asks for a small picture, at a quality that is enough for one. */
const CARD_QUALITY = 50;
/** How long the card waits to look again once a view of the tab took its place. */
const LOOK_AGAIN_MS = 5_000;

/** The tab the bot is on now, or null while it is on none. */
function useBotsTab(botId: BotId): ViewerTab | null {
  const { tabs } = useViewerTabs(botId);
  return tabs === null ? null : botsTab(tabs, botId);
}

/**
 * At the end of a bot's conversation while it browses, as on the phone: the
 * page in small, live, with its pointer, and under it the site and the faces
 * of the bots on the tab. A press opens the live view. Once the bot leaves
 * the tab, the card stays as a still picture of the last page, until the
 * conversation is opened again.
 */
export function LiveCard({
  botId,
  onOpen,
}: {
  readonly botId: BotId;
  readonly onOpen: (ref: BrowserTabRef) => void;
}) {
  const tab = useBotsTab(botId);
  // The last tab the card showed, which stays as a still picture once the bot is done.
  const [last, setLast] = useState<ViewerTab | null>(tab);
  if (tab !== null && tab !== last) setLast(tab);
  const shown = tab ?? last;
  if (shown === null) return null;
  return <Card tab={shown} live={tab !== null} onOpen={() => onOpen(shown.ref)} />;
}

function Card({
  tab,
  live,
  onOpen,
}: {
  readonly tab: ViewerTab;
  readonly live: boolean;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const waitsForPerson = useWaitingBots();
  const site = siteOf(tab.url);
  return (
    <div className="py-2">
      <button
        type="button"
        aria-label={t("browser.card.open", { site: site || tab.title })}
        onClick={onOpen}
        className="block w-full overflow-hidden rounded-xl border border-border bg-surface text-start transition-transform duration-(--duration-state) ease-out focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.99]"
      >
        <Picture tab={tab} live={live} />
        <span className="flex min-h-11 items-center gap-2 px-3 py-2">
          <AppWindowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{site || tab.title}</span>
          {live && <span className="text-xs text-muted-foreground">{t("browser.card.live")}</span>}
          <Faces faces={tabFaces(tab, waitsForPerson)} size={20} />
        </span>
      </button>
    </div>
  );
}

/** Whether `element` is on screen, in a page in front. */
function useOnScreen(element: HTMLElement | null): boolean {
  const [seen, setSeen] = useState(false);
  const [front, setFront] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    if (element === null) return;
    const observer = new IntersectionObserver(([entry]) => setSeen(entry?.isIntersecting ?? false));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  useEffect(() => {
    const change = () => setFront(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return seen && front;
}

/**
 * A view of `ref` at the card's size while `on`, but only while no other
 * view of the tab is open in this browser: a view that comes takes its
 * place at once (`whileFree`), and the card looks again a little later.
 */
function useGlimpse(ref: BrowserTabRef, size: Size | null, on: boolean): BrowserViewHandle | null {
  const { source } = useBrowser();
  const [view, setView] = useState<BrowserViewHandle | null>(null);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  useEffect(() => {
    if (!on || width === 0) return;
    const unmounted = new AbortController();
    let timer: number | undefined;
    const look = () =>
      void whileFree(
        viewLockName(ref),
        (stop) =>
          new Promise<void>((resolve) => {
            const opened = source.openBrowserView({
              ref,
              size: () => ({
                ...viewSize({ width, height }, window.devicePixelRatio),
                quality: CARD_QUALITY,
              }),
            });
            setView(opened);
            const stopState = opened.state.subscribe(() => {
              if (!opening(opened.state.get())) finish();
            });
            function finish() {
              stopState();
              stop.removeEventListener("abort", finish);
              unmounted.signal.removeEventListener("abort", finish);
              setView(null);
              opened.close();
              resolve();
            }
            stop.addEventListener("abort", finish);
            unmounted.signal.addEventListener("abort", finish);
          }),
      ).then(() => {
        if (!unmounted.signal.aborted) timer = window.setTimeout(look, LOOK_AGAIN_MS);
      });
    look();
    return () => {
      window.clearTimeout(timer);
      unmounted.abort();
    };
  }, [source, ref, on, width, height]);
  return view;
}

/**
 * The page, live while the bot is on it and the card is on screen, as the
 * newest picture with the bots' pointers over it; otherwise the last
 * picture this page showed.
 */
function Picture({ tab, live }: { readonly tab: ViewerTab; readonly live: boolean }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const onScreen = useOnScreen(element);
  const [page, setPage] = useState<Size | null>(null);
  const height =
    page === null || width === 0
      ? CARD_HEIGHT
      : Math.min(CARD_HEIGHT, (width * page.height) / page.width);
  // Asked for at the card's width and tallest height, so the page's shape changes nothing asked.
  const view = useGlimpse(
    tab.ref,
    width === 0 ? null : { width, height: CARD_HEIGHT },
    live && onScreen,
  );
  const last = useLastPicture(tab.ref);
  useEffect(() => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  useEffect(() => {
    if (view === null) return;
    const stops = [
      view.picture.subscribe(() => {
        const picture = view.picture.get();
        if (picture === null) return;
        keepPicture(tab.ref, picture.jpeg, Date.now());
        // A card shows only the newest picture: the next may come at once.
        view.ack(picture.sequence);
      }),
      view.state.subscribe(() => setPage(view.state.get().viewport)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [view, tab.ref]);
  // The picture is drawn whole, in its own shape, inside the card's.
  const drawn =
    page === null || width === 0
      ? null
      : (() => {
          const scale = Math.min(width / page.width, height / page.height);
          const shown = { width: page.width * scale, height: page.height * scale };
          return { ...shown, left: (width - shown.width) / 2, top: (height - shown.height) / 2 };
        })();
  return (
    <span
      ref={setElement}
      aria-hidden
      className="relative block w-full bg-muted"
      style={{ height }}
    >
      {last !== null && (
        <img src={last.url} alt="" className="absolute inset-0 size-full object-contain" />
      )}
      {view !== null && drawn !== null && page !== null && (
        <span
          className="pointer-events-none absolute"
          style={{ left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height }}
        >
          <BotCursors view={view} viewport={page} onIt={tab.onIt} faded={false} />
        </span>
      )}
    </span>
  );
}

/**
 * "See the browser", over the top of a conversation scrolled away from its
 * end, where the live card is, while the bot browses.
 */
export function BrowserPill({
  botId,
  shown,
  onOpen,
}: {
  readonly botId: BotId;
  readonly shown: boolean;
  readonly onOpen: (ref: BrowserTabRef) => void;
}) {
  const { t } = useI18n();
  const tab = useBotsTab(botId);
  if (tab === null || !shown) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <button
        type="button"
        onClick={() => onOpen(tab.ref)}
        className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-pill border border-border bg-surface px-4 text-sm font-medium shadow-overlay focus-visible:outline-2 focus-visible:outline-accent"
      >
        <AppWindowIcon aria-hidden className="size-4" />
        {t("browser.pill")}
      </button>
    </div>
  );
}
