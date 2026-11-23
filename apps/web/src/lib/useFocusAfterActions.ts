// SPDX-License-Identifier: AGPL-3.0-or-later
import { type FocusEvent, useEffect, useRef } from "react";

/** Handlers for each element that holds something going away when the actions close. */
export interface FocusWatch {
  readonly onFocus: () => void;
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Keeps keyboard focus when the parts of a card that only exist while it is
 * open go away: its actions, and anything else that unmounts with them. While
 * `open`, it follows whether focus is inside one of the elements given
 * `actions`; when they close, unmounted or folded away inert, with focus still
 * there, focus moves to `target`, a container with `tabIndex={-1}` that stays,
 * so the keyboard goes on from where it was instead of from the top of the
 * page. An element that stays mounted and can still act keeps its focus.
 */
export function useFocusAfterActions<T extends HTMLElement>(open: boolean) {
  const target = useRef<T>(null);
  const within = useRef(false);
  useEffect(() => {
    if (open || !within.current) return;
    within.current = false;
    // Focus was lost, or stayed on an action that folded away: inert, it can no longer act.
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest("[inert]") !== null) {
      target.current?.focus();
    }
  }, [open]);
  const actions: FocusWatch = {
    onFocus: () => {
      within.current = true;
    },
    onBlur: (event) => {
      // A removed element may blur with nowhere to go, which is not leaving.
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) within.current = false;
    },
  };
  return { target, actions };
}
