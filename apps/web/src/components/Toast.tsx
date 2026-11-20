// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useEffectEvent, useState } from "react";
import { cn } from "../lib/cn";

/** How long a notice stays: long enough to read twice. */
const SHOWN_FOR = 6000;

/** A short sentence, and at most one thing the operator can do about it. */
export interface Notice {
  readonly id: number;
  readonly text: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
}

/**
 * A short sentence about something that just went wrong out of view, such as
 * a file that could not be opened. It goes by itself. A notice with an action
 * stays twice as long, and for as long as the pointer or the focus is on it.
 * The region is always there, so each new notice is announced once.
 */
export function Toast({ notice, onDone }: { notice: Notice | null; onDone: () => void }) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+--spacing(20))] z-50 flex justify-center"
    >
      {notice && <Shown key={notice.id} notice={notice} onDone={onDone} />}
    </div>
  );
}

function Shown({ notice, onDone }: { notice: Notice; onDone: () => void }) {
  const { action } = notice;
  // Each holds the notice on its own: leaving with the pointer keeps it while it has the focus.
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = pointed || focused;
  // The notice keeps its time, however often `onDone` is a new function.
  const done = useEffectEvent(onDone);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(done, action === null ? SHOWN_FOR : SHOWN_FOR * 2);
    return () => window.clearTimeout(timer);
  }, [held, action]);
  return (
    <div
      className={cn(
        "flex max-w-sm items-center gap-3 rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-lg",
        action !== null && "pointer-events-auto",
      )}
      onPointerEnter={() => setPointed(true)}
      onPointerLeave={() => setPointed(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <p>{notice.text}</p>
      {action !== null && (
        <button
          type="button"
          className="shrink-0 rounded-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background"
          onClick={() => {
            action.run();
            onDone();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
