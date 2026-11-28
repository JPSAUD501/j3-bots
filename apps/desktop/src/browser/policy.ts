// SPDX-License-Identifier: AGPL-3.0-or-later
// The permission allowlist follows T3 Code v0.1.13, apps/desktop/src/preview/BrowserSession.ts
// (`ALLOWED_PREVIEW_PERMISSIONS`, MIT License, Copyright (c) 2026 T3 Tools Inc.; see
// apps/desktop/NOTICE). Changed here: the permissions T3 Code asks the person about
// (camera, microphone, location, reading the clipboard) are refused, and so is every
// external protocol: a bot's page cannot ask, and the person's has no one to ask.

// What a page of the app's browser may do on the person's machine.

/** The partition every shared tab of the desktop's browser lives in: the shared sign-ins. */
export const BROWSER_PARTITION = "persist:j3-browser";

/** The prefix of a private tab's partition: kept in memory only, gone with the tab. */
export const PRIVATE_PARTITION_PREFIX = "j3-private-";

/**
 * What a page may have without asking: writing to the clipboard, full
 * screen and pointer lock inside its view, and reaching the machine's own
 * loopback, which Electron allows anyway and some sign-in widgets query
 * first. Notifications are refused, so a page cannot pose as the app.
 */
const GRANTED = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "loopback-network",
]);

/** Whether a page of the browser holds, or is granted, `permission`. */
export const pageMayHave = (permission: string): boolean => GRANTED.has(permission);

/** The schemes a tab's page may show. Everything else, the app's own included, stays out. */
const PAGE_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"]);

/**
 * Whether a tab's frame may go to `url`. A page cannot take a tab to the
 * app's own pages, to a file on the machine, or to the browser's internal
 * pages; `about:` is only `about:blank` and `about:srcdoc`.
 */
export const pageMayGo = (url: string): boolean => {
  const parsed = URL.parse(url);
  if (parsed === null || !PAGE_SCHEMES.has(parsed.protocol)) return false;
  return (
    parsed.protocol !== "about:" || parsed.pathname === "blank" || parsed.pathname === "srcdoc"
  );
};
