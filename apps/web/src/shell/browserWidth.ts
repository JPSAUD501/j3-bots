// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * How wide the browser beside the conversation is, as the person last left
 * it: the same in every conversation. Null until they first move the divider.
 */

const KEY = "j3:browser-width";

/** The narrowest the conversation gets beside the browser, in CSS pixels. */
export const CONVERSATION_MIN = 360;
/** The narrowest the browser gets beside the conversation; dragged well past it, it closes. */
export const BROWSER_MIN = 420;
/** How far past its narrowest the browser is dragged before letting go closes it. */
export const CLOSING_PAST = 96;

const Width = Schema.NumberFromString.check(
  Schema.isBetween({ minimum: BROWSER_MIN, maximum: 10_000 }),
);

export function storedBrowserWidth(): number | null {
  try {
    return Option.getOrNull(Schema.decodeUnknownOption(Width)(localStorage.getItem(KEY)));
  } catch {
    // Storage can be unavailable; the browser takes its usual width.
    return null;
  }
}

export function keepBrowserWidth(width: number) {
  try {
    localStorage.setItem(KEY, String(Math.round(width)));
  } catch {
    // The width still applies here; it is just not remembered.
  }
}

/** The width a browser asked to be `wanted` wide takes beside a conversation, in `room`. */
export const browserWidthIn = (room: number, wanted: number) =>
  Math.max(BROWSER_MIN, Math.min(wanted, room - CONVERSATION_MIN));
