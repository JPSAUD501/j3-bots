// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewState, J3Client } from "@j3-bots/client-runtime";

/**
 * Where the shell's views of a bot's browser come from: the client runtime
 * in a build, a sample in the gallery and in development.
 */
export type BrowserSource = Pick<J3Client, "openBrowserTabs" | "openBrowserView">;

/** Whether a view is, or soon will be, showing the page. */
export const opening = (state: BrowserViewState): boolean => {
  switch (state.status._tag) {
    case "connecting":
    case "live":
    case "reconnecting":
    case "paused":
      return true;
    case "gone":
    case "setup-needed":
    case "replaced":
    case "failed":
      return false;
  }
};

/** Whether this device holds the tab the view shows, or will once it reconnects. */
export const holds = (state: BrowserViewState): boolean =>
  opening(state) && state.control?.controller === "you";
