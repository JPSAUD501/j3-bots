// SPDX-License-Identifier: AGPL-3.0-or-later
import { oneAtATime, takeStill } from "@j3-bots/client-runtime";
import type { BrowserTabRef } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useBrowser } from "./context";
import { viewLockName } from "./kept";
import { viewQuality, viewSize, type Size } from "./input";
import { whileFree } from "./locks";
import { keepPicture, type LastPicture, usePictureOfPage } from "./pictures";
import { linkHint } from "./useTabView";

// A still of a tab is taken only while no view of it is open in this browser:
// a device has one viewer per tab on the server, and its newer socket takes
// the older's place. A still holds the tab's lock alone (`whileFree`), so it
// is skipped while a view holds it, and stopped as one opens.

/** How often a still is taken again while bots work in the tab. */
const STILL_EVERY = 5_000;

/** Stills are taken one after another, so a list of tabs opens one socket at a time. */
const inTurn = oneAtATime();

/** The tab a still is of, as far as taking one goes. */
export interface StillTab {
  readonly ref: BrowserTabRef;
  readonly url: string;
  readonly loading: boolean;
  /** This device holds the tab: a still would take its view's place. */
  readonly heldHere: boolean;
}

/**
 * The last picture of the page `tab` is on, null while there is none: what
 * a view of it in this page showed last, or a still of it. A still is taken
 * while `shown` (on screen, in a page in view) as it appears, as the tab
 * navigates, finishes loading or its `activity` changes, and every few
 * seconds while `refresh` holds; one due while another is under way is taken
 * once that one ends. Each goes among the tabs' last pictures, with the
 * address the tab had as it was taken, so every card of the tab shows it.
 */
export function useStill(
  tab: StillTab | null,
  box: Size | null,
  options: { readonly shown: boolean; readonly refresh: boolean; readonly activity: string },
): LastPicture | null {
  const { shown, refresh, activity } = options;
  const { source } = useBrowser();
  const [tick, setTick] = useState(0);
  const busy = useRef(false);
  /** A still came due while one was under way. */
  const again = useRef(false);
  // A still that waits its turn once the card is gone opens no socket, and one under way stops.
  const mounted = useRef(false);
  const running = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      running.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!refresh || !shown) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), STILL_EVERY);
    return () => window.clearInterval(timer);
  }, [refresh, shown]);

  // The tab as it is when a still's turn comes.
  const now = useEffectEvent(() =>
    tab === null || box === null || !shown || tab.heldHere ? null : { tab, box },
  );
  const take = useEffectEvent(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const kept = await inTurn(async () => {
        const at = now();
        if (at === null || !mounted.current) return null;
        const { ref, url } = at.tab;
        const size = {
          ...viewSize(at.box, window.devicePixelRatio),
          quality: viewQuality(linkHint()),
        };
        const jpeg = await whileFree(viewLockName(ref), (lockStop) => {
          // Stopped as a view of the tab comes, or the card goes.
          const mine = new AbortController();
          lockStop.addEventListener("abort", () => mine.abort(), { once: true });
          running.current = mine;
          return takeStill(source.openBrowserView, ref, size, mine.signal).finally(() => {
            if (running.current === mine) running.current = null;
          });
        });
        return jpeg === null ? null : { ref, url, jpeg };
      });
      if (kept !== null) keepPicture(kept.ref, kept.jpeg, Date.now(), kept.url);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void take();
      }
    }
  });
  // What calls for a new still: another tab, another page, the end of a load, the bots' turn, and each tick.
  const due =
    tab === null || box === null || !shown
      ? null
      : `${tab.ref} ${tab.url} ${tab.loading} ${activity} ${tick}`;
  useEffect(() => {
    if (due !== null) void take();
  }, [due]);
  return usePictureOfPage(tab ?? NO_TAB);
}

/** No tab: its page has no picture. */
const NO_TAB = { ref: null, url: "" } as const;

/** The size of `element`'s content box, null until it is measured. */
export function useBoxOf(element: HTMLElement | null): Size | null {
  const [box, setBox] = useState<Size | null>(null);
  useEffect(() => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setBox((previous) =>
        previous !== null && previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return box;
}
