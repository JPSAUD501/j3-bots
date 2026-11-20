// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApprovalDecision, ApprovalEntry } from "@j3-bots/contracts";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, ShieldCheckIcon, ShieldXIcon, ShieldIcon } from "lucide-react";
import { useI18n } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { CardFrame } from "./CardFrame";
import { CodeLines } from "./CodeLines";
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

const code = "font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere";
const scrolls =
  "max-h-64 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * A bot asking to do one exact thing its permission mode does not allow
 * outright. The exact action is always on the card. While it waits, the card
 * shows one block: the action, then, past a seam, whatever the bot added (what
 * a command will do, a file change's diff), so nobody approves from a summary.
 * A decided card shows the action and folds the rest.
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
  const detailLabel =
    entry.kind === "file-change" ? t("approval.detail.fileChange") : t("approval.detail");
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
    <CardFrame
      icon={icon}
      title={t(kindTitle[entry.kind])}
      attention={pending}
      entryId={entry.id}
      className="@max-tablet:max-w-full"
    >
      {pending ? (
        // One block in two parts, joined by a seam of the card's own surface. The action stays put;
        // only what follows it scrolls, so the action never leaves view.
        <div className="flex flex-col gap-px overflow-hidden rounded-md">
          <pre className={cn(code, "bg-code-background px-2.5 py-2 font-medium")}>
            <CodeLines text={entry.action} />
          </pre>
          {detail !== null && (
            // Focusable, so the keyboard can scroll a long plan or diff before deciding.
            <pre
              role="region"
              aria-label={detailLabel}
              tabIndex={0}
              className={cn(code, scrolls, "bg-code-background px-2.5 py-2")}
            >
              <CodeLines text={detail} />
            </pre>
          )}
        </div>
      ) : (
        <>
          <pre className={cn(code, "rounded-md bg-code-background px-2.5 py-2")}>
            <CodeLines text={entry.action} />
          </pre>
          {detail !== null && (
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
                {entry.kind === "file-change"
                  ? t("approval.showDetail.fileChange")
                  : t("approval.showDetail")}
              </Collapsible.Trigger>
              <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-slow) ease-standard data-ending-style:h-0 data-starting-style:h-0">
                <pre
                  role="region"
                  aria-label={detailLabel}
                  tabIndex={0}
                  className={cn(code, scrolls, "mt-2 rounded-md bg-code-background px-2.5 py-2")}
                >
                  <CodeLines text={detail} />
                </pre>
              </Collapsible.Panel>
            </Collapsible.Root>
          )}
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
          {entry.allowsSession && (
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
