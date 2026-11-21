// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppLink } from "@j3-bots/desktop-bridge";
import type { Desktop } from "./desktop";

// Links to the desktop app (`j3bots://bot/<id>`, `room/<id>`, `pair?…`), as
// the app hands them to its page. Each screen takes the links it can act on:
// the server address screen any, the gate in front of the bots a pairing link,
// the shell a conversation or room once the roster is loaded
// (`LiveSource.tsx`). One no screen takes waits for the next that can.

/** Answers whether it took `link`; one it leaves is offered to the next screen. */
type Taker = (link: AppLink) => boolean;

const takers = new Set<Taker>();
/** The latest link no screen took yet, as while the page still starts. */
let waiting: AppLink | null = null;

function arrived(link: AppLink) {
  for (const take of takers) {
    if (take(link)) {
      waiting = null;
      return;
    }
  }
  waiting = link;
}

/** Listens for the links the desktop app (`app`) hands this page. Called once, as the page starts. */
export function listenForAppLinks(app: Desktop | null): void {
  app?.onAppLink(arrived);
}

/**
 * Offers `take` each link to the app, starting with one that waits. Returns
 * the function that stops.
 */
export function onAppLink(take: Taker): () => void {
  takers.add(take);
  if (waiting !== null && take(waiting)) waiting = null;
  return () => {
    takers.delete(take);
  };
}
