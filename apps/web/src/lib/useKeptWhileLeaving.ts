// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type ReactNode } from "react";

/**
 * What a region shows while it opens, stays and leaves: `content` while there
 * is some, and the last of it while the region animates away, until `gone` is
 * called once the region has left. `leaving` says the region is on its way out,
 * so it can take no input and play its exit.
 */
export function useKeptWhileLeaving(content: ReactNode | null): {
  readonly shown: ReactNode | null;
  readonly leaving: boolean;
  readonly gone: () => void;
} {
  const [kept, setKept] = useState<ReactNode | null>(null);
  // Stored during render, as React allows for state derived from a previous render.
  if (content !== null && content !== kept) setKept(content);
  return {
    shown: content ?? kept,
    leaving: content === null && kept !== null,
    gone: () => {
      if (content === null) setKept(null);
    },
  };
}
