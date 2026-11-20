// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * The frame of a structured entry in the timeline. `attention` marks a card
 * that waits on the operator; its header says so in words as well.
 */
export function CardFrame({
  icon,
  title,
  attention = false,
  children,
  className,
}: {
  icon: ReactNode;
  title: string;
  attention?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "mt-2 w-full max-w-[min(36rem,92%)] self-start rounded-md border bg-surface",
        attention ? "border-waiting/45" : "border-border",
        className,
      )}
    >
      <header
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2 text-xs font-medium",
          attention
            ? "border-waiting/25 bg-waiting-surface text-waiting"
            : "border-border text-muted-foreground",
        )}
      >
        <span className="flex size-4 items-center justify-center [&_svg]:size-3.5" aria-hidden>
          {icon}
        </span>
        {title}
      </header>
      <div className="flex flex-col gap-3 px-3 py-3">{children}</div>
    </section>
  );
}
