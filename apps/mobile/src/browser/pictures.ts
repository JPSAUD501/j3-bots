// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import * as Base64 from "effect/encoding/Base64";
import { useMemo, useSyncExternalStore } from "react";

// The last picture of each tab this app showed or took a still of, held in
// memory only while the app runs, for what shows a tab without watching it:
// a tab's card in the list of tabs, a bot's card once its task is over, and
// a frozen page. Nothing of a page is written to the device.

/** A tab's last picture, as an image source, when it came, and the address of the page it shows. */
export interface LastPicture {
  readonly uri: string;
  readonly at: number;
  readonly page: string;
}

/** How many tabs' pictures are kept beyond those on screen: the newest, as a phone shows only a few at a time. */
const KEPT = 8;

const pictures = new Map<BrowserTabRef, LastPicture>();
const listeners = new Set<() => void>();

/**
 * Keeps `jpeg`, a picture of the page at `page`, as the tab's last picture;
 * the oldest past the newest few that nothing shows go.
 */
export const keepPicture = (
  ref: BrowserTabRef,
  jpeg: Uint8Array,
  at: number,
  page: string,
): void => {
  pictures.delete(ref);
  pictures.set(ref, { uri: `data:image/jpeg;base64,${Base64.encode(jpeg)}`, at, page });
  const spare = [...pictures.keys()].filter((each) => !shownBy.has(each));
  for (const old of spare.slice(0, Math.max(pictures.size - KEPT, 0))) {
    pictures.delete(old);
  }
  for (const listener of listeners) listener();
};

/** How many cards and views show each tab's picture now: a picture on screen is never let go. */
const shownBy = new Map<BrowserTabRef, number>();

/** A subscription to the pictures that counts `ref`'s as shown while it lasts. */
const subscribeTo = (ref: BrowserTabRef | null) => (listener: () => void) => {
  listeners.add(listener);
  if (ref !== null) shownBy.set(ref, (shownBy.get(ref) ?? 0) + 1);
  return () => {
    listeners.delete(listener);
    if (ref === null) return;
    const left = (shownBy.get(ref) ?? 1) - 1;
    if (left === 0) shownBy.delete(ref);
    else shownBy.set(ref, left);
  };
};

/** The tab's last picture this app showed, null when it showed none; kept while this shows it. */
export const useLastPicture = (ref: BrowserTabRef | null): LastPicture | null => {
  const subscribe = useMemo(() => subscribeTo(ref), [ref]);
  return useSyncExternalStore(subscribe, () => (ref === null ? null : (pictures.get(ref) ?? null)));
};

/**
 * The tab's last picture, only while it shows the page the tab is on: a
 * picture of the page before, or of nothing yet, is null.
 */
export const usePictureOfPage = (tab: {
  readonly ref: BrowserTabRef;
  readonly url: string;
}): LastPicture | null => {
  const last = useLastPicture(tab.ref);
  return last !== null && last.page === tab.url ? last : null;
};
