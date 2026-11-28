// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- a still is taken for the apps' cards, on the platform's timers, outside any Effect program.
import type { BrowserTabRef } from "@j3-bots/contracts";
import type { BrowserViewHandle } from "./client.ts";
import type { BrowserViewSize, BrowserViewStatus } from "./stores/Browser.ts";

// A still: one picture of a tab nobody here watches, for a card that shows
// it, taken on a view of its own that closes at its first picture. The same
// on every client; each decides when a still may be taken at all, since a
// device's newer socket on a tab takes the place of its view of it.

/** How long a still waits for its picture before giving up. */
export const STILL_TIMEOUT = 10_000;

/** What a still needs of a view. */
export type StillView = Pick<BrowserViewHandle, "picture" | "state" | "close">;

/** Opens a view of a tab, as `J3Client.openBrowserView` does. */
export type OpenStillView = (input: {
  readonly ref: BrowserTabRef;
  readonly size: () => BrowserViewSize;
}) => StillView;

/**
 * Whether a still's view still comes toward its picture: only while its
 * first socket opens or is live. A still never opens another socket after a
 * drop, which would be this device's newest on the tab and could take the
 * place of a view opened meanwhile.
 */
const comesOn = (status: BrowserViewStatus): boolean => {
  switch (status._tag) {
    case "connecting":
    case "live":
      return true;
    case "reconnecting":
    case "paused":
    case "gone":
    case "setup-needed":
    case "replaced":
    case "failed":
      return false;
  }
};

/**
 * One picture of the tab `ref`, at `size`: the first its view is sent, the
 * view closed then. Null when none came in `STILL_TIMEOUT`, when the view's
 * socket ended or dropped, or once `stop` aborts.
 */
export const takeStill = (
  open: OpenStillView,
  ref: BrowserTabRef,
  size: BrowserViewSize,
  stop: AbortSignal,
): Promise<Uint8Array | null> =>
  new Promise((resolve) => {
    if (stop.aborted) {
      resolve(null);
      return;
    }
    const view = open({ ref, size: () => size });
    let done = false;
    const stops: Array<() => void> = [];
    const finish = (jpeg: Uint8Array | null) => {
      if (done) return;
      done = true;
      for (const each of stops) each();
      view.close();
      resolve(jpeg);
    };
    stops.push(
      view.picture.subscribe(() => {
        const picture = view.picture.get();
        if (picture !== null) finish(picture.jpeg);
      }),
      view.state.subscribe(() => {
        if (!comesOn(view.state.get().status)) finish(null);
      }),
    );
    const timer = setTimeout(() => finish(null), STILL_TIMEOUT);
    stops.push(() => clearTimeout(timer));
    const stopNow = () => finish(null);
    stop.addEventListener("abort", stopNow);
    stops.push(() => stop.removeEventListener("abort", stopNow));
  });

/**
 * A line that runs what is given to it one after another, so a list of tabs
 * takes its stills one socket at a time. A run that fails lets the next go.
 */
export const oneAtATime = (): (<A>(run: () => Promise<A>) => Promise<A>) => {
  let last: Promise<unknown> = Promise.resolve();
  return (run) => {
    const next = last.then(run);
    last = next.catch(() => undefined);
    return next;
  };
};
