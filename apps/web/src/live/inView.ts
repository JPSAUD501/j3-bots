// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
};

/** Whether the operator is looking at this window: it shows, and it has focus. */
export const isInView = () => document.visibilityState === "visible" && document.hasFocus();

/** `isInView`, followed as it changes. */
export const useInView = (): boolean => useSyncExternalStore(subscribe, isInView, isInView);
