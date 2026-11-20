// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useEffectEvent } from "react";

/** The attribute that carries an entry's id in a timeline. */
const SEEN_ID = "data-seen-id";

/** A modal dialog hides what it covers from assistive technology; the details pane makes it inert. */
const covered = (element: Element) => element.closest('[inert], [aria-hidden="true"]') !== null;

/**
 * Calls `onSeen` with the id of the newest entry the operator can see in the
 * timeline `root` scrolls: on screen, in a shown tab, with no dialog over it.
 * Entries carry `data-seen-id`, oldest first.
 */
export function useNewestSeen(root: HTMLElement | null, onSeen: (id: string) => void) {
  const report = useEffectEvent(onSeen);
  useEffect(() => {
    if (root === null) return;
    const showing = new Set<Element>();
    const check = () => {
      if (document.visibilityState !== "visible" || covered(root)) return;
      const newest = [...root.querySelectorAll(`[${SEEN_ID}]`)].findLast((entry) =>
        showing.has(entry),
      );
      const id = newest?.getAttribute(SEEN_ID) ?? null;
      if (id !== null) report(id);
    };
    const onScreen = new IntersectionObserver(
      (changes) => {
        for (const change of changes) {
          if (change.isIntersecting) showing.add(change.target);
          else showing.delete(change.target);
        }
        check();
      },
      { root },
    );
    // Observing an entry twice is a no-op, so every change observes whatever is new.
    const observeEntries = () => {
      for (const entry of root.querySelectorAll(`[${SEEN_ID}]`)) onScreen.observe(entry);
    };
    observeEntries();
    const arrivals = new MutationObserver(observeEntries);
    arrivals.observe(root, { childList: true, subtree: true });
    // Closing a dialog or returning to the tab shows entries without a scroll.
    const covers = new MutationObserver(check);
    covers.observe(document.body, {
      attributes: true,
      attributeFilter: ["inert", "aria-hidden"],
      subtree: true,
    });
    document.addEventListener("visibilitychange", check);
    return () => {
      onScreen.disconnect();
      arrivals.disconnect();
      covers.disconnect();
      document.removeEventListener("visibilitychange", check);
    };
  }, [root]);
}
