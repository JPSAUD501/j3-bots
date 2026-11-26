// SPDX-License-Identifier: AGPL-3.0-or-later
import { layout } from "@j3-bots/design-tokens";
import { useSyncExternalStore } from "react";

// The `tablet:` variant's own query: a dialog is a panel from here up.
const tabletQuery = `(width >= ${layout.breakpoints.tablet / 16}rem)`;

const subscribe = (change: () => void) => {
  const query = window.matchMedia(tabletQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Whether the window is at the tablet layout or wider, following it as it changes. */
export const useTabletUp = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(tabletQuery).matches,
    () => true,
  );
