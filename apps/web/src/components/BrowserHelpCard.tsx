// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserHelpEntry } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import { AppWindowIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useFocusAfterActions } from "../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "./CardFrame";
import { Button } from "./ui/button";

const reasonText: Record<BrowserHelpEntry["reason"], KeyWith> = {
  captcha: "browserHelp.reason.captcha",
  login: "browserHelp.reason.login",
  "two-factor": "browserHelp.reason.two-factor",
  "qr-code": "browserHelp.reason.qr-code",
  passkey: "browserHelp.reason.passkey",
  other: "browserHelp.reason.other",
};

type Closed = Exclude<BrowserHelpEntry["status"], { readonly _tag: "pending" }>;

const closedText = (status: Closed): KeyWith => {
  switch (status._tag) {
    case "done":
      return "browserHelp.closed.done";
    case "declined":
      return "browserHelp.closed.declined";
    case "expired":
      return status.cause === "tab-closed"
        ? "browserHelp.closed.tab-closed"
        : "browserHelp.closed.timed-out";
  }
};

interface BrowserHelpCardProps {
  readonly entry: BrowserHelpEntry;
  /** Opens the bot's browser on the card's tab. */
  readonly onOpen: () => void;
  readonly onDone: () => void;
  readonly onDecline: () => void;
  /** An answer is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking the operator to do one step in its browser that only they can:
 * what the step is, on which site, and the bot's own words. The operator opens
 * the browser, does it there, and says here whether they did. Once answered,
 * here or elsewhere, or expired, the card only says how it ended.
 */
export function BrowserHelpCard({
  entry,
  onOpen,
  onDone,
  onDecline,
  submitting = false,
}: BrowserHelpCardProps) {
  const { t } = useI18n();
  const outcomeId = useId();
  const { status } = entry;
  const pending = status._tag === "pending";
  // Answered, the actions go; focus that was in them moves to the card.
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  const answer = (send: () => void) => () => {
    if (!submitting) send();
  };

  return (
    <CardFrame
      ref={target}
      icon={<AppWindowIcon />}
      title={t("browserHelp.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t(reasonText[entry.reason])}</p>
        {entry.site !== "" && (
          <p className="text-xs text-muted-foreground">
            {t("browserHelp.onSite", { site: entry.site })}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{entry.note}</p>
      </div>
      {status._tag === "pending" ? (
        <div className="flex flex-wrap items-center gap-2" {...actions}>
          <Button type="button" variant="primary" size="sm" onClick={onOpen}>
            {t("browser.open")}
          </Button>
          <span className="ms-auto flex gap-2">
            <Button type="button" size="sm" aria-disabled={submitting} onClick={answer(onDecline)}>
              {t("browserHelp.cantDoIt")}
            </Button>
            <Button type="button" size="sm" aria-disabled={submitting} onClick={answer(onDone)}>
              {t("browserHelp.done")}
            </Button>
          </span>
        </div>
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {t(closedText(status))}
        </p>
      )}
    </CardFrame>
  );
}
