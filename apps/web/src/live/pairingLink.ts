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
export const LinkedPairingCode = createContext<PairingCode | null>(null);

/**
 * What remains of a pairing link's code once the connection is `connection`.
 * The code is for pairing this browser: once it is connected, paired already
 * when the link was opened or by this code, the code is dropped unasked. Any
 * other state keeps it, `connecting` above all: a browser that holds a
 * credential the server no longer accepts, as after a reinstall or a
 * revocation, connects before it learns that and shows the pairing screen.
 */
export const linkedCodeAfter = (
  code: PairingCode | null,
  connection: ConnectionState,
): PairingCode | null => (connection._tag === "connected" ? null : code);
