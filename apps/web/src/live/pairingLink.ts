// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import { PAIRING_PATH, type PairingCode, PairingLink } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createContext } from "react";

const decodeLink = Schema.decodeUnknownOption(PairingLink);

/**
 * The code of the pairing link this page was opened at (`<origin>/pair#<code>`,
 * as a phone's camera opens a QR code), or null. A page at `/pair` leaves it
 * at once for the app's root, so the code leaves the address bar and the
 * tab's back and forward history, and is not bookmarked or shared with the
 * page's address; a code that is not a whole link is dropped. Taken before the
 * router reads the address, so it never routes `/pair`. The root is given
 * whole: `replaceState` refuses a path such as `//x` as another origin.
 */
export function takePairingCode(
  href: string,
  history: Pick<History, "state" | "replaceState">,
): PairingCode | null {
  const root = new URL(href);
  if (root.pathname !== PAIRING_PATH) return null;
  const link = decodeLink(href);
  root.pathname = "/";
  root.search = "";
  root.hash = "";
  history.replaceState(history.state, "", root.href);
  return Option.match(link, { onNone: () => null, onSome: ({ code }) => code });
}

/**
 * The code a pairing link opened this page with, for the pairing screen to
 * start with. It never pairs by itself: the operator still presses Pair.
 */
export interface LinkedCode {
  /** The code, or null once it was dropped or when the page had none. */
  readonly current: () => PairingCode | null;
  /** Calls `listener` when the code is dropped; returns what stops that. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Drops the code once the connection is `connected`: the code is for pairing
   * this browser, and it is connected, paired already when the link was opened
   * or by this code. Any other state keeps it, `connecting` above all: a
   * browser that holds a credential the server no longer accepts, as after a
   * reinstall or a revocation, connects before it learns that and shows the
   * pairing screen.
   */
  readonly follow: (connection: ConnectionState) => void;
}

/**
 * `code` until it is dropped: once the browser is connected (`follow`), and
 * once the page is put aside (`pagehide`), as when the operator leaves it for
 * another page before pressing Pair. A page the back/forward cache restores
 * keeps everything it held, so without this, Back would bring the unused code
 * back into the form. Listeners are told at once, and React commits what
 * they change in the microtask that runs as the event's listener returns,
 * before the page is put away.
 */
export function linkedCode(
  code: PairingCode | null,
  page: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): LinkedCode {
  let current = code;
  const listeners = new Set<() => void>();
  const drop = () => {
    if (current === null) return;
    current = null;
    page.removeEventListener("pagehide", drop);
    for (const listener of listeners) listener();
  };
  if (current !== null) page.addEventListener("pagehide", drop);
  return {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    follow: (connection) => {
      if (connection._tag === "connected") drop();
    },
  };
}

/** This page's `LinkedCode`: none, unless `main.tsx` gives the page's own. */
export const LinkedPairingCode = createContext<LinkedCode>(linkedCode(null, new EventTarget()));
