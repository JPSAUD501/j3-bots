// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute, notFound } from "@tanstack/react-router";
import { BrowserWindowLive } from "../browser/desktop/BrowserWindowLive";
import { desktop } from "../live/desktop";

/**
 * The browser's own window: the page of the desktop app's window that shows
 * its tabs as a whole browser. A browser has no such window, and answers this
 * path with "not found".
 */
export const Route = createFileRoute("/browser")({
  beforeLoad: () => {
    if (desktop === null) throw notFound();
  },
  component: BrowserRoute,
});

function BrowserRoute() {
  return desktop === null ? null : <BrowserWindowLive app={desktop} />;
}
