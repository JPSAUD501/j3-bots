// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApprovalDecision, ApprovalEntry } from "@j3-bots/contracts";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, ShieldCheckIcon, ShieldXIcon, ShieldIcon } from "lucide-react";
import { useI18n } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
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

/** A bot asking to do one exact thing its permission mode does not allow outright. */
export function ApprovalCard({
  entry,
  onDecide,
}: {
  entry: ApprovalEntry;
  onDecide: (decision: ApprovalDecision) => void;
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
    <CardFrame icon={icon} title={t(kindTitle[entry.kind])} attention={pending}>
      <code className="block rounded-md bg-code-background px-2.5 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
        {entry.action}
      </code>
      {entry.detail && (
        <Collapsible.Root>
          <Collapsible.Trigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon
              className="size-3.5 transition-transform duration-(--duration-state) group-data-panel-open:rotate-90"
              aria-hidden
            />
            {t("approval.showDetail")}
          </Collapsible.Trigger>
          <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-slow) ease-standard data-ending-style:h-0 data-starting-style:h-0">
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-code-background px-2.5 py-2 font-mono text-xs leading-5">
              {entry.detail}
            </pre>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      {pending ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="destructive-outline" size="sm" onClick={() => onDecide("deny")}>
            {t("approval.deny")}
          </Button>
          {entry.allowsSession && (
            <Button size="sm" onClick={() => onDecide("allow-session")}>
              {t("approval.allowSession")}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => onDecide("allow-once")}>
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
