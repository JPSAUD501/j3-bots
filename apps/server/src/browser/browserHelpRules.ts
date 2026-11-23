// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";

/**
 * How long a browser help card waits for the operator. Past it, the card
 * expires once no device holds the bot's tabs: someone still at work in the
 * browser keeps it open.
 */
export const BROWSER_HELP_WAIT = Duration.hours(1);

/**
 * How long a card's tab must be missing from the engine's list before the card
 * expires with it. The list is empty while the engine is not ready and is
 * built again after a restart, so a short gap is not a closed tab.
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
 * How long an answer waits for the engine to say the operator's devices let
 * go of the bot's tabs, before it closes the card anyway. The engine applies a
 * release at once; this bounds a lost reply.
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
