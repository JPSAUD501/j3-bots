// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useEffectEvent } from "react";

/** The attribute that carries an entry's id in a timeline. */
const SEEN_ID = "data-seen-id";

/**
 * How much of an entry must show for it to count as seen: half of it, or, for
 * an entry taller than the timeline, half the timeline's height. Such an entry
 * shows that much exactly when it crosses the timeline's middle line, which
 * one observer of that line sees at any height; a share of the entry could
 * not, as the share it takes grows with the entry. An entry no taller than
 * the timeline that crosses the line shows at least half of itself, so the
 * line observer watches every entry.
 */
const SEEN_SHARE = 0.5;

/** The timeline of `height` narrowed to its middle line, in pixels from its measured height. */
const middleLine = (height: number) => `${-height / 2}px 0px ${-height / 2}px 0px`;

/** A modal dialog hides what it covers from assistive technology; the details pane makes it inert. */
const covered = (element: Element) => element.closest('[inert], [aria-hidden="true"]') !== null;

/**
 * Calls `onSeen` with the id of the newest entry the operator can see in the
 * timeline `root` scrolls: enough of it on screen, in a shown window that has
 * focus, with no dialog over it. A window in the background reports no view
 * to the server either, so what arrives there both notifies and stays unread.
 * Entries carry `data-seen-id`, oldest first.
 */
export function useNewestSeen(root: HTMLElement | null, onSeen: (id: string) => void) {
  const report = useEffectEvent(onSeen);
  useEffect(() => {
    if (root === null) return;
    const halfShown = new Set<Element>();
    const onMiddle = new Set<Element>();
    const check = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus() || covered(root)) {
        return;
      }
      const newest = [...root.querySelectorAll(`[${SEEN_ID}]`)].findLast(
        (entry) => halfShown.has(entry) || onMiddle.has(entry),
      );
      const id = newest?.getAttribute(SEEN_ID) ?? null;
      if (id !== null) report(id);
    };
    /** Keeps `meeting` to the entries that meet `rule` as `options` observes them. */
    const follow = (
      meeting: Set<Element>,
      options: IntersectionObserverInit,
      rule: (change: IntersectionObserverEntry) => boolean,
    ) =>
      new IntersectionObserver(
        (changes) => {
          for (const change of changes) {
            if (rule(change)) meeting.add(change.target);
            else meeting.delete(change.target);
          }
          check();
        },
        { root, ...options },
      );
    const half = follow(
      halfShown,
      { threshold: [0, SEEN_SHARE] },
      (change) => change.isIntersecting && change.intersectionRatio >= SEEN_SHARE,
    );
    const followMiddle = (timelineHeight: number) =>
      follow(
        onMiddle,
        { rootMargin: middleLine(timelineHeight) },
        (change) => change.isIntersecting,
      );
    let height = root.clientHeight;
    let middle = followMiddle(height);
    // Observing an entry twice is a no-op, so every change observes whatever is new,
    // including a message whose entry id arrives on the element that showed it.
    const observeEntries = () => {
      for (const entry of root.querySelectorAll(`[${SEEN_ID}]`)) {
        half.observe(entry);
        middle.observe(entry);
      }
    };
    observeEntries();
    const arrivals = new MutationObserver(observeEntries);
    arrivals.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [SEEN_ID],
    });
    // A margin is fixed when its observer is made, so a new height takes a new one.
    const resizes = new ResizeObserver(() => {
      if (root.clientHeight === height) return;
      height = root.clientHeight;
      middle.disconnect();
      onMiddle.clear();
      middle = followMiddle(height);
      observeEntries();
    });
    resizes.observe(root);
    // Closing a dialog or returning to the window shows entries without a scroll.
    const covers = new MutationObserver(check);
    covers.observe(document.body, {
      attributes: true,
      attributeFilter: ["inert", "aria-hidden"],
      subtree: true,
    });
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      half.disconnect();
      middle.disconnect();
      resizes.disconnect();
      arrivals.disconnect();
      covers.disconnect();
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [root]);
}
