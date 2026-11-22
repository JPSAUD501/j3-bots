// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { Loaded, RoutineRuns as Runs } from "@j3-bots/client-runtime";
import { routineLines, routineRunLines } from "@j3-bots/client-runtime/wording";
import type { Routine, RoutineRun } from "@j3-bots/contracts";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleMinusIcon,
  CircleSlashIcon,
  CircleXIcon,
  type LucideIcon,
  XIcon,
} from "lucide-react";
import { useId } from "react";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";

const RUN_ICON: Record<RoutineRun["status"], readonly [LucideIcon, string]> = {
  running: [CircleDotIcon, "text-accent"],
  delivered: [CircleCheckIcon, "text-success"],
  silent: [CircleMinusIcon, "text-muted-foreground"],
  failed: [CircleXIcon, "text-blocked"],
  skipped: [CircleSlashIcon, "text-muted-foreground"],
};

/** One run: what it did and when, why it failed or was skipped, and what it noted. */
function RunRow({ run }: { readonly run: RoutineRun }) {
  const ctx = usePresentation();
  const lines = routineRunLines(run, ctx);
  const [Icon, tone] = RUN_ICON[run.status];
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-3">
          <span className={cn("text-sm", lines.failed && "text-blocked")}>{lines.status}</span>
          <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {lines.when}
          </span>
        </div>
        {lines.reason !== null && (
          <p className={cn("text-xs", lines.failed ? "text-blocked" : "text-muted-foreground")}>
            {lines.reason}
          </p>
        )}
        {lines.attempts !== null && (
          <p className="text-2xs text-muted-foreground">{lines.attempts}</p>
        )}
        {run.note !== null && (
          <p className="mt-1 border-s-2 border-border ps-2 text-xs whitespace-pre-wrap wrap-anywhere text-muted-foreground">
            {run.note}
          </p>
        )}
      </div>
    </li>
  );
}

export interface RoutineRunListProps {
  /** The routine as its bot's details hold it; null once it is gone, or before they load. */
  readonly routine: Routine | null;
  /** Its newest runs; null before they are asked for. */
  readonly runs: Loaded<Runs> | null;
}

/**
 * A routine's recent runs, newest first, under its schedule and when it runs
 * next: whether each reported back, had nothing to say, failed and why, or
 * was skipped.
 */
export function RoutineRunList({ routine, runs }: RoutineRunListProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  if (runs?._tag === "not-found") {
    return <p className="px-4 py-4 text-sm text-muted-foreground">{t("routine.runs.gone")}</p>;
  }
  const lines = routine === null ? null : routineLines(routine, ctx);
  return (
    <div className="flex flex-col">
      {lines !== null && (
        <section className="flex flex-col gap-0.5 border-b border-border px-4 py-4">
          <span className={cn("text-sm", lines.expression && "font-mono")}>{lines.schedule}</span>
          {lines.status !== null && (
            <span className="text-xs text-muted-foreground">{lines.status}</span>
          )}
        </section>
      )}
      <section className="px-4 py-4">
        {/* Until the routine is known, the dialog's title already says what this is. */}
        {routine !== null && (
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t("routine.runs.title")}
          </h3>
        )}
        {runs === null || runs._tag === "loading" ? (
          <p className="text-xs text-muted-foreground">{t("details.loading")}</p>
        ) : runs.value.runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("routine.runs.empty")}</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border">
              {runs.value.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
            {runs.value.hasOlder && (
              <p className="pt-2 text-2xs text-muted-foreground">
                {t("routine.runs.limit", { count: runs.value.runs.length })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export interface RoutineRunsDialogProps extends RoutineRunListProps {
  readonly open: boolean;
  /** The name shown at the top, kept while the routine loads or after it is gone. */
  readonly name: string;
  readonly onClose: () => void;
  /** Told once the dialog has finished closing, so what it shows can go. */
  readonly onClosed: () => void;
}

/** A routine's recent runs over the conversation: the whole screen on a phone. */
export function RoutineRunsDialog({
  open,
  name,
  onClose,
  onClosed,
  ...list
}: RoutineRunsDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-auto tablet:max-h-[calc(100dvh-6rem)] tablet:max-w-lg`}
        >
          <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-4 pe-2">
            <Dialog.Title id={titleId} className="display-type truncate text-lg">
              {name}
            </Dialog.Title>
            <Button
              variant="ghost-muted"
              size="icon"
              className="ms-auto"
              onClick={onClose}
              aria-label={t("routine.runs.close")}
            >
              <XIcon />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RoutineRunList {...list} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
