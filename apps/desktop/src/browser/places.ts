// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserTabRef } from "@j3-bots/contracts";
import type { BrowserPlace } from "@j3-bots/desktop-bridge";

// Where each of the desktop's tabs is: in which place, in what order, which
// one is in front of each place, and the closed ones that can be opened
// again. Nothing here knows of a window: the app draws what this says.

/** How many closed tabs can be opened again. */
const CLOSED_KEPT = 25;

/** A tab the app shows, and what it knows of it beyond its page. */
interface Placed {
  place: BrowserPlace;
  /** A private tab is never opened again once closed: it leaves nothing behind. */
  readonly private: boolean;
  failed: string | null;
  /** The last address the tab showed, to open it again once closed. */
  url: string;
  /** What finding in the page looks for now. */
  finding: string;
}

export interface Places {
  /** Every tab, in the order the strips show them. */
  readonly order: ReadonlyArray<BrowserTabRef>;
  /** The tab in front of each place, if it has any. */
  readonly front: Readonly<Record<BrowserPlace, BrowserTabRef | null>>;
  readonly at: (ref: BrowserTabRef) => Placed | undefined;
  /** The place `ref` is in: beside the conversation, for a tab not placed yet. */
  readonly placeOf: (ref: BrowserTabRef) => BrowserPlace;
  /** A tab the browser opened: it sits beside its opener, or goes last, and never takes the front from another. */
  readonly opened: (ref: BrowserTabRef, isPrivate: boolean, opener: BrowserTabRef | null) => void;
  /** A tab the person opens goes to the place they asked for. */
  readonly openedInPlace: (ref: BrowserTabRef, isPrivate: boolean, place: BrowserPlace) => void;
  /** Puts `ref` in `place`, in front there when `inFront`. */
  readonly put: (ref: BrowserTabRef, place: BrowserPlace, inFront: boolean) => void;
  /**
   * Forgets a closed tab, keeping a shared one to open again. Returns the
   * place it was in front of, where another tab now is, or null.
   */
  readonly closed: (ref: BrowserTabRef) => BrowserPlace | null;
  /** Every tab in the browser's window goes beside the conversation, as the window closes. */
  readonly windowClosed: () => void;
  /** The last closed tab, taken from those to open again. */
  readonly reopen: () => { readonly url: string; readonly place: BrowserPlace } | undefined;
  readonly canReopen: () => boolean;
}

/** The tabs' places, empty; `changed` is told whenever `put` moves one. */
export const makePlaces = (changed: () => void): Places => {
  const placed = new Map<BrowserTabRef, Placed>();
  const order: Array<BrowserTabRef> = [];
  const front: Record<BrowserPlace, BrowserTabRef | null> = { panel: null, window: null };
  const reopenable: Array<{ readonly url: string; readonly place: BrowserPlace }> = [];

  const placeOf = (ref: BrowserTabRef) => placed.get(ref)?.place ?? "panel";

  /** The tab a place shows once `leaving` is no longer in front there. */
  const nextInFront = (place: BrowserPlace, leaving: BrowserTabRef) => {
    const here = order.filter((ref) => ref !== leaving && placeOf(ref) === place);
    const index = order.indexOf(leaving);
    return here.find((ref) => order.indexOf(ref) > index) ?? here.findLast(() => true) ?? null;
  };

  const fresh = (place: BrowserPlace, isPrivate: boolean): Placed => ({
    place,
    private: isPrivate,
    failed: null,
    url: "",
    finding: "",
  });

  return {
    order,
    front,
    at: (ref) => placed.get(ref),
    placeOf,
    opened: (ref, isPrivate, opener) => {
      if (placed.has(ref)) return;
      const place = opener === null ? "panel" : placeOf(opener);
      placed.set(ref, fresh(place, isPrivate));
      // A tab a page opens sits beside its opener; any other goes last.
      const after = opener === null ? -1 : order.indexOf(opener);
      if (after === -1) order.push(ref);
      else order.splice(after + 1, 0, ref);
      // A bot's new tab never takes the person's place from under them.
      if (front[place] === null) front[place] = ref;
    },
    openedInPlace: (ref, isPrivate, place) => {
      if (!placed.has(ref)) placed.set(ref, fresh(place, isPrivate));
    },
    put: (ref, place, inFront) => {
      const at = placed.get(ref);
      if (at === undefined) return;
      const was = at.place;
      at.place = place;
      if (was !== place && front[was] === ref) front[was] = nextInFront(was, ref);
      if (inFront || front[place] === null) front[place] = ref;
      changed();
    },
    closed: (ref) => {
      const at = placed.get(ref);
      placed.delete(ref);
      const index = order.indexOf(ref);
      let leftFront: BrowserPlace | null = null;
      if (at !== undefined && front[at.place] === ref) {
        front[at.place] = nextInFront(at.place, ref);
        leftFront = at.place;
      }
      if (index !== -1) order.splice(index, 1);
      if (at !== undefined && !at.private && at.url !== "") {
        reopenable.push({ url: at.url, place: at.place });
        reopenable.splice(0, Math.max(0, reopenable.length - CLOSED_KEPT));
      }
      return leftFront;
    },
    windowClosed: () => {
      for (const ref of order) {
        const at = placed.get(ref);
        if (at?.place === "window") at.place = "panel";
      }
      front.window = null;
      front.panel ??= order.find((ref) => placeOf(ref) === "panel") ?? null;
    },
    reopen: () => reopenable.pop(),
    canReopen: () => reopenable.length > 0,
  };
};
