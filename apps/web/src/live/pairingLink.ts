// SPDX-License-Identifier: AGPL-3.0-or-later
import { type PairingCode, PairingLink } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createContext } from "react";

const decodeLink = Schema.decodeUnknownOption(PairingLink);

/**
 * The code of the pairing link this page was opened at (`<origin>/#pair=<code>`,
 * as a phone's camera opens a QR code), or null. Any `#pair=` fragment leaves
 * the address bar at once, so the code is not kept in history, bookmarked or
 * shared with the page's address; one that is not a whole link is dropped.
 * Taken before the router reads the address.
 */
export function takePairingCode(
  location: Pick<Location, "href" | "hash" | "pathname" | "search">,
  history: Pick<History, "state" | "replaceState">,
): PairingCode | null {
  if (!location.hash.startsWith("#pair=")) return null;
  const link = decodeLink(location.href);
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return Option.match(link, { onNone: () => null, onSome: ({ code }) => code });
}

/**
 * The code a pairing link opened this page with, for the pairing screen to
 * start with. It never pairs by itself: the operator still presses Pair.
 */
export const LinkedPairingCode = createContext<PairingCode | null>(null);
