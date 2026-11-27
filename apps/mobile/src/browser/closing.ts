// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n.ts";
import { useSay } from "../toast.tsx";

/** How long Undo stays before a closed tab is closed for good. */
const UNDO_FOR_MS = 5_000;

/** A tab closed a moment ago, which Undo brings back. */
export interface Closed {
  readonly ref: BrowserTabRef;
  /** The bots that were on it, whom the line says carry on. */
  readonly bots: ReadonlyArray<BotId>;
}

/**
 * Closing tabs with Undo instead of a question: a closed tab leaves the
 * list at once and is closed on the server once Undo has passed. Leaving
 * the live view closes what waits at once, as Undo goes with it.
 */
export function useClosingTabs() {
  const client = useJ3Client();
  const say = useSay();
  const { t } = useI18n();
  const [closing, setClosing] = useState<ReadonlySet<BrowserTabRef>>(new Set());
  const [last, setLast] = useState<Closed | null>(null);
  const timers = useRef(new Map<BrowserTabRef, ReturnType<typeof setTimeout>>());

  const send = useCallback(
    (ref: BrowserTabRef) => {
      timers.current.delete(ref);
      void client.closeBrowserTab(ref).then((result) => {
        if (result._tag === "failed") say(t("browser.grid.closeFailed"));
        // The list drops it as the server says so; until then it stays out of sight.
        setClosing((now) => {
          if (result._tag !== "failed") return now;
          const next = new Set(now);
          next.delete(ref);
          return next;
        });
      });
    },
    [client, say, t],
  );

  const close = useCallback(
    (closed: Closed) => {
      setClosing((now) => new Set(now).add(closed.ref));
      setLast(closed);
      timers.current.set(
        closed.ref,
        setTimeout(() => send(closed.ref), UNDO_FOR_MS),
      );
    },
    [send],
  );

  const undo = useCallback(() => {
    if (last === null) return;
    const timer = timers.current.get(last.ref);
    if (timer !== undefined) clearTimeout(timer);
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
    const timer = setTimeout(() => setLast(null), UNDO_FOR_MS);
    return () => clearTimeout(timer);
  }, [last]);

  // Leaving closes what waits for Undo, which goes with the screen.
  useEffect(() => {
    const waiting = timers.current;
    return () => {
      for (const [ref, timer] of waiting) {
        clearTimeout(timer);
        send(ref);
      }
    };
  }, [send]);

  return { closing, last, close, undo };
}
