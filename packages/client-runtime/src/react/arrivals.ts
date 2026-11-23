// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { type ArrivalCounts, arrivedRows } from "../presentation/timeline.ts";

const nothing: ReadonlySet<string> = new Set();

/**
 * The rows that arrived at the end of the conversation `scope` names with
 * its last change, by key. Rows count only once the conversation is `ready`:
 * what a loading conversation fills in is what it already had, and moving to
 * another conversation plays nothing.
 */
export function useArrivals(
  scope: string | null,
  keys: ReadonlyArray<string>,
  ready: boolean,
): ReadonlySet<string> {
  const [shown, setShown] = useState<{
    readonly scope: string | null;
    readonly signature: string | null;
    readonly keys: ReadonlyArray<string> | null;
    readonly arrived: ReadonlySet<string>;
  }>({ scope, signature: null, keys: null, arrived: nothing });
  const signature = keys.join("\n");
  // Derived during render, as React allows, so the rows that mount with the change know.
  if (shown.scope !== scope) {
    setShown({ scope, signature: null, keys: null, arrived: nothing });
  } else if (ready && shown.signature !== signature) {
    setShown({ scope, signature, keys, arrived: arrivedRows(shown.keys, keys) });
  }
  return shown.scope === scope ? shown.arrived : nothing;
}

/**
 * Which of `keys`, the things a view of `scope` lists, were already there when
 * it was shown, or came in while it was `loading`: those appear in place, and
 * only what is added after arrives. A new `scope` starts again.
 */
export function useRestored(
  scope: string,
  keys: ReadonlyArray<string>,
  loading: boolean,
): ReadonlySet<string> {
  const [restored, setRestored] = useState(() => ({ scope, keys: new Set(keys) }));
  if (restored.scope !== scope) {
    const next = { scope, keys: new Set(keys) };
    setRestored(next);
    return next.keys;
  }
  if (loading && keys.some((key) => !restored.keys.has(key))) {
    const next = { scope, keys: new Set([...restored.keys, ...keys]) };
    setRestored(next);
    return next.keys;
  }
  return restored.keys;
}

/** Closer than this to the newest entry, in px, a conversation counts as at its end. */
const AT_END = 24;

/** Where the operator is in a conversation that scrolls, and what arrived while they read above. */
export interface ConversationEnd {
  /** The newest entry is in view: what arrives keeps it so. */
  readonly atEnd: boolean;
  /** The operator scrolled well away from the newest entry: over half a view. */
  readonly away: boolean;
  /** Messages others wrote since the operator left the end. */
  readonly unseen: number;
  /** Follows the scroll: how far the view is from the end, and how tall it is, in px. */
  readonly follow: (distance: number, viewport: number) => void;
}

interface EndState {
  readonly scope: string | null;
  readonly atEnd: boolean;
  readonly away: boolean;
  readonly unseen: number;
  /** The arrival last counted. */
  readonly seen: ReadonlySet<string>;
  /** The arrival of the operator's own message that calls for the end, once there was one. */
  readonly endFor: ReadonlySet<string> | null;
}

/**
 * Follows the end of the conversation `scope` names. At its end the view
 * stays on the newest entry as entries arrive. Scrolled up, what others write
 * is counted rather than scrolled to, and what the operator sends brings the
 * view back through `toEnd`. `arrived` is what `useArrivals` found and
 * `counts` what `arrivalCounts` reads in it; each platform feeds `follow` from
 * its own scroll.
 */
export function useConversationEnd(
  scope: string | null,
  arrived: ReadonlySet<string>,
  counts: ArrivalCounts,
  toEnd: () => void,
): ConversationEnd {
  const [state, setState] = useState<EndState>({
    scope,
    atEnd: true,
    away: false,
    unseen: 0,
    seen: arrived,
    endFor: null,
  });
  // Derived during render, as React allows: a new conversation starts again, and each
  // arrival is counted once.
  let next = state;
  if (next.scope !== scope) {
    next = { scope, atEnd: true, away: false, unseen: 0, seen: arrived, endFor: null };
  }
  if (next.seen !== arrived) {
    next = counts.own
      ? { ...next, seen: arrived, endFor: arrived }
      : {
          ...next,
          seen: arrived,
          unseen: next.atEnd ? next.unseen : next.unseen + counts.others,
        };
  }
  if (next !== state) setState(next);

  const goToEnd = useEffectEvent(toEnd);
  const { endFor } = next;
  useEffect(() => {
    if (endFor !== null) goToEnd();
  }, [endFor]);

  const follow = useCallback((distance: number, viewport: number) => {
    const atEnd = distance <= AT_END;
    const away = distance > viewport / 2;
    setState((current) =>
      current.atEnd === atEnd && current.away === away && (!atEnd || current.unseen === 0)
        ? current
        : { ...current, atEnd, away, unseen: atEnd ? 0 : current.unseen },
    );
  }, []);
  return { atEnd: next.atEnd, away: next.away, unseen: next.unseen, follow };
}
