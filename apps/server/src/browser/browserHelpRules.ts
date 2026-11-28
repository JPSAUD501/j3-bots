// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";

/**
 * How long a browser help card waits for the operator. Past it, the card
 * expires once no device holds the bot's tabs: someone still at work in the
 * browser keeps it open.
 */
export const BROWSER_HELP_WAIT = Duration.hours(1);

/**
 * How long a card stays open once its tab is gone from the server's tabs,
 * open or parked, before it expires with it: an answer the operator was
 * already giving still lands.
 */
export const TAB_ABSENT_GRACE = Duration.minutes(2);

/**
 * How long past its wait a card stays open once its devices gave the bot's
 * tabs back: an operator who gives the tab back in the viewer and then answers
 * the card answers it, rather than finding it expired in between.
 */
export const HAND_BACK_GRACE = Duration.minutes(2);

/** How often open cards are checked against the clock and the open tabs. */
export const SWEEP_EVERY = Duration.seconds(30);

/**
 * How long an answer waits for the operator's holds on the bot's tabs to
 * end, before it closes the card anyway. A hold ends at once; this bounds
 * one that does not.
 */
export const RELEASE_WAIT = Duration.seconds(5);

/** The longest host name there is, and so the longest site a card shows. */
const MAX_SITE_LENGTH = 253;

/**
 * The host name of a web page's address, the part a card shows; empty for
 * any other address, and for one no host name could be.
 */
export const siteOf = (url: string): string => {
  if (!URL.canParse(url)) return "";
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return "";
  return hostname.length <= MAX_SITE_LENGTH ? hostname : "";
};
