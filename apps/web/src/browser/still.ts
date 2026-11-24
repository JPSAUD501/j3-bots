// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewSize } from "@j3-bots/client-runtime";
import type { BrowserTab, BrowserTabRef } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useBrowser } from "./context";
import { viewLockName } from "./kept";
import { viewQuality, viewSize, type Size } from "./input";
import { whileFree } from "./locks";
import { linkHint } from "./useTabView";
import { type BrowserSource, opening } from "./source";

/** How long a still waits for its picture before giving up. */
const STILL_TIMEOUT = 10_000;
/** How often a still is taken again while the bot works in the tab. */
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

/** The page's object URL for a picture, revoked once replaced or unmounted. */
const useObjectUrl = () => {
  const [url, setUrl] = useState<string | null>(null);
  // A still that arrives once the card is gone makes no URL, which nothing would revoke.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );
  return [
    url,
    (jpeg: Uint8Array) => {
      if (mounted.current) {
        setUrl(URL.createObjectURL(new Blob([jpeg.slice()], { type: "image/jpeg" })));
      }
    },
  ] as const;
};

/**
 * A still of `tab`, as an image URL: taken when the tab opens, navigates or
 * finishes loading, and every few seconds while `refresh` holds, but only
 * while `shown` (the still is on screen and the page in view). Never while
 * this device holds the tab: a still would take that view's place.
 */
export function useStill(
  tab: BrowserTab | null,
  box: Size | null,
  refresh: boolean,
  shown: boolean,
): string | null {
  const { source } = useBrowser();
  const [url, show] = useObjectUrl();
  const [tick, setTick] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    if (!refresh || !shown) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), STILL_EVERY);
    return () => window.clearInterval(timer);
  }, [refresh, shown]);

  const take = useEffectEvent(async () => {
    if (tab === null || box === null || busy.current || tab.controller === "you") return;
    busy.current = true;
    try {
      const jpeg = await takeStill(source, tab.ref, {
        ...viewSize(box, window.devicePixelRatio),
        quality: viewQuality(linkHint()),
      });
      if (jpeg !== null) show(jpeg);
    } finally {
      busy.current = false;
    }
  });
  // What calls for a new still: another tab, another page or the end of a load, and each tick.
  const due =
    tab === null || box === null || !shown ? null : `${tab.ref} ${tab.url} ${tab.loading} ${tick}`;
  useEffect(() => {
    if (due !== null) void take();
  }, [due]);
  return url;
}
