// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId } from "@j3-bots/contracts";
import { type ReactNode, type Ref, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";

/**
 * The frame of a card that asks the operator for something: an icon in a
 * tile, what the card is about, and while it waits, "Waiting for you" in a
 * calm tag, the frame drawn in the waiting color. On a phone the card takes
 * the full column. The frame can take focus, so "Waiting for you" in the
 * conversation's header can bring the operator to it, and so a card whose
 * actions go away once answered can keep the keyboard's place.
 * `describedBy` names the element that says how the request ended, so focus
 * on the card reads it. `attention` "blocked" draws it in the blocked
 * color instead, for something that failed and needs the operator; `tag`
 * names what the card waits on, or, without attention, where it stands in a
 * quiet tag.
 */
export function CardFrame({
  icon,
  title,
  attention = false,
  tag,
  entryId,
  describedBy,
  ref,
  children,
}: {
  icon: ReactNode;
  title: string;
  attention?: boolean | "blocked";
  tag?: string | undefined;
  entryId: EntryId;
  describedBy?: string | undefined;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const blocked = attention === "blocked";
  const tagText = tag ?? (attention === false ? null : t("card.waiting"));
  return (
    <section
      ref={ref}
      aria-label={title}
      aria-describedby={describedBy}
      data-entry-id={entryId}
      tabIndex={-1}
      className={cn(
        "mt-3 flex w-full max-w-(--layout-card-width) origin-bottom-left scroll-my-4 flex-col gap-3 self-start rounded-bubble border bg-surface p-3.5 shadow-raised transition-[border-color] duration-(--duration-slow) @max-tablet:max-w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        blocked ? "border-blocked/45" : attention ? "border-waiting/45" : "border-border",
      )}
    >
      <header className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-(--duration-slow) [&_svg]:size-4",
            blocked
              ? "bg-blocked-surface text-blocked"
              : attention
                ? "bg-waiting-surface text-waiting"
                : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold">{title}</span>
        {tagText !== null && (
          <span
            className={cn(
              "shrink-0 rounded-pill px-2.5 py-0.5 text-2xs font-medium whitespace-nowrap transition-colors duration-(--duration-slow)",
              blocked
                ? "bg-blocked-surface text-blocked"
                : attention
                  ? "bg-waiting-surface text-waiting"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {tagText}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * Whether a card waited for the operator while it was on screen, and whether
 * it has since closed there: a card closed before it showed plays nothing.
 */
export function useClosedHere(pending: boolean): {
  readonly waitedHere: boolean;
  readonly closedHere: boolean;
} {
  const [waitedHere] = useState(pending);
  return { waitedHere, closedHere: waitedHere && !pending };
}

/**
 * A card's actions, which fold away on a spring once it no longer waits,
 * taking the space and the focus they held with them.
 */
export function CardActions({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      data-open={open}
      inert={!open}
      className="grid grid-rows-[1fr] transition-[grid-template-rows,opacity,margin] duration-(--duration-slide) ease-slide data-[open=false]:-mt-3 data-[open=false]:grid-rows-[0fr] data-[open=false]:opacity-0"
    >
      {/* Inset by the focus ring's reach, so the ring is not clipped. */}
      <div className="-m-1 min-h-0 overflow-hidden p-1">{children}</div>
    </div>
  );
}
