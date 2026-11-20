// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApprovalDecision, ApprovalEntry } from "@j3-bots/contracts";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, ShieldCheckIcon, ShieldXIcon, ShieldIcon } from "lucide-react";
import { useI18n } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { CardFrame } from "./CardFrame";
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

const code = "rounded-md bg-code-background px-2.5 py-2 font-mono text-xs leading-5";

/**
 * A bot asking to do one exact thing its permission mode does not allow
 * outright. While it waits, everything the action will do is on the card, so
 * nobody approves from a summary; a decided card folds that away.
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
  const { status } = entry;
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
  return (
    <CardFrame icon={icon} title={t(kindTitle[entry.kind])} attention={pending} entryId={entry.id}>
      <code className={cn(code, "block break-all whitespace-pre-wrap")}>{entry.action}</code>
      {entry.detail !== null &&
        (pending ? (
          // Focusable, so the keyboard can scroll a long plan before deciding.
          <pre
            role="region"
            aria-label={t("approval.detail")}
            tabIndex={0}
            className={cn(
              code,
              "max-h-64 overflow-auto whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-accent",
            )}
          >
            {entry.detail}
          </pre>
        ) : (
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
              {t("approval.showDetail")}
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-slow) ease-standard data-ending-style:h-0 data-starting-style:h-0">
              <pre className={cn(code, "mt-2 max-h-64 overflow-auto whitespace-pre-wrap")}>
                {entry.detail}
              </pre>
            </Collapsible.Panel>
          </Collapsible.Root>
        ))}
      {pending ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" disabled={submitting} onClick={() => onDecide("deny")}>
            {t("approval.deny")}
          </Button>
          {entry.allowsSession && (
            <Button size="sm" disabled={submitting} onClick={() => onDecide("allow-session")}>
              {t("approval.allowSession")}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
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
