// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalChange,
  ApprovalDecision,
  ApprovalEntry,
  SessionGrant,
} from "@j3-bots/contracts";
import { Collapsible } from "@base-ui/react/collapsible";
import { springs } from "@j3-bots/design-tokens";
import {
  CheckIcon,
  ChevronRightIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  ShieldIcon,
} from "lucide-react";
import { useId, useLayoutEffect } from "react";
import { diffTones } from "@j3-bots/client-runtime/presentation";
import { useI18n } from "../app/context";
import type { KeyWith } from "@j3-bots/i18n";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { useFocusAfterActions } from "../lib/useFocusAfterActions";
import { useFocusReplacement } from "../lib/useFocusReplacement";
import { play } from "../lib/motion";
import { CardActions, CardFrame, useClosedHere } from "./CardFrame";
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

const summaryOnly: Record<ApprovalEntry["kind"], KeyWith> = {
  command: "approval.summaryOnly.command",
  "file-change": "approval.summaryOnly.fileChange",
  "file-read": "approval.summaryOnly.fileRead",
  tool: "approval.summaryOnly.tool",
  other: "approval.summaryOnly.other",
};

// What "Allow for session" allows from then on, in words: under the buttons, naming the button, so
// on a phone it never reads as the consequence of the full-width button above it.
const grantScope: Record<SessionGrant["covers"], KeyWith> = {
  "every-command": "approval.grant.everyCommand",
  "every-file-change": "approval.grant.everyFileChange",
};

// The same, on a card where it was chosen.
const grantedScope: Record<SessionGrant["covers"], KeyWith> = {
  "every-command": "approval.granted.everyCommand",
  "every-file-change": "approval.granted.everyFileChange",
};

// A new or deleted file is said beside its path; an update needs no word.
const operationLabel: Record<NonNullable<ApprovalChange["operation"]>, KeyWith | null> = {
  add: "approval.operation.add",
  delete: "approval.operation.delete",
  update: null,
};

const code = "font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere";
// A bounded area that shows, by a shade at its edge, that more lies past it, and that the keyboard
// can scroll before deciding.
const scrolls =
  "code-scroll-shade max-h-64 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * A bot asking to do one thing its permission mode does not allow outright.
 * What it asks is always on the card, exactly as the engine recorded it: the
 * whole command, or a file change's path and its diff, coloured by line, or a
 * new or deleted file's contents, set plain and labelled beside the path. Why it
 * asks, when the provider said, is a quiet line above, never mixed into it.
 * When the provider shared only a summary, the card says so in words and sets
 * the summary as prose, not code; it can still be allowed once, so a bot never
 * stalls on such a provider, but never for the whole session. A grant for the
 * session says, under the buttons and naming its button, what it will allow
 * from then on.
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
  const { status, detail, sessionGrant } = entry;
  const pending = status._tag === "pending";
  const scopeId = useId();
  const outcomeId = useId();
  const scope = sessionGrant === null ? null : t(grantScope[sessionGrant.covers]);
  // Answered, the buttons and the pending diff go, and focus that was in them moves to the card. The
  // command stays, and so does focus in it.
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  // While it waits, the summary can give way to the exact action once the engine has it; focus in
  // the summary moves to what replaces it.
  const replacement = useFocusReplacement();
  const replaceable = pending ? replacement : undefined;
  // Decided while on screen, the buttons fold away and the outcome settles in; allowed, the card
  // gives one small pulse and its check draws.
  const { waitedHere, closedHere } = useClosedHere(pending);
  const allowed = status._tag === "decided" && status.decision !== "deny";
  useLayoutEffect(() => {
    const card = target.current;
    if (!closedHere || !allowed || card === null) return;
    play(
      card,
      [
        { transform: "scale(1)" },
        { transform: "scale(1.035)", offset: 0.3 },
        { transform: "scale(1)" },
      ],
      springs.pop,
    );
  }, [closedHere, allowed, target]);
  // While a decision is on its way the buttons stay focusable but take no second one.
  const decide = (decision: ApprovalDecision) => () => {
    if (!submitting) onDecide(decision);
  };
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
  // A new or deleted file's text is its contents; anything else's is the change.
  const wholeFile = detail?.operation === "add" || detail?.operation === "delete";
  // A file change's text, focusable so the keyboard can scroll it. Only an update's is a diff: a
  // new file's contents can start lines with `-` or `+` too.
  const diff = (className?: string) =>
    detail !== null && (
      <pre
        role="region"
        aria-label={t(wholeFile ? "approval.contents" : "approval.change")}
        tabIndex={0}
        ref={replaceable}
        className={cn(code, scrolls, "py-2", className)}
        {...(pending ? actions : {})}
      >
        <CodeLines
          text={detail.text}
          {...(detail.operation === "update" ? { tones: diffTones } : {})}
          inset
        />
      </pre>
    );
  const operation =
    detail === null || detail.operation === null ? null : operationLabel[detail.operation];
  // The changed file's path, with what happens to it when that is more than a change in place:
  // beside the path, or under it on a phone, where beside it would squeeze the path.
  const paths = (className?: string) => (
    <div
      className={cn(
        "flex items-start gap-2 bg-code-background @max-tablet:flex-col @max-tablet:gap-0",
        className,
      )}
    >
      <pre className={cn(code, "min-w-0 flex-1 py-2", pending && "font-medium")}>
        <CodeLines text={entry.action} inset />
      </pre>
      {operation !== null && (
        <span className="shrink-0 py-2 pe-2.5 text-2xs leading-5 text-muted-foreground @max-tablet:ps-2.5 @max-tablet:pt-0">
          {t(operation)}
        </span>
      )}
    </div>
  );
  return (
    <CardFrame
      ref={target}
      icon={icon}
      title={t(kindTitle[entry.kind])}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      {entry.reason !== null && (
        <p className="text-xs text-muted-foreground whitespace-pre-line">{entry.reason}</p>
      )}
      {!entry.exact ? (
        <div className="flex flex-col gap-1.5">
          {pending ? (
            <p className="text-xs font-medium">{t(summaryOnly[entry.kind])}</p>
          ) : (
            // Decided or expired, the record still says what was decided on.
            <p className="text-2xs text-muted-foreground">{t("approval.summaryQualifier")}</p>
          )}
          <p
            role="region"
            aria-label={t("approval.summary")}
            tabIndex={0}
            ref={replaceable}
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
          ref={replaceable}
          className={cn(code, scrolls, "rounded-md py-2")}
          {...(pending ? actions : {})}
        >
          <CodeLines text={entry.action} inset />
        </pre>
      ) : pending ? (
        // One block in two parts, joined by a seam of the card's own surface. The paths stay put;
        // only the diff scrolls, so they never leave view.
        <div className="flex flex-col gap-px overflow-hidden rounded-md">
          {paths()}
          {diff()}
        </div>
      ) : (
        <>
          {paths("rounded-md")}
          <Collapsible.Root>
            <Collapsible.Trigger
              className={cn(
                "group inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground",
                touchTarget,
              )}
            >
              <ChevronRightIcon
                className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90"
                aria-hidden
              />
              {t(wholeFile ? "approval.showFile" : "approval.showChange")}
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-starting-style:h-0">
              {diff("mt-2 rounded-md")}
            </Collapsible.Panel>
          </Collapsible.Root>
        </>
      )}
      {waitedHere && (
        <CardActions open={pending}>
          {/* On a phone the buttons fill the row and share it; when they wrap, each row stays full,
            so they still read as one group. */}
          <div className="flex flex-col gap-2" {...actions}>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                className="@max-tablet:grow"
                aria-disabled={submitting}
                onClick={decide("deny")}
              >
                {t("approval.deny")}
              </Button>
              {scope !== null && (
                <Button
                  size="sm"
                  className="@max-tablet:grow"
                  aria-disabled={submitting}
                  aria-describedby={scopeId}
                  onClick={decide("allow-session")}
                >
                  {t("approval.allowSession")}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                className="@max-tablet:grow"
                aria-disabled={submitting}
                onClick={decide("allow-once")}
              >
                {t("approval.allowOnce")}
              </Button>
            </div>
            {scope !== null && (
              <p id={scopeId} className="text-end text-2xs text-muted-foreground">
                {scope}
              </p>
            )}
          </div>
        </CardActions>
      )}
      {!pending && (
        <div id={outcomeId} className={cn("flex flex-col gap-0.5", closedHere && "arrive")}>
          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              status._tag === "decided" && status.decision === "deny"
                ? "text-blocked"
                : allowed
                  ? "text-success"
                  : "text-muted-foreground",
            )}
          >
            {allowed && (
              <CheckIcon aria-hidden className={cn("size-3.5", closedHere && "draw-check")} />
            )}
            {status._tag === "decided"
              ? t(decisionText[status.decision])
              : status._tag === "refused"
                ? t("approval.refused")
                : t("approval.expired")}
          </p>
          {status._tag === "decided" &&
            status.decision === "allow-session" &&
            sessionGrant !== null && (
              <p className="text-2xs text-muted-foreground">
                {t(grantedScope[sessionGrant.covers])}
              </p>
            )}
        </div>
      )}
    </CardFrame>
  );
}
