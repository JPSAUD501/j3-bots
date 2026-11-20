// SPDX-License-Identifier: AGPL-3.0-or-later
import { layout } from "@j3-bots/design-tokens";
import { useCallback, useState, type RefCallback } from "react";

/** Which of the three layouts the shell's own width calls for (see `AppShell`). */
export type ShellLayout = "phone" | "tablet" | "wide";

const layoutFor = (width: number): ShellLayout =>
  width >= layout.breakpoints.wide
    ? "wide"
    : width >= layout.breakpoints.tablet
      ? "tablet"
      : "phone";

/**
 * The layout of the element the returned ref is put on, from its width, as
 * the shell's container queries see it; null until it has been measured.
 */
export function useShellLayout(): readonly [RefCallback<HTMLElement>, ShellLayout | null] {
  const [current, setCurrent] = useState<ShellLayout | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCurrent(layoutFor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, current];
}
