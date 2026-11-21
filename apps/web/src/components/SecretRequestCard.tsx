// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretRequestEntry } from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useId, useState } from "react";
import { webAddress } from "@j3-bots/client-runtime/presentation";
import { useI18n } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { type FocusWatch, useFocusAfterActions } from "../lib/useFocusAfterActions";
import { CardFrame } from "./CardFrame";
import { Button } from "./ui/button";

const closedText: Record<Exclude<SecretRequestEntry["status"], "pending">, KeyWith> = {
  provided: "secret.provided",
  declined: "secret.declined",
  expired: "secret.expired",
};

interface SecretRequestCardProps {
  readonly entry: SecretRequestEntry;
  readonly onProvide: (value: Redacted.Redacted<string>) => void;
  readonly onDecline: () => void;
  /** An answer is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking for a credential only the operator has. The value is typed
 * into a masked field and handed on as a `Redacted`, so it never reaches a
 * log. The field lives only as long as the request waits: once it is
 * answered, here or elsewhere, or expires, the value is gone and the card
 * only says what happened.
 */
export function SecretRequestCard({
  entry,
  onProvide,
  onDecline,
  submitting = false,
}: SecretRequestCardProps) {
  const { t } = useI18n();
  const fieldId = useId();
  const outcomeId = useId();
  const pending = entry.status === "pending";
  // Answered, the field and its actions go; focus that was in them moves to the card.
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);

  return (
    <CardFrame
      ref={target}
      icon={<KeyRoundIcon />}
      title={pending ? t("secret.pending") : t("secret.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex flex-col gap-1">
        {pending ? (
          <label htmlFor={fieldId} className="text-sm font-medium">
            {entry.label}
          </label>
        ) : (
          <p className="text-sm font-medium">{entry.label}</p>
        )}
        {entry.reason !== "" && <p className="text-sm text-muted-foreground">{entry.reason}</p>}
      </div>
      {entry.status === "pending" ? (
        <SecretForm
          fieldId={fieldId}
          entry={entry}
          onProvide={onProvide}
          onDecline={onDecline}
          submitting={submitting}
          focusWatch={actions}
        />
      ) : (
        <p id={outcomeId} className="text-xs text-muted-foreground">
          {t(closedText[entry.status])}
        </p>
      )}
    </CardFrame>
  );
}

/**
 * The masked field and its actions. Unmounted with the request, taking the typed value with it.
 * While an answer is on its way they stay focusable but take no second one.
 */
function SecretForm({
  fieldId,
  entry,
  onProvide,
  onDecline,
  submitting,
  focusWatch,
}: Required<SecretRequestCardProps> & {
  readonly fieldId: string;
  readonly focusWatch: FocusWatch;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const link = webAddress(entry.url);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value === "" || submitting) return;
        onProvide(Redacted.make(value));
        setValue("");
      }}
      {...focusWatch}
    >
      <input
        id={fieldId}
        type="password"
        value={value}
        readOnly={submitting}
        aria-disabled={submitting}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder={entry.placeholder ?? undefined}
        autoComplete="off"
        spellCheck={false}
        className="h-9 rounded-md border border-input bg-surface px-3 font-mono text-sm placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11"
      />
      <p className="text-xs text-muted-foreground">{t("secret.notKept")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {link !== null && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
              touchTarget,
            )}
          >
            {t("secret.getOne")}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
        <span className="ms-auto flex gap-2">
          <Button
            type="button"
            variant="ghost-muted"
            size="sm"
            aria-disabled={submitting}
            onClick={() => {
              if (!submitting) onDecline();
            }}
          >
            {t("secret.decline")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            aria-disabled={value === "" || submitting}
          >
            {t("secret.provide")}
          </Button>
        </span>
      </div>
    </form>
  );
}
