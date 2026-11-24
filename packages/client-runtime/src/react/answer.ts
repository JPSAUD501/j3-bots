// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useEffectEvent, useState } from "react";
import type { IntentResult } from "../intents/Actions.ts";

/** What a read a screen waits on answered: its value, or that it did not. */
export type Answer<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly value: A }
  | { readonly _tag: "failed" };

const loading = { _tag: "loading" } as const;

/**
 * The answer to `load`, read once for each `key` and each retry; null `key`
 * reads nothing. An answer that comes for a key or a retry since replaced is
 * dropped.
 */
export function useAnswer<A>(
  key: string | null,
  load: () => Promise<IntentResult<A>>,
): { readonly answer: Answer<A>; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<{
    readonly key: string;
    readonly attempt: number;
    readonly answer: Answer<A>;
  } | null>(null);
  const read = useEffectEvent(load);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    void read().then((result) => {
      if (!live) return;
      setHeld({
        key,
        attempt,
        answer:
          result._tag === "done" ? { _tag: "ready", value: result.value } : { _tag: "failed" },
      });
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  const answer =
    held !== null && held.key === key && held.attempt === attempt ? held.answer : loading;
  return { answer, retry: () => setAttempt(attempt + 1) };
}
