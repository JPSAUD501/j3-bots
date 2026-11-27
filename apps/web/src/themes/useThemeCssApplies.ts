// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";
import { OWN_CSS_MEDIA } from "./look";

const subscribe = (change: () => void) => {
  const query = window.matchMedia(OWN_CSS_MEDIA);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Whether a theme's own CSS applies on this device, following it as the pointer changes. */
export const useThemeCssApplies = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(OWN_CSS_MEDIA).matches,
    () => true,
  );
