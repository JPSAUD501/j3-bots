// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LoadedHandle } from "@j3-bots/client-runtime";
import { useEffect, useState } from "react";

/**
 * The value `open`'s handle holds once ready, while the component is mounted:
 * the handle is opened as it mounts and released as it goes, or as `open`
 * changes. Null while it loads, and with no `open`, which opens nothing.
 */
export function useLoadedHandle<A>(open: (() => LoadedHandle<A>) | null): A | null {
  const [held, setHeld] = useState<{
    readonly open: () => LoadedHandle<A>;
    readonly value: A;
  } | null>(null);
  useEffect(() => {
    if (open === null) return;
    const handle = open();
    const read = () => {
      const loaded = handle.state.get();
      if (loaded._tag === "ready") setHeld({ open, value: loaded.value });
    };
    read();
    const stop = handle.state.subscribe(read);
    return () => {
      stop();
      handle.release();
    };
  }, [open]);
  // What another `open` held says nothing of this one's.
  return held !== null && held.open === open ? held.value : null;
}
