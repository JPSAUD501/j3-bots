// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";

/**
 * How much of the window's bottom a phone's on-screen keyboard covers, in
 * CSS pixels. Where the keyboard leaves the page's layout as it was and
 * only shrinks the visual viewport, as most phone browsers do, that is the
 * part of the layout below the visual viewport; where it shrinks the
 * layout instead, nothing is covered and this is 0. A pinch-zoomed page
 * reads 0 too: what the zoom hides is not a keyboard.
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, read, () => 0);
}

function read(): number {
  const viewport = window.visualViewport;
  if (viewport === null || Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

function subscribe(change: () => void): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  viewport.addEventListener("resize", change);
  viewport.addEventListener("scroll", change);
  return () => {
    viewport.removeEventListener("resize", change);
    viewport.removeEventListener("scroll", change);
  };
}
