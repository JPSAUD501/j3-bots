// SPDX-License-Identifier: AGPL-3.0-or-later
import type { springs } from "@j3-bots/design-tokens";
import { useSyncExternalStore } from "react";

const reducedQuery = "(prefers-reduced-motion: reduce)";

const subscribe = (change: () => void) => {
  const query = window.matchMedia(reducedQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Whether the system asks for reduced motion, following the setting as it changes. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(reducedQuery).matches,
    () => false,
  );

/**
 * A CSS `animation` that plays `keyframes` along one of the design tokens'
 * springs, by its `--ease-*` and `--duration-*` names. Reduced motion needs
 * nothing here: the page's reduced-motion rule ends every animation at once,
 * which leaves each element in its still form.
 */
export const springAnimation = (
  keyframes: string,
  spring: keyof typeof springs = "slide",
  delay = 0,
): string => `${keyframes} var(--duration-${spring}) var(--ease-${spring}) ${delay}ms both`;
