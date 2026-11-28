// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewSize, BrowserViewStatus, J3Client } from "@j3-bots/client-runtime";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { BrowserTabRef } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { PixelRatio } from "react-native";
import { keepPicture, type LastPicture, usePictureOfPage } from "./pictures.ts";

// A still of a tab nobody here watches: its first picture, for its card in
// the list of tabs. This device has one viewer per tab on the server, and a
// socket it opens on a tab takes the place of its view of it, so a still is
// never taken of a tab this device views or holds.

/** How long a still waits for its picture before giving up. */
const STILL_TIMEOUT = 10_000;
/** A card's picture is small: it is taken at a lower quality than a page's. */
const STILL_QUALITY = 50;

/** Whether a view's socket has ended for good: nothing more comes on it. */
const ended = (status: BrowserViewStatus): boolean => {
  switch (status._tag) {
    case "connecting":
    case "live":
    case "reconnecting":
    case "paused":
      return false;
    case "gone":
    case "setup-needed":
    case "replaced":
    case "failed":
      return true;
  }
};

/** One picture of a tab: opens a view, keeps the first picture it is sent and closes it. Null when none came. */
const takeStill = (
  client: J3Client,
  ref: BrowserTabRef,
  size: BrowserViewSize,
): Promise<Uint8Array | null> =>
  new Promise((resolve) => {
    const view = client.openBrowserView({ ref, size: () => size });
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
      view.state.subscribe(() => {
        if (ended(view.state.get().status)) finish(null);
      }),
    );
    const timer = setTimeout(() => finish(null), STILL_TIMEOUT);
    stops.push(() => clearTimeout(timer));
  });

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
  /** This device views or holds the tab: a still would take that view's place. */
  readonly viewedHere: boolean;
}

/**
 * The last picture of the page `tab` is on, null while there is none: what
 * a view of it in this app showed last, or a still of it, taken `width`
 * points wide while `shown`, as the tab navigates and finishes loading.
 */
export function useStill(tab: StillTab, width: number, shown: boolean): LastPicture | null {
  const client = useJ3Client();
  const busy = useRef(false);
  // A still that waits its turn once the card is gone opens no socket.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const take = useEffectEvent(async () => {
    if (busy.current || tab.viewedHere || width <= 0) return;
    const { ref, url } = tab;
    const size = { maxWidth: PixelRatio.getPixelSizeForLayoutSize(width), quality: STILL_QUALITY };
    busy.current = true;
    try {
      const jpeg = await inTurn(() =>
        mounted.current ? takeStill(client, ref, size) : Promise.resolve(null),
      );
      if (jpeg !== null) keepPicture(ref, jpeg, Date.now(), url);
    } finally {
      busy.current = false;
    }
  });
  // What calls for a new still: another tab, another page and the end of a load.
  const due = !shown || width <= 0 ? null : `${tab.ref} ${tab.url} ${tab.loading}`;
  useEffect(() => {
    if (due !== null) void take();
  }, [due]);
  return usePictureOfPage(tab);
}
