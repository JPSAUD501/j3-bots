// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";

/** What a sheet shows, and which opening it belongs to. */
interface Held<T> {
  readonly value: T;
  /** Grows with each opening: as a key, it starts the sheet's content afresh. */
  readonly opening: number;
}

/**
 * What a sheet shows: `value` while it is open, and the last one while it
 * fades out, until `closed` is called once the sheet has closed, from the
 * dialog's `onOpenChangeComplete`. `value` must keep its identity between
 * renders while it stays the same, as state does.
 */
export function useHeldWhileClosing<T>(value: T | null): {
  readonly held: Held<T> | null;
  readonly closed: () => void;
} {
  const open = value !== null;
  const [wasOpen, setWasOpen] = useState(false);
  const [held, setHeld] = useState<Held<T> | null>(null);
  // Stored during render, as React allows for state derived from a previous render.
  if (open !== wasOpen) setWasOpen(open);
  if (value !== null && (held?.value !== value || !wasOpen)) {
    const opening = (held?.opening ?? 0) + (wasOpen ? 0 : 1);
    setHeld({ value, opening });
  }
  return {
    held,
    closed: () => {
      if (!open) setHeld(null);
    },
  };
}
