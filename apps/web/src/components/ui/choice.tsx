// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** A bordered row the operator picks, holding a `ChoiceIndicator` and its text. */
export const choiceRow =
  "flex min-h-9 w-full items-start gap-2.5 rounded-md border border-input px-3 py-2 text-start text-sm transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-default data-readonly:cursor-default pointer-coarse:min-h-11";

/**
 * The drawn box or circle of a choice. The row carries the checked state, as
 * `group/option`, so the indicator follows it.
 */
export function ChoiceIndicator({
  shape,
  children,
}: {
  shape: "square" | "round";
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border border-control-off text-background",
        "group-data-checked/option:border-foreground group-data-checked/option:bg-foreground",
        shape === "square" ? "rounded-sm" : "rounded-pill",
      )}
    >
      {children}
    </span>
  );
}
