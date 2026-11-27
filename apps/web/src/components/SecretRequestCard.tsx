// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretRequestEntry } from "@j3-bots/contracts";
import { EyeIcon, EyeOffIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { type Ref, useId, useRef, useState } from "react";
import {
  type SecretRequestInput,
  secretRequestAnswer,
  secretRequestInputs,
  type SecretRequestValues,
  secretValueTooLong,
  webAddress,
} from "@j3-bots/client-runtime/presentation";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import { type FocusWatch, useFocusAfterActions } from "../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "./CardFrame";
import { Button } from "./ui/button";

interface SecretRequestCardProps {
  readonly entry: SecretRequestEntry;
  readonly onProvide: (answer: SecretRequestValues) => void;
  readonly onDecline: () => void;
  /** An answer is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking for credentials only the operator has: one value, or several
 * at once, such as an email and a password. Each value is typed into its own
 * input, masked unless the bot said it is not secret, and handed on as a
 * `Redacted`, so it never reaches a log. The inputs live only as long as the
 * request waits: once it is answered, here or elsewhere, or expires, the
 * values are gone and the card only says what happened.
 */
export function SecretRequestCard({
  entry,
  onProvide,
  onDecline,
  submitting = false,
}: SecretRequestCardProps) {
  const { t, plural } = useI18n();
  const fieldId = useId();
  const outcomeId = useId();
  const pending = entry.status === "pending";
  const inputs = secretRequestInputs(entry);
  // One value is labelled by the request's own label; several, each by its own.
  const single = entry.fields.length === 0;
  // Answered, the inputs and their actions go; focus that was in them moves to the card.
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);

  return (
    <CardFrame
      ref={target}
      icon={<KeyRoundIcon />}
      title={t("secret.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex flex-col gap-1">
        {pending && single ? (
          <label htmlFor={`${fieldId}-0`} className="text-sm font-medium">
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
          inputs={inputs}
          single={single}
          onProvide={onProvide}
          onDecline={onDecline}
          submitting={submitting}
          focusWatch={actions}
        />
      ) : entry.status === "expired" ? (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {t("secret.expired")}
        </p>
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {plural(
            entry.status === "provided" ? "secret.provided" : "secret.declined",
            inputs.length,
          )}
        </p>
      )}
    </CardFrame>
  );
}

/**
 * The inputs and their actions. Unmounted with the request, taking the typed
 * values with it. Enter moves to the first input still empty, or to one too
 * long to send, and sends once every one fits. While an answer is on its way they stay focusable but
 * take no second one.
 */
function SecretForm({
  fieldId,
  entry,
  inputs,
  single,
  onProvide,
  onDecline,
  submitting,
  focusWatch,
}: Required<SecretRequestCardProps> & {
  readonly fieldId: string;
  readonly inputs: ReadonlyArray<SecretRequestInput>;
  readonly single: boolean;
  readonly focusWatch: FocusWatch;
}) {
  const { plural, t } = useI18n();
  const [values, setValues] = useState<ReadonlyArray<string>>(() => inputs.map(() => ""));
  // Each input, by position, so Enter can move to the first one still empty.
  const fields = useRef<Array<HTMLInputElement | null>>([]);
  const link = webAddress(entry.url);
  const result = secretRequestAnswer(inputs, values);
  const note =
    entry.delivery === "reference"
      ? plural("secret.unseen", inputs.length)
      : entry.delivery === "file"
        ? plural("secret.inFile", inputs.length)
        : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        if (result._tag === "unfit") {
          fields.current[result.position]?.focus();
          return;
        }
        onProvide(result.answer);
        setValues(inputs.map(() => ""));
      }}
      {...focusWatch}
    >
      {inputs.map((input, position) => (
        <SecretInput
          key={input.id ?? "value"}
          ref={(element) => {
            fields.current[position] = element;
          }}
          id={`${fieldId}-${position}`}
          input={input}
          labelled={!single}
          value={values[position] ?? ""}
          onChange={(value) =>
            setValues((typed) => typed.map((old, at) => (at === position ? value : old)))
          }
          submitting={submitting}
        />
      ))}
      {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
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
            aria-disabled={result._tag === "unfit" || submitting}
          >
            {t("secret.provide")}
          </Button>
        </span>
      </div>
    </form>
  );
}

const autoComplete = { username: "username", password: "current-password" } as const;

/**
 * One value's input: shown as typed, or masked with a button that shows it.
 * Only a login's user name and password are offered to a password manager.
 */
function SecretInput({
  ref,
  id,
  input,
  labelled,
  value,
  onChange,
  submitting,
}: {
  readonly ref: Ref<HTMLInputElement>;
  readonly id: string;
  readonly input: SecretRequestInput;
  /** Whether it takes its own label; the one input of a request for one value has the card's. */
  readonly labelled: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly submitting: boolean;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const hidden = input.masked && !shown;
  const tooLong = secretValueTooLong(value);
  const problemId = `${id}-problem`;
  return (
    <div className="flex flex-col gap-1">
      {labelled && (
        <label htmlFor={id} className="text-xs font-medium">
          {input.label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={hidden ? "password" : "text"}
          value={value}
          readOnly={submitting}
          aria-disabled={submitting}
          aria-required
          aria-invalid={tooLong}
          aria-describedby={tooLong ? problemId : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={input.placeholder ?? undefined}
          autoComplete={input.autofill === null ? "off" : autoComplete[input.autofill]}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            "h-9 w-full rounded-md border bg-surface px-3 text-sm placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11",
            tooLong ? "border-blocked" : "border-input",
            input.masked && "pe-11 font-mono",
          )}
        />
        {input.masked && (
          <button
            type="button"
            aria-label={t("secret.show", { label: input.label })}
            aria-pressed={shown}
            aria-controls={id}
            onClick={() => setShown((was) => !was)}
            className={cn(
              "absolute inset-y-0 end-0 flex w-10 cursor-pointer items-center justify-center rounded-e-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent",
              touchTarget,
            )}
          >
            {shown ? (
              <EyeOffIcon aria-hidden className="size-4" />
            ) : (
              <EyeIcon aria-hidden className="size-4" />
            )}
          </button>
        )}
      </div>
      {tooLong && (
        <p id={problemId} className="text-xs text-blocked">
          {t("secret.tooLong")}
        </p>
      )}
    </div>
  );
}
