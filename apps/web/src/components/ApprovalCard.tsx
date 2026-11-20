// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApprovalDecision, ApprovalEntry } from "@j3-bots/contracts";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, ShieldCheckIcon, ShieldXIcon, ShieldIcon } from "lucide-react";
import { useI18n } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { CardFrame } from "./CardFrame";
import { CodeLines, diffTone } from "./CodeLines";
import { Button } from "./ui/button";

const kindTitle: Record<ApprovalEntry["kind"], KeyWith> = {
  command: "approval.kind.command",
  "file-change": "approval.kind.fileChange",
  "file-read": "approval.kind.fileRead",
  tool: "approval.kind.tool",
  other: "approval.kind.other",
};

const decisionText: Record<ApprovalDecision, KeyWith> = {
  "allow-once": "approval.allowedOnce",
  "allow-session": "approval.allowedSession",
  deny: "approval.denied",
};

const summaryOnly: Record<ApprovalEntry["kind"], KeyWith> = {
  command: "approval.summaryOnly.command",
  "file-change": "approval.summaryOnly.fileChange",
  "file-read": "approval.summaryOnly.fileRead",
  tool: "approval.summaryOnly.tool",
  other: "approval.summaryOnly.other",
};

const code = "font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere";
// A bounded area that shows, by a shade at its edge, that more lies past it, and that the keyboard
// can scroll before deciding.
const scrolls =
  "code-scroll-shade max-h-64 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * A bot asking to do one thing its permission mode does not allow outright.
 * What it asks is always on the card, exactly as the engine recorded it: the
 * whole command, or a file change's path and diff, coloured by line. Why it
 * asks, when the provider said, is a quiet line above, never mixed into it.
 * When the provider shared only a summary, the card says so in words and sets
 * the summary as prose, not code; it can still be allowed once, so a bot never
 * stalls on such a provider, but never for the whole session.
 */
export function ApprovalCard({
  entry,
  onDecide,
  submitting = false,
}: {
  entry: ApprovalEntry;
  onDecide: (decision: ApprovalDecision) => void;
  /** A decision is on its way: the card takes no second one. */
  submitting?: boolean;
}) {
  const { t } = useI18n();
  const { status, detail } = entry;
  const pending = status._tag === "pending";
  const icon =
    status._tag === "decided" ? (
      status.decision === "deny" ? (
        <ShieldXIcon />
      ) : (
        <ShieldCheckIcon />
      )
    ) : (
      <ShieldIcon />
    );
  // A file change's diff, focusable so the keyboard can scroll it.
  const diff = (className?: string) =>
    detail !== null && (
      <pre
        role="region"
        aria-label={t("approval.change")}
        tabIndex={0}
        className={cn(code, scrolls, "px-2.5 py-2", className)}
      >
        <CodeLines text={detail} tone={diffTone} />
      </pre>
    );
  return (
    <CardFrame icon={icon} title={t(kindTitle[entry.kind])} attention={pending} entryId={entry.id}>
      {entry.reason !== null && (
        <p className="text-xs text-muted-foreground whitespace-pre-line">{entry.reason}</p>
      )}
      {!entry.exact ? (
        <div className="flex flex-col gap-1.5">
          {pending && <p className="text-xs font-medium">{t(summaryOnly[entry.kind])}</p>}
          <p
            role="region"
            aria-label={t("approval.action")}
            tabIndex={0}
            className={cn(
              scrolls,
              "rounded-md px-2.5 py-2 text-sm whitespace-pre-wrap wrap-anywhere",
            )}
          >
            {entry.action}
          </p>
        </div>
      ) : detail === null ? (
        // The action alone, such as a whole command: it scrolls when long, and the keyboard can
        // scroll it.
        <pre
          role="region"
          aria-label={t("approval.action")}
          tabIndex={0}
          className={cn(code, scrolls, "rounded-md px-2.5 py-2")}
        >
          <CodeLines text={entry.action} />
        </pre>
      ) : pending ? (
        // One block in two parts, joined by a seam of the card's own surface. The paths stay put;
        // only the diff scrolls, so they never leave view.
        <div className="flex flex-col gap-px overflow-hidden rounded-md">
          <pre className={cn(code, "bg-code-background px-2.5 py-2 font-medium")}>
            <CodeLines text={entry.action} />
          </pre>
          {diff()}
        </div>
      ) : (
        <>
          <pre className={cn(code, "rounded-md bg-code-background px-2.5 py-2")}>
            <CodeLines text={entry.action} />
          </pre>
          <Collapsible.Root>
            <Collapsible.Trigger
              className={cn(
                "group inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground",
                touchTarget,
              )}
            >
              <ChevronRightIcon
                className="size-3.5 transition-transform duration-(--duration-state) group-data-panel-open:rotate-90"
                aria-hidden
              />
              {t("approval.showChange")}
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-slow) ease-standard data-ending-style:h-0 data-starting-style:h-0">
              {diff("mt-2 rounded-md")}
            </Collapsible.Panel>
          </Collapsible.Root>
        </>
      )}
      {pending ? (
        // On a phone the buttons fill the row and share it; when they wrap, each row stays full, so
        // they still read as one group.
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            className="@max-tablet:grow"
            disabled={submitting}
            onClick={() => onDecide("deny")}
          >
            {t("approval.deny")}
          </Button>
          {/* No blanket grant for an action nobody has seen exactly. */}
          {entry.allowsSession && entry.exact && (
            <Button
              size="sm"
              className="@max-tablet:grow"
              disabled={submitting}
              onClick={() => onDecide("allow-session")}
            >
              {t("approval.allowSession")}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            className="@max-tablet:grow"
            disabled={submitting}
            onClick={() => onDecide("allow-once")}
          >
            {t("approval.allowOnce")}
          </Button>
        </div>
      ) : (
        <p
          className={
            status._tag === "decided" && status.decision === "deny"
              ? "text-xs text-blocked"
              : "text-xs text-muted-foreground"
          }
        >
          {status._tag === "decided" ? t(decisionText[status.decision]) : t("approval.expired")}
        </p>
      )}
    </CardFrame>
  );
}
