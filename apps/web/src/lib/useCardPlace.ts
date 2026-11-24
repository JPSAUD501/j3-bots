// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CardPlace } from "@j3-bots/client-runtime/presentation";
import type { EntryId } from "@j3-bots/contracts";
import { useEffect, useState } from "react";

/** Steps of a tenth, so a card that grows into view or out of it is followed as it goes. */
const STEPS = Array.from({ length: 11 }, (_, step) => step / 10);

/**
 * Whether a change shows the card: half of it, or, for a card taller than
 * the timeline, half the timeline.
 */
const shows = (change: IntersectionObserverEntry) =>
  change.isIntersecting &&
  (change.intersectionRatio >= 0.5 ||
    (change.rootBounds !== null && change.intersectionRect.height >= change.rootBounds.height / 2));

/**
 * Where the card of `entryId`, carrying `data-entry-id`, is in the timeline
 * `root` scrolls; null while there is no such card there, as before it is
 * drawn or once its entry is older than what is loaded.
 */
export function useCardPlace(root: HTMLElement | null, entryId: EntryId | null): CardPlace | null {
  const [place, setPlace] = useState<{
    readonly entryId: EntryId;
    readonly place: CardPlace;
  } | null>(null);
  useEffect(() => {
    if (root === null || entryId === null) return;
    const selector = `[data-entry-id="${CSS.escape(entryId)}"]`;
    let card: Element | null = null;
    const seen = new IntersectionObserver(
      (changes) => {
        const change = changes.at(-1);
        if (change === undefined) return;
        const top = change.rootBounds?.top ?? root.getBoundingClientRect().top;
        setPlace({
          entryId,
          place: shows(change) ? "shown" : change.boundingClientRect.top < top ? "above" : "below",
        });
      },
      { root, threshold: STEPS },
    );
    // The card may be drawn after the conversation, and drawn again as another element.
    const find = () => {
      const found = root.querySelector(selector);
      if (found === card) return;
      if (card !== null) seen.unobserve(card);
      card = found;
      if (card === null) setPlace(null);
      else seen.observe(card);
    };
    find();
    const drawn = new MutationObserver(find);
    drawn.observe(root, { childList: true, subtree: true });
    return () => {
      seen.disconnect();
      drawn.disconnect();
      setPlace(null);
    };
  }, [root, entryId]);
  return place !== null && place.entryId === entryId ? place.place : null;
}
