// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useEffectEvent } from "react";

/** How long a notice stays: long enough to read twice. */
const SHOWN_FOR = 6000;

/**
 * A short sentence about something that just went wrong out of view, such as
 * a file that could not be opened. It goes by itself. The region is always
 * there, so each new notice is announced once.
 */
export function Toast({
  notice,
  onDone,
}: {
  notice: { readonly id: number; readonly text: string } | null;
  onDone: () => void;
}) {
  const id = notice?.id ?? null;
  // Each notice gets its own time, however often `onDone` is a new function.
  const done = useEffectEvent(onDone);
  useEffect(() => {
    if (id === null) return;
    const timer = window.setTimeout(done, SHOWN_FOR);
    return () => window.clearTimeout(timer);
  }, [id]);
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+--spacing(20))] z-50 flex justify-center"
    >
      {notice && (
        <p
          key={notice.id}
          className="max-w-sm rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-lg"
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
