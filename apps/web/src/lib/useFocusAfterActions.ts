// SPDX-License-Identifier: AGPL-3.0-or-later
import { type FocusEvent, useEffect, useRef } from "react";

/**
 * Keeps keyboard focus when a group of actions goes away. While `open`, it
 * follows whether focus is among the actions; when they close and unmount with
 * focus still there, focus moves to `target`, a container with `tabIndex={-1}`
 * that stays, so the keyboard goes on from where it was instead of from the
 * top of the page.
 */
export function useFocusAfterActions<T extends HTMLElement>(open: boolean) {
  const target = useRef<T>(null);
  const within = useRef(false);
  useEffect(() => {
    if (open || !within.current) return;
    within.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) target.current?.focus();
  }, [open]);
  const actions = {
    onFocus: () => {
      within.current = true;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      // A removed button may blur with nowhere to go, which is not leaving.
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) within.current = false;
    },
  };
  return { target, actions };
}
