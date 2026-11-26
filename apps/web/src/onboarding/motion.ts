// SPDX-License-Identifier: AGPL-3.0-or-later
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
