// SPDX-License-Identifier: AGPL-3.0-or-later

/** How long a value shown stays on screen, in ms. */
export const SHOWN_FOR = 30_000;

/** The page a shown value watches: hidden, it hides the value too. */
export type Page = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Hides a value shown now (`hide`) after `SHOWN_FOR`, or as soon as the page
 * is hidden, whichever comes first. Returns what stops watching, as when the
 * value goes away first.
 */
export const hideShownLater = (hide: () => void, page: Page): (() => void) => {
  const timer = setTimeout(hide, SHOWN_FOR);
  const hidden = () => {
    if (page.visibilityState === "hidden") hide();
  };
  page.addEventListener("visibilitychange", hidden);
  return () => {
    clearTimeout(timer);
    page.removeEventListener("visibilitychange", hidden);
  };
};
