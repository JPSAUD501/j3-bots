// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId } from "@j3-bots/contracts";
import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn";

/**
 * The frame of a card that asks the operator for something. `attention` marks
 * one still waiting; its header says so in words as well. On a phone the card
 * takes the full column. The frame can take focus, so "Waiting for you" in the
 * header can bring the operator to it, and so a card whose actions go away
 * once answered can keep the keyboard's place. `describedBy` names the element
 * that says how the request ended, so focus on the card reads it.
 */
export function CardFrame({
  icon,
  title,
  attention = false,
  entryId,
  describedBy,
  ref,
  children,
}: {
  icon: ReactNode;
  title: string;
  attention?: boolean;
  entryId: EntryId;
  describedBy?: string | undefined;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <section
      ref={ref}
      aria-label={title}
      aria-describedby={describedBy}
      data-entry-id={entryId}
      tabIndex={-1}
      className={cn(
        "mt-2 w-full max-w-(--layout-card-width) scroll-my-4 @max-tablet:max-w-full self-start rounded-md border bg-surface outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        attention ? "border-waiting/45" : "border-border",
      )}
    >
      {/* The header's top corners follow the inside edge of the card's border, so a filled header
          keeps the card's silhouette. */}
      <header
        className={cn(
          "flex items-center gap-2 rounded-t-[calc(var(--radius-md)-1px)] border-b px-3 py-2 text-xs font-medium",
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
