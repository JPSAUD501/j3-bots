// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useRef } from "react";

/**
 * Keeps keyboard focus when one element is replaced by another, such as an
 * approval's summary by the exact action once the engine has it, while the
 * operator is reading it. Give each element that can take another's place the
 * returned ref. When one of them unmounts with focus inside it and another
 * mounts in the same render, focus moves to the new one instead of falling to
 * the page. Focus that was elsewhere, or an element that stays mounted, is left
 * alone.
 */
export function useFocusReplacement() {
  /** The element that last unmounted with focus inside it. */
  const left = useRef<HTMLElement | null>(null);
  // Stable, so React calls it only when an element mounts or unmounts, not on every render.
  return useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    const lost = left.current;
    left.current = null;
    const active = document.activeElement;
    if (lost !== null && !lost.isConnected && (active === null || active === document.body)) {
      element.focus();
    }
    // React runs this before it takes the element out of the page, while focus is still in it.
    return () => {
      if (element.contains(document.activeElement)) left.current = element;
    };
  }, []);
}
