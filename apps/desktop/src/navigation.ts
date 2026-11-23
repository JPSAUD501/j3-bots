// SPDX-License-Identifier: AGPL-3.0-or-later
import { VISUAL_FRAME_PATH } from "@j3-bots/contracts";

/**
 * `url`'s scheme and host, as `j3bots://app`. A custom scheme's `URL.origin`
 * is `"null"` outside a browser, so origins on it are compared by this.
 */
const originOf = (url: string): string | null => {
  const parsed = URL.parse(url);
  return parsed === null || parsed.host === "" ? null : `${parsed.protocol}//${parsed.host}`;
};

/** Whether `url` is one of the app's own pages: the window may go there. */
export const isAppUrl = (url: string, appOrigin: string): boolean => originOf(url) === appOrigin;

/**
 * Whether a frame inside the app's page may go to `url`. The page frames
 * nothing but a bot's visual, in the app's visual page, so that page, as the
 * app loads it, is the only place a frame may be.
 */
export const isVisualFrameUrl = (url: string, appOrigin: string): boolean => {
  const parsed = URL.parse(url);
  return (
    parsed !== null &&
    isAppUrl(url, appOrigin) &&
    parsed.pathname === VISUAL_FRAME_PATH &&
    parsed.search === "" &&
    parsed.hash === ""
  );
};

/** Schemes a link may hand to the system's browser or mail client. Nothing else leaves the app. */
const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

/** `url` when a link to it opens outside the app, in the system's own handler; otherwise `null`. */
export const externalUrl = (url: string): string | null => {
  const parsed = URL.parse(url);
  return parsed !== null && EXTERNAL.has(parsed.protocol) ? parsed.href : null;
};
