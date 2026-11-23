// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion } from "@j3-bots/design-tokens";
import { useEffect, useEffectEvent, useState } from "react";

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
 * announced once. It sits at the top, clear of the composer however tall that
 * grows, drops in on `pop` and lifts away on the quicker `out` ease.
 */
export function Toast({ notice, onDone }: { notice: Notice | null; onDone: () => void }) {
  return (
    // `aria-live` keeps the region heard while a modal hides the rest of the
    // page from assistive tech: Base UI leaves out every `[aria-live]` element.
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-4 top-[calc(var(--inset-top)+--spacing(3))] z-50 flex justify-center"
    >
      {notice && <Shown key={notice.id} notice={notice} onDone={onDone} />}
    </div>
  );
}

function Shown({ notice, onDone }: { notice: Notice; onDone: () => void }) {
  // The notice keeps its time, however often `onDone` is a new function.
  const done = useEffectEvent(onDone);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLeaving(true), SHOWN_FOR);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(done, motion.state);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return (
    <p
      data-leaving={leaving ? "" : undefined}
      className="max-w-sm animate-[toast-in_var(--duration-pop)_var(--ease-pop)] rounded-lg bg-foreground px-4 py-2.5 text-sm text-background shadow-overlay data-leaving:animate-[toast-out_var(--duration-state)_var(--ease-out)_forwards]"
    >
      {notice.text}
    </p>
  );
}
