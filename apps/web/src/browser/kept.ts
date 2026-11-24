// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewHandle } from "@j3-bots/client-runtime";
import type { BrowserTabRef } from "@j3-bots/contracts";
import { holdLock } from "./locks";
import { holds } from "./source";

/** A name for the lock a view holds on a tab, so no still of it opens in any window meanwhile. */
export const viewLockName = (ref: BrowserTabRef) => `j3-browser-view:${ref}`;

/**
 * The tabs a window holds while nobody looks at them: the operator kept
 * control and left the viewer, or followed a pop-up out of it. A kept view's
 * socket stays open so the tab stays theirs, and no still of it opens. It
 * closes once the tab is no longer this device's: the tab closed, someone
 * else took it, or the next view of it this device opened took its place on
 * the server, control included.
 */
export interface KeptViews {
  /** Keeps `view`'s socket open, and the tab with it, while the tab is this device's. */
  readonly keep: (ref: BrowserTabRef, view: BrowserViewHandle) => void;
  /**
   * Makes way for a new view of `ref` this window opens. A kept view whose
   * socket is live needs nothing: the new socket takes its place. One that is
   * connecting again is closed, or the two would race to be the tab's last.
   */
  readonly makeWay: (ref: BrowserTabRef) => void;
  /** Closes every kept view, as when the shell goes away. */
  readonly dropAll: () => void;
}

export function keptViews(): KeptViews {
  const kept = new Map<
    BrowserTabRef,
    { readonly view: BrowserViewHandle; readonly stop: () => void }
  >();
  const drop = (ref: BrowserTabRef) => {
    const found = kept.get(ref);
    if (found === undefined) return;
    kept.delete(ref);
    found.stop();
    found.view.close();
  };
  return {
    keep: (ref, view) => {
      drop(ref);
      // Already open: the lock only keeps stills away.
      const unlock = holdLock(viewLockName(ref), () => {});
      const stopState = view.state.subscribe(() => {
        if (!holds(view.state.get())) drop(ref);
      });
      kept.set(ref, {
        view,
        stop: () => {
          stopState();
          unlock();
        },
      });
      if (!holds(view.state.get())) drop(ref);
    },
    makeWay: (ref) => {
      const found = kept.get(ref);
      if (found !== undefined && found.view.state.get().status._tag !== "live") drop(ref);
    },
    dropAll: () => {
      for (const ref of kept.keys()) drop(ref);
    },
  };
}
