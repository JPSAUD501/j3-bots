// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";

/** Whether this browser reaches the network, as far as it knows. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (change) => {
      window.addEventListener("online", change);
      window.addEventListener("offline", change);
      return () => {
        window.removeEventListener("online", change);
        window.removeEventListener("offline", change);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
