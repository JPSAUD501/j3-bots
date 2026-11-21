// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoutineChangeEntry } from "@j3-bots/contracts";
import { CalendarClockIcon, CirclePauseIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import { usePresentation } from "../app/context";
import type { KeyWith } from "@j3-bots/i18n";
import { scheduleInWords } from "../lib/schedule";

const changeText: Record<RoutineChangeEntry["change"], KeyWith> = {
  created: "routine.change.created",
  updated: "routine.change.updated",
  paused: "routine.change.paused",
  resumed: "routine.change.resumed",
  deleted: "routine.change.deleted",
};

/** A routine was created or changed: the exact schedule it now has, in words. */
export function RoutineChangeCard({
  entry,
  onOpen,
}: {
  entry: RoutineChangeEntry;
  onOpen: () => void;
}) {
  const ctx = usePresentation();
  const words = scheduleInWords(entry.trigger, ctx);
  const Icon =
    entry.change === "deleted"
      ? Trash2Icon
      : entry.change === "paused"
        ? CirclePauseIcon
        : entry.trigger._tag === "webhook"
          ? WebhookIcon
          : CalendarClockIcon;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={entry.change === "deleted"}
      className="mt-2 flex w-full max-w-(--layout-compact-card-width) items-center gap-3 self-start rounded-md border border-border bg-surface px-3 py-2.5 text-start transition-colors duration-(--duration-fast) enabled:hover:bg-muted"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-2xs text-muted-foreground">
          {ctx.i18n.t(changeText[entry.change])}
        </span>
        <span className="truncate text-sm font-medium">{entry.name}</span>
        {entry.change !== "deleted" && (
          <span className="truncate text-xs text-muted-foreground">
            {words ?? (entry.trigger._tag === "schedule" ? entry.trigger.cron : "")}
          </span>
        )}
      </span>
    </button>
  );
}
