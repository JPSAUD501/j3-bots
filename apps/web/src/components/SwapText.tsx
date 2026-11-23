// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { cn } from "../lib/cn";
import { reducedMotion } from "../lib/motion";

interface Line {
  readonly key: number;
  readonly text: string;
  /** It came after the first: it rises in. */
  readonly rising: boolean;
  /** A newer line took its place: it leaves upward, then goes. */
  readonly leaving: boolean;
}

/**
 * One line of status that changes in place: the old line leaves upward as the
 * new one rises in, on `--duration-swap` and the `out` ease. The first line,
 * and every line under reduced motion, shows as it is. Only the current line
 * reaches assistive technology. The line keeps one line's height and cuts
 * what does not fit with an ellipsis.
 */
export function SwapText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const [state, setState] = useState<{
    readonly text: string;
    readonly lines: ReadonlyArray<Line>;
  }>(() => ({ text, lines: [{ key: 0, text, rising: false, leaving: false }] }));
  if (state.text !== text) {
    const key = (state.lines.at(-1)?.key ?? 0) + 1;
    const next: Line = { key, text, rising: true, leaving: false };
    setState({
      text,
      lines: reducedMotion()
        ? [{ ...next, rising: false }]
        : [
            ...state.lines
              .filter((line) => !line.leaving)
              .map((line) => ({ ...line, leaving: true })),
            next,
          ],
    });
  }
  const gone = (key: number) =>
    setState((current) => ({
      ...current,
      lines: current.lines.filter((line) => line.key !== key),
    }));
  return (
    <span className={cn("inline-grid max-w-full overflow-hidden align-bottom", className)}>
      {state.lines.map((line) => (
        <span
          key={line.key}
          aria-hidden={line.leaving || undefined}
          onAnimationEnd={line.leaving ? () => gone(line.key) : undefined}
          className={cn(
            "col-start-1 row-start-1 truncate",
            line.leaving ? "swap-out" : line.rising && "swap-in",
          )}
        >
          {line.text}
        </span>
      ))}
    </span>
  );
}
