// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- a React hook, which runs on the platform's timers, outside any Effect program.
import { useEffect, useState } from "react";
import type { Readable } from "../Store.ts";
import type { BrowserRefusal } from "../stores/Browser.ts";

/** How long the live view's line says input was not sent, after the last refusal. */
export const REFUSAL_SHOWN_MS = 4_000;

/**
 * Calls `say` with the reason of each refusal `refused` hears from now on,
 * and with null `REFUSAL_SHOWN_MS` after the last: refusals that come while
 * it is said keep it said. A refusal from before is not news. Returns the
 * function that stops it.
 */
export const followRefusals = (
  refused: Readable<BrowserRefusal | null>,
  say: (reason: BrowserRefusal["reason"] | null) => void,
): (() => void) => {
  let seen = refused.get()?.sequence ?? 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = refused.subscribe(() => {
    const refusal = refused.get();
    if (refusal === null || refusal.sequence <= seen) return;
    seen = refusal.sequence;
    say(refusal.reason);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      say(null);
    }, REFUSAL_SHOWN_MS);
  });
  return () => {
    stop();
    if (timer !== null) clearTimeout(timer);
  };
};

/**
 * Why the server refused the view's input, for a few seconds after it last
 * did (`followRefusals`), then null: the live view's line says it once
 * (`liveLine`) and never opens a dialog. `refused` is the view's own, or
 * null while there is none.
 */
export const useRefusedInput = (
  refused: Readable<BrowserRefusal | null> | null,
): BrowserRefusal["reason"] | null => {
  // Kept with the view it came from: another view's refusal is not this one's.
  const [said, setSaid] = useState<{
    readonly from: Readable<BrowserRefusal | null>;
    readonly reason: BrowserRefusal["reason"];
  } | null>(null);
  useEffect(() => {
    if (refused === null) return;
    return followRefusals(refused, (reason) =>
      setSaid(reason === null ? null : { from: refused, reason }),
    );
  }, [refused]);
  return said !== null && said.from === refused ? said.reason : null;
};
