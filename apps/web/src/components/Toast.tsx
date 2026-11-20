// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useEffectEvent } from "react";

/** How long a notice stays: long enough to read twice. */
const SHOWN_FOR = 6000;

/** A short sentence. */
export interface Notice {
  readonly id: number;
  readonly text: string;
}

/**
 * A short sentence about something that just happened out of view, such as
 * a file that could not be opened or a fresh start done. It goes by itself,
 * and asks nothing of the operator: what they can act on stays where they
 * act, until they do. The region is always there, so each new notice is
 * announced once.
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
  // The notice keeps its time, however often `onDone` is a new function.
  const done = useEffectEvent(onDone);
  useEffect(() => {
    const timer = window.setTimeout(done, SHOWN_FOR);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p className="max-w-sm rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-lg">
      {notice.text}
    </p>
  );
}
