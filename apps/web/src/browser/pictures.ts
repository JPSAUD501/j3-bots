// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import { useSyncExternalStore } from "react";

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

/** How many tabs' pictures are kept: the newest, as a narrow screen shows only a few at a time. */
const KEPT = 8;

const pictures = new Map<BrowserTabRef, LastPicture>();
const listeners = new Set<() => void>();

/**
 * Keeps `jpeg`, a picture of the page at `page`, as the tab's last picture;
 * the one it replaces, and any past the newest few, go.
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
  for (const old of [...pictures.keys()].slice(0, Math.max(pictures.size - KEPT, 0))) {
    const gone = pictures.get(old);
    if (gone !== undefined) URL.revokeObjectURL(gone.url);
    pictures.delete(old);
  }
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The tab's last picture this page showed, null when it showed none. */
export const useLastPicture = (ref: BrowserTabRef | null): LastPicture | null =>
  useSyncExternalStore(
    subscribe,
    () => (ref === null ? null : (pictures.get(ref) ?? null)),
    () => null,
  );

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
