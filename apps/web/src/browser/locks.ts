// SPDX-License-Identifier: AGPL-3.0-or-later

// A device has one viewer per tab on the server, and its next socket on the
// tab takes that viewer's place, control included. So a still, which opens a
// socket for one picture, must never be open once a view of the same tab
// opens, in any window of this browser. Views hold the tab's Web Lock shared,
// so several windows may view one tab; a still takes it alone, and only when
// it is free. A view that comes while a still is open first stops the still,
// here at once and in other windows by a message, and opens its socket only
// once the lock is granted, that is once the still's socket closed. Without
// Web Locks a window still keeps its own stills and views apart.

/** The locks this window's views hold, each with how many hold it. */
const held = new Map<string, number>();
/** How to stop each still this window has open, by lock. */
const stills = new Map<string, Set<() => void>>();

const channel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("j3-browser-locks");
channel?.addEventListener("message", (event) => {
  if (typeof event.data === "string") stopStills(event.data);
});

function stopStills(name: string) {
  for (const stop of stills.get(name) ?? []) stop();
}

/**
 * Holds the lock `name` for a view until the returned function is called, and
 * calls `onHeld` once it is held: once every still of it, in this window or
 * another, has stopped. Not called if released before.
 */
export function holdLock(name: string, onHeld: () => void): () => void {
  held.set(name, (held.get(name) ?? 0) + 1);
  stopStills(name);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel stays within its origin and takes no target
  channel?.postMessage(name);
  let released = false;
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (typeof navigator.locks === "undefined") onHeld();
  else
    void navigator.locks.request(name, { mode: "shared" }, () => {
      if (!released) onHeld();
      return until;
    });
  return () => {
    if (released) return;
    released = true;
    const count = (held.get(name) ?? 1) - 1;
    if (count === 0) held.delete(name);
    else held.set(name, count);
    release();
  };
}

/**
 * Runs `use` for a still while holding the lock `name` alone, or answers null
 * at once when a view holds it. `stop` fires when a view of it comes, and
 * `use` must then let its socket go before it settles.
 */
export async function whileFree<A>(
  name: string,
  use: (stop: AbortSignal) => Promise<A>,
): Promise<A | null> {
  if (held.has(name)) return null;
  const run = () => {
    // A view came while this still waited for the lock: it would wait on the still, so none opens.
    if (held.has(name)) return Promise.resolve(null);
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    const mine = stills.get(name) ?? new Set();
    stills.set(name, mine.add(stop));
    return use(stopping.signal).finally(() => {
      mine.delete(stop);
      if (mine.size === 0) stills.delete(name);
    });
  };
  if (typeof navigator.locks === "undefined") return run();
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) =>
    lock === null ? null : run(),
  );
}
