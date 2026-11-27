// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import * as Base64 from "effect/encoding/Base64";
import { useSyncExternalStore } from "react";

// The last picture of each tab this app showed, held in memory only while
// the app runs, for what shows a tab without watching it: a tab's card in
// the list of tabs, a bot's card once its task is over, and a frozen page.
// Nothing of a page is written to the device.

/** A tab's last picture, as an image source, and when it came. */
export interface LastPicture {
  readonly uri: string;
  readonly at: number;
}

/** How many tabs' pictures are kept: the newest, as a phone shows only a few at a time. */
const KEPT = 8;

const pictures = new Map<BrowserTabRef, LastPicture>();
const listeners = new Set<() => void>();

/** Keeps `jpeg` as the tab's last picture. */
export const keepPicture = (ref: BrowserTabRef, jpeg: Uint8Array, at: number): void => {
  pictures.delete(ref);
  pictures.set(ref, { uri: `data:image/jpeg;base64,${Base64.encode(jpeg)}`, at });
  for (const old of [...pictures.keys()].slice(0, Math.max(pictures.size - KEPT, 0))) {
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

/** The tab's last picture this app showed, null when it showed none. */
export const useLastPicture = (ref: BrowserTabRef | null): LastPicture | null =>
  useSyncExternalStore(subscribe, () => (ref === null ? null : (pictures.get(ref) ?? null)));
