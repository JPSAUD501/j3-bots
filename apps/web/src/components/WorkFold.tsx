// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import type { WorkFoldEntry, WorkStep } from "@j3-bots/contracts";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { millisBetween, shortDuration } from "../lib/time";
import { workFoldTitle } from "../presentation/roster";
import { CodeLines } from "./CodeLines";

const stepIcon: Record<WorkStep["kind"], typeof TerminalIcon> = {
  command: TerminalIcon,
  edit: PencilIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  tool: WrenchIcon,
  delegation: BotIcon,
  other: EllipsisIcon,
};

interface WorkFoldProps {
  readonly entry: WorkFoldEntry;
  /** The turn's steps once loaded; null while they load. */
  readonly steps: ReadonlyArray<WorkStep> | null;
  /** Opening the fold is when its steps are worth fetching. */
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultOpen?: boolean;
}

/** A turn's work in one line, "Worked for 2m", that opens to every step. Never opens by itself. */
export function WorkFold({ entry, steps, onOpenChange, defaultOpen = false }: WorkFoldProps) {
  const ctx = usePresentation();
  const { t, plural } = ctx.i18n;
  const { status } = entry;
  const title =
    status._tag === "running"
      ? t("presence.working")
      : workFoldTitle(status.ending, millisBetween(entry.createdAt, status.finishedAt), ctx);
  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      className="mt-2 max-w-(--layout-card-width) self-start"
    >
      <Collapsible.Trigger
        className={cn(
          "group flex items-center gap-1.5 rounded-sm text-xs hover:text-foreground",
          touchTarget,
          status._tag === "finished" && status.ending === "failed"
            ? "text-blocked"
            : "text-muted-foreground",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-(--duration-state) group-data-panel-open:rotate-90"
        />
        <span>{title}</span>
        {entry.stepCount > 0 && (
          <span className="text-muted-foreground">· {plural("work.steps", entry.stepCount)}</span>
        )}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-slow) ease-standard data-ending-style:h-0 data-starting-style:h-0">
        {steps === null ? (
          <p className="py-2 ps-5 text-xs text-muted-foreground">{t("work.loading")}</p>
        ) : (
          <ol className="mt-1.5 flex flex-col border-s border-border ps-3 ms-1.5">
            {steps.map((step) => {
              const Icon = stepIcon[step.kind];
              return (
                <li key={step.id} className="flex min-h-7 items-start gap-2 py-1 text-xs">
                  <Icon aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  {/* Long commands and paths wrap: every step reads in full without a pointer. */}
                  {step.kind === "command" ? (
                    <span className="min-w-0 flex-1 font-mono text-2xs whitespace-pre-wrap wrap-anywhere">
                      <CodeLines text={step.label} />
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 wrap-break-word">{step.label}</span>
                  )}
                  <StepStatus step={step} />
                </li>
              );
            })}
          </ol>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function StepStatus({ step }: { step: WorkStep }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  switch (step.status) {
    case "running":
      return <span className="text-2xs text-muted-foreground">{t("work.stepRunning")}</span>;
    case "failed":
      return <XIcon className="size-3.5 shrink-0 text-blocked" aria-label={t("work.stepFailed")} />;
    case "completed":
      return (
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
          {step.finishedAt &&
            shortDuration(millisBetween(step.startedAt, step.finishedAt), ctx.i18n)}
          <CheckIcon className="size-3.5 shrink-0" aria-label={t("work.stepDone")} />
        </span>
      );
  }
}
