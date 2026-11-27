// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";
import type { Level } from "./level";

/** How tall each bar stands against the level: the middle ones most, so a voice reads as a voice. */
const WEIGHTS = [0.55, 0.85, 1, 0.75, 0.5] as const;
/** The least a bar shows, so silence still reads as a meter. */
const REST = 0.14;
/** How much of the last frame's height a bar keeps: it falls back smoothly rather than flickering. */
const FALL = 0.82;

/**
 * A microphone's level as five bars, live: what the operator says moves them.
 * They are drawn each frame from `level`, read while they show, outside React. It is information,
 * not decoration, so it moves under reduced motion too.
 */
export function LevelBars({
  level,
  label,
  className,
}: {
  readonly level: Level;
  readonly label: string;
  readonly className?: string;
}) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    const reading = level.open();
    let shown = 0;
    let frame = 0;
    const draw = () => {
      shown = Math.max(reading.read(), shown * FALL);
      bars.current.forEach((bar, index) => {
        if (bar === null) return;
        const weight = WEIGHTS[index] ?? 1;
        bar.style.transform = `scaleY(${REST + (1 - REST) * shown * weight})`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      reading.close();
    };
  }, [level]);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-flex h-5 items-center gap-0.75", className)}
    >
      {WEIGHTS.map((weight, index) => (
        <span
          key={weight}
          ref={(bar) => {
            bars.current[index] = bar;
          }}
          className="h-full w-0.75 origin-center scale-y-[0.14] rounded-pill bg-current"
        />
      ))}
    </span>
  );
}
