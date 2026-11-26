// SPDX-License-Identifier: AGPL-3.0-or-later
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  cardQuestions,
  type QuestionAnswers,
  type QuestionEntry,
  type QuestionOption,
  type WholeQuestion,
} from "@j3-bots/contracts";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  assembleAnswers,
  optionDescription,
  type QuestionDraft,
} from "@j3-bots/client-runtime/presentation";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { type FocusWatch, useFocusAfterActions } from "../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "./CardFrame";
import { Button } from "./ui/button";
import { ChoiceIndicator, choiceRow } from "./ui/choice";

interface QuestionCardProps {
  readonly entry: QuestionEntry;
  readonly onAnswer: (answers: QuestionAnswers) => void;
  /** Offered only for a bot's own `ask` question. */
  readonly onDismiss: () => void;
  /** An answer or a dismissal is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking the operator to choose. A single question with single choice
 * and no typed answer is answered by tapping an option; anything else is a
 * form of radio buttons, checkboxes and text, sent with "Send answer". An
 * `ask` question takes a note beside a choice; the harness's own question
 * takes one or the other, so typing clears the choice and choosing clears the
 * text.
 * Only an `ask` question can be dismissed, which reads as "no", and its button
 * says so: the harness's own question holds its turn until it is answered or
 * the turn is stopped. An option the bot
 * recommends says so in words; one that loses something says that too, and
 * is drawn in the blocked color. A harness's question can come with a header
 * over it and a preview under an option, shown as the harness gives them.
 * Several questions stack, each under the one before, however many there are.
 */
export function QuestionCard({
  entry,
  onAnswer,
  onDismiss,
  submitting = false,
}: QuestionCardProps) {
  const { t } = useI18n();
  const { status } = entry;
  const pending = status._tag === "pending";
  const questions = cardQuestions(entry);
  const [first] = questions;
  const outcomeId = useId();
  // Answered, the controls go; focus that was in them moves to the card.
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  // While an answer is on its way the controls stay focusable but take no second one.
  const answer = (answers: QuestionAnswers) => {
    if (!submitting) onAnswer(answers);
  };
  const dismiss =
    entry.origin === "ask"
      ? () => {
          if (!submitting) onDismiss();
        }
      : null;
  const answersOnTap = pending && questions.length === 1 && !first.multiple && !first.acceptsText;
  // The option tapped confirms while its answer is on its way: it takes a check, and the others
  // step back. Refused, the card waits again with every option as it was.
  const [tapped, setTapped] = useState<string | null>(null);
  const chosen = submitting ? tapped : null;
  const { closedHere } = useClosedHere(pending);

  return (
    <CardFrame
      ref={target}
      icon={<MessageCircleQuestionIcon />}
      title={t("question.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      {!pending ? (
        <div className={cn("flex flex-col gap-3", closedHere && "arrive")}>
          {questions.map((q) => (
            <Resolved
              key={q.id}
              question={q}
              answer={status._tag === "answered" ? (status.answers[q.id] ?? null) : null}
              drawn={closedHere}
            />
          ))}
          <p id={outcomeId} className="text-xs text-muted-foreground">
            {status._tag === "answered"
              ? t("question.answered")
              : status._tag === "dismissed"
                ? t("question.dismissed")
                : status._tag === "refused"
                  ? t("question.refused")
                  : t("question.expired")}
          </p>
        </div>
      ) : answersOnTap ? (
        <div className="flex flex-col gap-3" {...actions}>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 flex flex-col items-start gap-1.5 text-sm font-medium">
              <QuestionHeader question={first} />
              {first.prompt}
            </legend>
            <div className="flex flex-col gap-1.5">
              {first.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-disabled={submitting}
                  onClick={() => {
                    if (submitting) return;
                    setTapped(option.id);
                    answer({ [first.id]: { optionIds: [option.id], text: null } });
                  }}
                  className={cn(
                    choiceRow,
                    "hover:bg-muted aria-disabled:hover:bg-transparent",
                    chosen === option.id && "border-foreground/60 bg-muted",
                    chosen !== null && chosen !== option.id && "opacity-50",
                  )}
                >
                  <OptionText option={option} />
                  {chosen === option.id && (
                    <CheckIcon aria-hidden className="pop-in ms-auto mt-0.5 size-4 shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </fieldset>
          {dismiss !== null && <Actions onDismiss={dismiss} submitting={submitting} />}
        </div>
      ) : (
        // Keyed by the entry, so a draft never outlives the card it was typed into.
        <QuestionForm
          key={entry.id}
          questions={questions}
          textReplacesChoice={entry.origin === "engine"}
          onAnswer={answer}
          onDismiss={dismiss}
          submitting={submitting}
          focusWatch={actions}
        />
      )}
    </CardFrame>
  );
}

function QuestionForm({
  questions,
  textReplacesChoice,
  onAnswer,
  onDismiss,
  submitting,
  focusWatch,
}: {
  questions: ReadonlyArray<WholeQuestion>;
  textReplacesChoice: boolean;
  onAnswer: (answers: QuestionAnswers) => void;
  onDismiss: (() => void) | null;
  submitting: boolean;
  focusWatch: FocusWatch;
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
      className="flex flex-col gap-3 [&>[data-question]+[data-question]]:border-t [&>[data-question]+[data-question]]:border-border [&>[data-question]+[data-question]]:pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (answers !== null) onAnswer(answers);
      }}
      {...focusWatch}
    >
      {questions.map((q) => (
        <QuestionFields
          key={q.id}
          question={q}
          draft={drafts.get(q.id) ?? null}
          textReplacesChoice={textReplacesChoice}
          readOnly={submitting}
          onChange={(change) => update(q.id, change)}
        />
      ))}
      <Actions onDismiss={onDismiss} submitting={submitting} canSend={answers !== null} />
    </form>
  );
}

/** One question's fields. While the answer is on its way they are read-only, so focus stays. */
function QuestionFields({
  question,
  draft,
  textReplacesChoice,
  readOnly,
  onChange,
}: {
  question: WholeQuestion;
  draft: QuestionDraft | null;
  /** A typed answer goes instead of a choice, never beside it. */
  textReplacesChoice: boolean;
  readOnly: boolean;
  onChange: (change: Partial<QuestionDraft>) => void;
}) {
  const { t } = useI18n();
  const promptId = useId();
  const picked = draft?.optionIds ?? [];
  // Where typed text goes with a chosen option, the field says so.
  const textLabel =
    question.options.length === 0
      ? t("question.typeAnswer")
      : picked.length > 0 && !textReplacesChoice
        ? t("question.addNote")
        : t("question.typeInstead");
  const choose = (optionIds: ReadonlyArray<string>) =>
    onChange(textReplacesChoice ? { optionIds, text: "" } : { optionIds });
  const optionClass = cn(
    choiceRow,
    "group/option hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted data-readonly:hover:bg-transparent",
  );
  return (
    <div data-question className="flex flex-col gap-2">
      <QuestionHeader question={question} />
      <p id={promptId} className="text-sm font-medium">
        {question.prompt}
      </p>
      {question.options.length > 0 &&
        (question.multiple ? (
          <CheckboxGroup
            aria-labelledby={promptId}
            value={[...picked]}
            onValueChange={(optionIds) => choose(optionIds)}
            className="flex flex-col gap-1.5"
          >
            {question.options.map((option) => (
              <Checkbox.Root
                key={option.id}
                value={option.id}
                readOnly={readOnly}
                className={optionClass}
              >
                <ChoiceIndicator shape="square">
                  <Checkbox.Indicator>
                    <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
                  </Checkbox.Indicator>
                </ChoiceIndicator>
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
              if (option) choose([option.id]);
            }}
            readOnly={readOnly}
            className="flex flex-col gap-1.5"
          >
            {question.options.map((option) => (
              <Radio.Root key={option.id} value={option.id} className={optionClass}>
                <ChoiceIndicator shape="round">
                  <Radio.Indicator className="size-2 rounded-pill bg-background" />
                </ChoiceIndicator>
                <OptionText option={option} />
              </Radio.Root>
            ))}
          </RadioGroup>
        ))}
      {question.acceptsText && (
        <textarea
          rows={1}
          value={draft?.text ?? ""}
          readOnly={readOnly}
          aria-disabled={readOnly}
          onChange={(event) => {
            const text = event.currentTarget.value;
            onChange(textReplacesChoice && text.trim() !== "" ? { text, optionIds: [] } : { text });
          }}
          placeholder={textLabel}
          aria-label={question.options.length > 0 ? textLabel : question.prompt}
          className="field-sizing-content min-h-9 resize-none rounded-md border border-input bg-surface px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11"
        />
      )}
    </div>
  );
}

function OptionText({ option }: { option: QuestionOption }) {
  const { t } = useI18n();
  const description = optionDescription(option);
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
      {description !== null && <span className="text-xs text-muted-foreground">{description}</span>}
      {option.preview !== undefined && (
        // A span, not a pre: the option is a button, which holds phrasing content only.
        <span className="mt-1.5 block max-h-48 overflow-auto rounded-sm bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre text-muted-foreground">
          {option.preview}
        </span>
      )}
    </span>
  );
}

/** What a harness's question is about, in a few words over it, when it says. */
function QuestionHeader({ question }: { question: WholeQuestion }) {
  if (question.header === undefined) return null;
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
      {question.header}
    </span>
  );
}

function Actions({
  onDismiss,
  submitting,
  canSend,
}: {
  onDismiss: (() => void) | null;
  submitting: boolean;
  /** Set when the card is a form; tap-to-answer cards have no send button. */
  canSend?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {onDismiss !== null && (
        <Button size="sm" onClick={onDismiss} aria-disabled={submitting}>
          {t("question.dismiss")}
        </Button>
      )}
      {canSend !== undefined && (
        <Button type="submit" variant="primary" size="sm" aria-disabled={!canSend || submitting}>
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
  drawn,
}: {
  question: WholeQuestion;
  answer: QuestionAnswers[string] | null;
  /** Answered while on screen: each chosen option's check draws itself. */
  drawn: boolean;
}) {
  const chosen = question.options.filter((o) => answer?.optionIds.includes(o.id));
  return (
    <div className="flex flex-col gap-2">
      <QuestionHeader question={question} />
      <p className="text-sm font-medium">{question.prompt}</p>
      {chosen.map((option) => (
        <div key={option.id} className={cn(choiceRow, "border-foreground/60 bg-muted")}>
          <OptionText option={option} />
          <CheckIcon
            aria-hidden
            className={cn("ms-auto mt-0.5 size-4 shrink-0", drawn && "draw-check")}
          />
        </div>
      ))}
      {answer?.text && <p className="text-sm whitespace-pre-wrap">{answer.text}</p>}
    </div>
  );
}
