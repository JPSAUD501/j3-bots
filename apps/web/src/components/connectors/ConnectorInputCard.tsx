// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type InputDraft,
  inputContent,
  inputDrafts,
  inputProblem,
} from "@j3-bots/client-runtime/presentation";
import type { ConnectorInputEntry, ElicitationAnswer, ElicitationField } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import { MessageSquareTextIcon } from "lucide-react";
import { useId, useState } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { useFocusAfterActions } from "../../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "../CardFrame";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { lineField } from "../ui/field";
import { type FieldControl, FieldFrame, ConnectorTile } from "./parts";

type Closed = Exclude<ConnectorInputEntry["status"], { readonly _tag: "pending" }>;

const closedText = (status: Closed): KeyWith => {
  if (status._tag === "expired") return "connectorInput.closed.expired";
  switch (status.action) {
    case "accept":
      return "connectorInput.closed.accept";
    case "decline":
      return "connectorInput.closed.decline";
    case "cancel":
      return "connectorInput.closed.cancel";
  }
};

/**
 * A connector's server asks the operator for something in the middle of a
 * bot's call, which waits on the answer: a few fields to fill in, or a page of
 * its own to open, named by its host. The answer goes to the server only.
 * Decline says no; Not now lets the server ask again later. Once answered,
 * here or elsewhere, or once the call ended, the card says how it closed.
 */
export function ConnectorInputCard({
  entry,
  onAnswer,
  onOpenPage,
  submitting = false,
}: {
  entry: ConnectorInputEntry;
  onAnswer: (answer: ElicitationAnswer) => void;
  /** Opens the server's page on this device. */
  onOpenPage: (url: string) => void;
  /** An answer is on its way: the card takes no second one. */
  submitting?: boolean;
}) {
  const { t } = useI18n();
  const outcomeId = useId();
  const pending = entry.status._tag === "pending";
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  const { request } = entry;
  const fields = request._tag === "form" ? request.fields : [];
  const [drafts, setDrafts] = useState(() => inputDrafts(fields));
  // Problems show once the operator tried to send, not while they type.
  const [tried, setTried] = useState(false);
  const answer = (given: ElicitationAnswer) => {
    if (!submitting) onAnswer(given);
  };
  const send = () => {
    const content = inputContent(fields, drafts);
    setTried(true);
    if (content !== null) answer({ _tag: "accept", content });
  };

  return (
    <CardFrame
      ref={target}
      icon={<MessageSquareTextIcon />}
      title={t("connectorInput.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {request.message !== "" && <span className="text-sm">{request.message}</span>}
        </div>
      </div>
      {request._tag === "url" && (
        <p className="text-sm text-muted-foreground">
          {t("connectorInput.page", { name: entry.name, host: request.host })}
        </p>
      )}
      {pending && request._tag === "form" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          {fields.map((field) => (
            <InputField
              key={field.key}
              field={field}
              draft={drafts[field.key]}
              problem={tried ? inputProblem(field, drafts[field.key]) : null}
              onChange={(draft) => setDrafts((all) => ({ ...all, [field.key]: draft }))}
            />
          ))}
          <p className="text-xs text-muted-foreground">
            {t("connectorInput.private", { name: entry.name })}
          </p>
        </form>
      )}
      {pending ? (
        <div className="flex flex-wrap justify-end gap-2" {...actions}>
          <Button size="sm" aria-disabled={submitting} onClick={() => answer({ _tag: "decline" })}>
            {t("connectorInput.decline")}
          </Button>
          <Button size="sm" aria-disabled={submitting} onClick={() => answer({ _tag: "cancel" })}>
            {t("connectorInput.notNow")}
          </Button>
          {request._tag === "form" ? (
            <Button size="sm" variant="primary" aria-disabled={submitting} onClick={send}>
              {t("connectorInput.send")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              aria-disabled={submitting}
              onClick={() => {
                if (submitting) return;
                // Opened while the click still counts, then answered: the server waits on the page.
                onOpenPage(request.url);
                answer({ _tag: "accept", content: {} });
              }}
            >
              {t("connectorInput.open", { host: request.host })}
            </Button>
          )}
        </div>
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {t(closedText(entry.status))}
        </p>
      )}
    </CardFrame>
  );
}

/** One field of a connector's form, as its kind takes it. */
function InputField({
  field,
  draft,
  problem,
  onChange,
}: {
  field: ElicitationField;
  draft: InputDraft | undefined;
  problem: "required" | "invalid" | null;
  onChange: (draft: InputDraft) => void;
}) {
  const { t } = useI18n();
  const label = field.required ? field.label : t("connectorInput.optional", { label: field.label });
  const problemText =
    problem === null
      ? null
      : problem === "required"
        ? t("connectorInput.required")
        : t("connectorInput.invalid");
  const text = typeof draft === "string" ? draft : "";
  const picked = typeof draft === "object" ? draft : [];

  if (field._tag === "boolean") {
    return (
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={draft === true} onCheckedChange={(checked) => onChange(checked)} />
        <span className="flex flex-col">
          <span>{field.label}</span>
          {field.description !== null && (
            <span className="text-xs text-muted-foreground">{field.description}</span>
          )}
        </span>
      </label>
    );
  }
  if (field._tag === "choice" && field.multiple) {
    return (
      <fieldset className="flex flex-col gap-1.5" aria-invalid={problem !== null || undefined}>
        <legend className="text-xs">{label}</legend>
        {field.options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={picked.includes(option.value)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...picked, option.value]
                    : picked.filter((value) => value !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
        {problemText !== null && <p className="text-xs text-blocked">{problemText}</p>}
      </fieldset>
    );
  }
  return (
    <FieldFrame label={label} hint={field.description} problem={problemText}>
      {(control: FieldControl) =>
        field._tag === "choice" ? (
          <select
            {...control}
            value={picked[0] ?? ""}
            onChange={(event) =>
              onChange(event.currentTarget.value === "" ? [] : [event.currentTarget.value])
            }
            className={lineField}
          >
            <option value="">
              {field.required ? t("connect.choose") : t("connect.choice.none")}
            </option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            {...control}
            type={field._tag === "text" ? inputType(field.format) : "text"}
            inputMode={
              field._tag === "number" ? (field.integer ? "numeric" : "decimal") : undefined
            }
            value={text}
            onChange={(event) => onChange(event.currentTarget.value)}
            autoComplete="off"
            className={lineField}
          />
        )
      }
    </FieldFrame>
  );
}

const inputType = (format: Extract<ElicitationField, { _tag: "text" }>["format"]) => {
  switch (format) {
    case "email":
      return "email";
    case "uri":
      return "url";
    case "date":
      return "date";
    // A date and time with its offset, typed: the browser's own field drops the offset.
    case "date-time":
    case null:
      return "text";
  }
};
