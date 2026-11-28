// SPDX-License-Identifier: AGPL-3.0-or-later
import { oneAtATime, takeStill } from "@j3-bots/client-runtime";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { BrowserTabRef } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { PixelRatio } from "react-native";
import { keepPicture, type LastPicture, usePictureOfPage } from "./pictures.ts";

// A still of a tab nobody here watches, for its card in the list of tabs.
// This device has one viewer per tab on the server, and a socket it opens on
// a tab takes the place of its view of it, so a still is never taken of a
// tab this device views or holds, and one under way stops as it comes to.

/** A card's picture is small: it is taken at a lower quality than a page's. */
const STILL_QUALITY = 50;

/** Stills are taken one after another, so a list of tabs opens one socket at a time. */
const inTurn = oneAtATime();

/** The tab a still is of, as far as taking one goes. */
export interface StillTab {
  readonly ref: BrowserTabRef;
  readonly url: string;
  readonly loading: boolean;
  /** This device views or holds the tab: a still would take that view's place. */
  readonly viewedHere: boolean;
}

/**
 * The last picture of the page `tab` is on, null while there is none: what
 * a view of it in this app showed last, or a still of it, taken `width`
 * points wide while `shown`, as the tab navigates and finishes loading; one
 * due while another is under way is taken once that one ends. Each is kept
 * with the address the tab had as it was taken.
 */
export function useStill(tab: StillTab, width: number, shown: boolean): LastPicture | null {
  const client = useJ3Client();
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
  // The tab shown or held here now: a still of it would take the place of its view.
  useEffect(() => {
    if (tab.viewedHere) running.current?.abort();
  }, [tab.viewedHere]);

  // The tab as it is when a still's turn comes.
  const now = useEffectEvent(() =>
    !shown || width <= 0 || tab.viewedHere ? null : { tab, width },
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
          maxWidth: PixelRatio.getPixelSizeForLayoutSize(at.width),
          quality: STILL_QUALITY,
        };
        const mine = new AbortController();
        running.current = mine;
        try {
          const jpeg = await takeStill(client.openBrowserView, ref, size, mine.signal);
          return jpeg === null ? null : { ref, url, jpeg };
        } finally {
          if (running.current === mine) running.current = null;
        }
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
  // What calls for a new still: another tab, another page and the end of a load.
  const due = !shown || width <= 0 ? null : `${tab.ref} ${tab.url} ${tab.loading}`;
  useEffect(() => {
    if (due !== null) void take();
  }, [due]);
  return usePictureOfPage(tab);
}
