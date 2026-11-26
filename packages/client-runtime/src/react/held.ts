// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Readable } from "../Store.ts";

/** A handle a hook holds, and lets go of with `release`. */
export type Releasable = { readonly release: () => void };

/**
 * `open()`'s handle while the readable is watched, and null while it is not:
 * watching opens a handle and says so, and stopping releases it. This is how
 * `useHeld` holds a handle with `useSyncExternalStore`, for exactly the
 * renders React commits.
 */
export const holding = <H extends Releasable>(open: () => H): Readable<H | null> => {
  let handle: H | null = null;
  return {
    get: () => handle,
    subscribe: (listener) => {
      const opened = open();
      handle = opened;
      listener();
      return () => {
        if (handle === opened) handle = null;
        opened.release();
      };
    },
  };
};
