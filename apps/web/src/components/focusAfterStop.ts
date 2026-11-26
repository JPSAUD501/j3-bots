// SPDX-License-Identifier: AGPL-3.0-or-later
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

/**
 * Gives the pane's heading the focus once the Stop that held it goes, as it
 * does when the work it ends is over. Answers the ref for the Stop.
 */
export function useFocusAfterStop(heading: RefObject<HTMLHeadingElement | null> | undefined) {
  const left = useRef(false);
  const stopRef = useCallback((element: HTMLButtonElement | null) => {
    if (element === null) return;
    // React runs this before it takes the button out of the page, while focus is still on it.
    return () => {
      if (element === document.activeElement) left.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    if (!left.current) return;
    left.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    heading?.current?.focus();
  });
  return stopRef;
}
