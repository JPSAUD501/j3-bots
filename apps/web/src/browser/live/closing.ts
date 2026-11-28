// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeFailed } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBrowser } from "../context";

/** How long Undo stays before a closed tab is closed for good. */
const UNDO_FOR_MS = 5_000;

/** A tab closed a moment ago, which Undo brings back. */
export interface Closed {
  readonly ref: BrowserTabRef;
  /** The bots that were on it, whom the line says carry on. */
  readonly bots: ReadonlyArray<BotId>;
}

/**
 * Closing tabs with Undo instead of a question, as the phone does: a closed
 * tab leaves the list at once and is closed on the server once Undo has
 * passed. Leaving the live view closes what waits at once, as Undo goes
 * with it. `onFailed` hears of a close the server refused; the tab comes
 * back to the list.
 */
export function useClosingTabs(onFailed: () => void) {
  const { source } = useBrowser();
  const [closing, setClosing] = useState<ReadonlySet<BrowserTabRef>>(new Set());
  const [last, setLast] = useState<Closed | null>(null);
  const timers = useRef(new Map<BrowserTabRef, number>());
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

  const send = useCallback(
    (ref: BrowserTabRef) => {
      timers.current.delete(ref);
      void source.closeBrowserTab(ref).then((result) => {
        if (!closeFailed(result)) return;
        failed.current();
        // The list drops a closed tab as the server says so; one it refused comes back.
        setClosing((now) => {
          const next = new Set(now);
          next.delete(ref);
          return next;
        });
      });
    },
    [source],
  );

  const close = useCallback(
    (closed: Closed) => {
      setClosing((now) => new Set(now).add(closed.ref));
      setLast(closed);
      timers.current.set(
        closed.ref,
        window.setTimeout(() => send(closed.ref), UNDO_FOR_MS),
      );
    },
    [send],
  );

  const undo = useCallback(() => {
    if (last === null) return;
    window.clearTimeout(timers.current.get(last.ref));
    timers.current.delete(last.ref);
    setClosing((now) => {
      const next = new Set(now);
      next.delete(last.ref);
      return next;
    });
    setLast(null);
  }, [last]);

  // Undo shows only while it can still undo.
  useEffect(() => {
    if (last === null) return;
    const timer = window.setTimeout(() => setLast(null), UNDO_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [last]);

  // Leaving closes what waits for Undo, which goes with the live view.
  useEffect(() => {
    const waiting = timers.current;
    return () => {
      for (const [ref, timer] of waiting) {
        window.clearTimeout(timer);
        send(ref);
      }
    };
  }, [send]);

  return { closing, last, close, undo };
}
