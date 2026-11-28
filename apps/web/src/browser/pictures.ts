// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import { useMemo, useSyncExternalStore } from "react";

// The last picture of each tab this page showed or took a still of, held in
// memory only while it is open, for what shows a tab without watching it: a
// tab's card in the list of tabs, a bot's card in its conversation, the
// little map of a zoomed page and a frozen page. Nothing of a page is
// written to storage.

/** A tab's last picture, as an object URL, when it came, and the address of the page it shows. */
export interface LastPicture {
  readonly url: string;
  readonly at: number;
  readonly page: string;
}

/**
 * How many tabs' pictures are kept beyond those on screen: the newest, as a
 * narrow screen shows only a few at a time.
 */
const KEPT = 8;

const pictures = new Map<BrowserTabRef, LastPicture>();
const listeners = new Set<() => void>();

/**
 * Keeps `jpeg`, a picture of the page at `page`, as the tab's last picture;
 * the one it replaces, and the oldest past the newest few that nothing
 * shows, go.
 */
export const keepPicture = (
  ref: BrowserTabRef,
  jpeg: Uint8Array,
  at: number,
  page: string,
): void => {
  const before = pictures.get(ref);
  if (before !== undefined) URL.revokeObjectURL(before.url);
  pictures.delete(ref);
  pictures.set(ref, {
    url: URL.createObjectURL(new Blob([jpeg.slice()], { type: "image/jpeg" })),
    at,
    page,
  });
  const spare = [...pictures.keys()].filter((each) => !shownBy.has(each));
  for (const old of spare.slice(0, Math.max(pictures.size - KEPT, 0))) {
    const gone = pictures.get(old);
    if (gone !== undefined) URL.revokeObjectURL(gone.url);
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

/** The tab's last picture this page showed, null when it showed none; kept while this shows it. */
export const useLastPicture = (ref: BrowserTabRef | null): LastPicture | null => {
  const subscribe = useMemo(() => subscribeTo(ref), [ref]);
  return useSyncExternalStore(
    subscribe,
    () => (ref === null ? null : (pictures.get(ref) ?? null)),
    () => null,
  );
};

/**
 * The tab's last picture, only while it shows the page the tab is on: a
 * picture of the page before, or of nothing yet, is null.
 */
export const usePictureOfPage = (tab: {
  readonly ref: BrowserTabRef | null;
  readonly url: string;
}): LastPicture | null => {
  const last = useLastPicture(tab.ref);
  return last !== null && last.page === tab.url ? last : null;
};
