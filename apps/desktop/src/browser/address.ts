// SPDX-License-Identifier: AGPL-3.0-or-later
import { addressOf } from "@j3-bots/browser";

// What the person typed in the address bar: an address to open, or words to
// search for, as an ordinary browser reads it.

/** Where words typed in the address bar are searched for. */
const SEARCH = "https://www.google.com/search";

/** Hosts that need no dot to be an address: this machine's own. */
const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The search for `text`. */
export const searchFor = (text: string): string => {
  const url = new URL(SEARCH);
  url.searchParams.set("q", text.trim());
  return url.href;
};

/**
 * The address a tab opens for `input`: an `http:` or `https:` address as
 * typed, a host with a dot (or this machine's) with its scheme added, and
 * the search for anything else, words with spaces or a single word.
 */
export const typedAddress = (input: string): string => {
  const text = input.trim();
  const address = /\s/.test(text) ? undefined : addressOf(text);
  if (address === undefined) return searchFor(text);
  const typedScheme = /^https?:\/\//i.test(text);
  const { hostname } = new URL(address);
  return typedScheme || hostname.includes(".") || LOOPBACK.test(hostname)
    ? address
    : searchFor(text);
};
