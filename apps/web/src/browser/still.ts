// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewSize } from "@j3-bots/client-runtime";
import type { BrowserTabRef } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useBrowser } from "./context";
import { viewLockName } from "./kept";
import { viewQuality, viewSize, type Size } from "./input";
import { whileFree } from "./locks";
import { keepPicture, type LastPicture, usePictureOfPage } from "./pictures";
import { linkHint } from "./useTabView";
import { type BrowserSource, opening } from "./source";

/** How long a still waits for its picture before giving up. */
const STILL_TIMEOUT = 10_000;
/** How often a still is taken again while bots work in the tab. */
const STILL_EVERY = 5_000;

/**
 * One picture of a tab: opens a socket, keeps the first picture it is sent and
 * closes it. Null when no picture came, or when a view of the tab is open in
 * some window, whose socket a still's would take the place of, or opens
 * meanwhile.
 */
const takeStill = (
  source: BrowserSource,
  ref: BrowserTabRef,
  size: BrowserViewSize,
): Promise<Uint8Array | null> =>
  whileFree(
    viewLockName(ref),
    (stop) =>
      new Promise<Uint8Array | null>((resolve) => {
        const view = source.openBrowserView({ ref, size: () => size });
        let done = false;
        const stops: Array<() => void> = [];
        const finish = (jpeg: Uint8Array | null) => {
          if (done) return;
          done = true;
          for (const stop of stops) stop();
          view.close();
          resolve(jpeg);
        };
        stops.push(
          view.picture.subscribe(() => {
            const picture = view.picture.get();
            if (picture !== null) finish(picture.jpeg);
          }),
        );
        stops.push(
          view.state.subscribe(() => {
            if (!opening(view.state.get())) finish(null);
          }),
        );
        const timer = window.setTimeout(() => finish(null), STILL_TIMEOUT);
        stops.push(() => window.clearTimeout(timer));
        // A view of the tab is coming: its socket must open after this one closed.
        const stopNow = () => finish(null);
        stop.addEventListener("abort", stopNow);
        stops.push(() => stop.removeEventListener("abort", stopNow));
      }),
  );

/** Stills are taken one after another, so a list of tabs opens one socket at a time. */
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <A>(run: () => Promise<A>): Promise<A> => {
  const next = turn.then(run);
  turn = next.catch(() => undefined);
  return next;
};

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
 * seconds while `refresh` holds. Each goes among the tabs' last pictures, so
 * every card of the tab shows it.
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
  // A still that waits its turn once the card is gone opens no socket.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!refresh || !shown) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), STILL_EVERY);
    return () => window.clearInterval(timer);
  }, [refresh, shown]);

  const take = useEffectEvent(async () => {
    if (tab === null || box === null || busy.current || tab.heldHere) return;
    const { ref, url } = tab;
    const size = { ...viewSize(box, window.devicePixelRatio), quality: viewQuality(linkHint()) };
    busy.current = true;
    try {
      const jpeg = await inTurn(() =>
        mounted.current ? takeStill(source, ref, size) : Promise.resolve(null),
      );
      if (jpeg !== null) keepPicture(ref, jpeg, Date.now(), url);
    } finally {
      busy.current = false;
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
