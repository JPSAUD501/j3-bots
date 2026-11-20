// SPDX-License-Identifier: AGPL-3.0-or-later
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { Question, QuestionAnswers, QuestionEntry, QuestionOption } from "@j3-bots/contracts";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { assembleAnswers, type QuestionDraft } from "../presentation/question";
import { CardFrame } from "./CardFrame";
import { Button } from "./ui/button";

interface QuestionCardProps {
  readonly entry: QuestionEntry;
  readonly onAnswer: (answers: QuestionAnswers) => void;
  readonly onDismiss: () => void;
  /** An answer or a dismissal is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking the operator to choose. A single question with single choice
 * and no typed answer is answered by tapping an option; anything else is a
 * form of radio buttons, checkboxes and text, sent with "Send answer".
 * Dismissing reads as "no", and its button says so. An option the bot
 * recommends says so in words; one that loses something says that too, and
 * is drawn in the blocked color.
 */
export function QuestionCard({
  entry,
  onAnswer,
  onDismiss,
  submitting = false,
}: QuestionCardProps) {
  const { t } = useI18n();
  const { status } = entry;
  const [first] = entry.questions;
  const answersOnTap =
    status._tag === "pending" &&
    entry.questions.length === 1 &&
    !first.multiple &&
    !first.acceptsText;

  return (
    <CardFrame
      icon={<MessageCircleQuestionIcon />}
      title={status._tag === "pending" ? t("question.pending") : t("question.title")}
      attention={status._tag === "pending"}
      entryId={entry.id}
      className="@max-tablet:max-w-full"
    >
      {status._tag !== "pending" ? (
        <>
          {entry.questions.map((q) => (
            <Resolved
              key={q.id}
              question={q}
              answer={status._tag === "answered" ? (status.answers[q.id] ?? null) : null}
            />
          ))}
          <p className="text-xs text-muted-foreground">
            {status._tag === "answered"
              ? t("question.answered")
              : status._tag === "dismissed"
                ? t("question.dismissed")
                : t("question.expired")}
          </p>
        </>
      ) : answersOnTap ? (
        <>
          <fieldset className="flex flex-col gap-2" disabled={submitting}>
            <legend className="mb-2 text-sm font-medium">{first.prompt}</legend>
            <div className="flex flex-col gap-1.5">
              {first.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onAnswer({ [first.id]: { optionIds: [option.id], text: null } })}
                  className={cn(optionRow, "hover:bg-muted disabled:hover:bg-transparent")}
                >
                  <OptionText option={option} />
                </button>
              ))}
            </div>
          </fieldset>
          <Actions onDismiss={onDismiss} submitting={submitting} />
        </>
      ) : (
        // Keyed by the entry, so a draft never outlives the card it was typed into.
        <QuestionForm
          key={entry.id}
          questions={entry.questions}
          onAnswer={onAnswer}
          onDismiss={onDismiss}
          submitting={submitting}
        />
      )}
    </CardFrame>
  );
}

const optionRow =
  "flex min-h-9 w-full items-start gap-2.5 rounded-md border border-input px-3 py-2 text-start text-sm outline-none transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default pointer-coarse:min-h-11";

function QuestionForm({
  questions,
  onAnswer,
  onDismiss,
  submitting,
}: {
  questions: ReadonlyArray<Question>;
  onAnswer: (answers: QuestionAnswers) => void;
  onDismiss: () => void;
  submitting: boolean;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, QuestionDraft>>(() => new Map());
  const answers = assembleAnswers(questions, drafts);
  const update = (id: string, change: Partial<QuestionDraft>) =>
    setDrafts((current) => {
      const next = new Map(current);
      next.set(id, { optionIds: [], text: "", ...current.get(id), ...change });
      return next;
    });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (answers !== null && !submitting) onAnswer(answers);
      }}
    >
      {questions.map((q) => (
        <QuestionFields
          key={q.id}
          question={q}
          draft={drafts.get(q.id) ?? null}
          disabled={submitting}
          onChange={(change) => update(q.id, change)}
        />
      ))}
      <Actions onDismiss={onDismiss} submitting={submitting} canSend={answers !== null} />
    </form>
  );
}

function QuestionFields({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: Question;
  draft: QuestionDraft | null;
  disabled: boolean;
  onChange: (change: Partial<QuestionDraft>) => void;
}) {
  const { t } = useI18n();
  const promptId = useId();
  const picked = draft?.optionIds ?? [];
  // Typed text goes with a chosen option, not instead of it, and the field says so.
  const textLabel =
    question.options.length === 0
      ? t("question.typeAnswer")
      : picked.length > 0
        ? t("question.addNote")
        : t("question.typeInstead");
  const optionClass = cn(
    optionRow,
    "group/option hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted data-disabled:hover:bg-transparent",
  );
  return (
    <div className="flex flex-col gap-2">
      <p id={promptId} className="text-sm font-medium">
        {question.prompt}
      </p>
      {question.options.length > 0 &&
        (question.multiple ? (
          <CheckboxGroup
            aria-labelledby={promptId}
            value={[...picked]}
            onValueChange={(optionIds) => onChange({ optionIds })}
            disabled={disabled}
            className="flex flex-col gap-1.5"
          >
            {question.options.map((option) => (
              <Checkbox.Root key={option.id} value={option.id} className={optionClass}>
                <Indicator shape="square">
                  <Checkbox.Indicator>
                    <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
                  </Checkbox.Indicator>
                </Indicator>
                <OptionText option={option} />
              </Checkbox.Root>
            ))}
          </CheckboxGroup>
        ) : (
          <RadioGroup
            aria-labelledby={promptId}
            value={picked[0] ?? null}
            onValueChange={(value: unknown) => {
              const option = question.options.find((o) => o.id === value);
              if (option) onChange({ optionIds: [option.id] });
            }}
            disabled={disabled}
            className="flex flex-col gap-1.5"
          >
            {question.options.map((option) => (
              <Radio.Root key={option.id} value={option.id} className={optionClass}>
                <Indicator shape="round">
                  <Radio.Indicator className="size-2 rounded-pill bg-background" />
                </Indicator>
                <OptionText option={option} />
              </Radio.Root>
            ))}
          </RadioGroup>
        ))}
      {question.acceptsText && (
        <textarea
          rows={1}
          value={draft?.text ?? ""}
          disabled={disabled}
          onChange={(event) => onChange({ text: event.currentTarget.value })}
          placeholder={textLabel}
          aria-label={question.options.length > 0 ? textLabel : question.prompt}
          className="field-sizing-content min-h-9 resize-none rounded-md border border-input bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11"
        />
      )}
    </div>
  );
}

/** The drawn box or circle of a choice; the option's own element carries the checked state. */
function Indicator({ shape, children }: { shape: "square" | "round"; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border border-control-off text-background",
        "group-data-checked/option:border-foreground group-data-checked/option:bg-foreground",
        shape === "square" ? "rounded-sm" : "rounded-pill",
      )}
    >
      {children}
    </span>
  );
}

function OptionText({ option }: { option: QuestionOption }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-col">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn(option.style === "destructive" && "text-blocked")}>{option.label}</span>
        {option.style === "recommended" && (
          <span className="text-2xs font-medium text-accent">{t("question.recommended")}</span>
        )}
        {option.style === "destructive" && (
          <span className="text-2xs font-medium text-blocked">{t("question.destructive")}</span>
        )}
      </span>
      {option.description && (
        <span className="text-xs text-muted-foreground">{option.description}</span>
      )}
    </span>
  );
}

function Actions({
  onDismiss,
  submitting,
  canSend,
}: {
  onDismiss: () => void;
  submitting: boolean;
  /** Set when the card is a form; tap-to-answer cards have no send button. */
  canSend?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="ghost-muted" size="sm" onClick={onDismiss} disabled={submitting}>
        {t("question.dismiss")}
      </Button>
      {canSend !== undefined && (
        <Button type="submit" variant="primary" size="sm" disabled={!canSend || submitting}>
          {t("question.send")}
        </Button>
      )}
    </div>
  );
}

/** A question once it no longer waits: what was chosen and typed, if anything. */
function Resolved({
  question,
  answer,
}: {
  question: Question;
  answer: QuestionAnswers[string] | null;
}) {
  const chosen = question.options.filter((o) => answer?.optionIds.includes(o.id));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{question.prompt}</p>
      {chosen.map((option) => (
        <div key={option.id} className={cn(optionRow, "border-foreground/60 bg-muted")}>
          <OptionText option={option} />
        </div>
      ))}
      {answer?.text && <p className="text-sm whitespace-pre-wrap">{answer.text}</p>}
    </div>
  );
}
