// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";

/**
 * Whether something lies over `element`: a modal dialog, a confirmation
 * included, hides what it covers from assistive technology, and the details
 * as a sheet make the regions under them inert.
 */
export const isCovered = (element: Element) =>
  element.closest('[inert], [aria-hidden="true"]') !== null;

/** Calls `onChange` whenever a dialog or sheet may have opened or closed. */
export const watchCovers = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["inert", "aria-hidden"],
    subtree: true,
  });
  return () => observer.disconnect();
};

/** Whether something lies over `element`, as `isCovered` tells, kept current. */
export function useCovered(element: Element | null): boolean {
  const covered = () => element !== null && isCovered(element);
  return useSyncExternalStore(watchCovers, covered, covered);
}
