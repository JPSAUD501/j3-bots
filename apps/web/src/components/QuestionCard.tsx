// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Question, QuestionAnswers, QuestionEntry } from "@j3-bots/contracts";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { CardFrame } from "./CardFrame";
import { Button } from "./ui/button";

interface QuestionCardProps {
  readonly entry: QuestionEntry;
  readonly onAnswer: (answers: QuestionAnswers) => void;
  readonly onDismiss: () => void;
}

/**
 * A bot asking the operator to choose. A single question with single choice
 * and no typed answer is answered by tapping an option; anything else is
 * answered with "Send answer". Dismissing reads as "no". An option the bot
 * recommends says so in words; one that loses something is drawn in the
 * blocked color.
 */
export function QuestionCard({ entry, onAnswer, onDismiss }: QuestionCardProps) {
  const { t } = useI18n();
  const pending = entry.status._tag === "pending";
  const [chosen, setChosen] = useState<Readonly<Record<string, ReadonlyArray<string>>>>({});
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({});
  const [first] = entry.questions;
  const answersOnTap =
    entry.questions.length === 1 && !first.multiple && !first.acceptsText && pending;

  const answers = (): QuestionAnswers =>
    Object.fromEntries(
      entry.questions.map((q) => {
        const text = typed[q.id]?.trim() ?? "";
        return [q.id, { optionIds: chosen[q.id] ?? [], text: text === "" ? null : text }];
      }),
    );
  const complete = entry.questions.every(
    (q) => (chosen[q.id]?.length ?? 0) > 0 || (typed[q.id]?.trim() ?? "") !== "",
  );

  const choose = (q: Question, optionId: string) => {
    if (answersOnTap) {
      onAnswer({ [q.id]: { optionIds: [optionId], text: null } });
      return;
    }
    setChosen((current) => {
      const now = current[q.id] ?? [];
      const next = q.multiple
        ? now.includes(optionId)
          ? now.filter((id) => id !== optionId)
          : [...now, optionId]
        : [optionId];
      return { ...current, [q.id]: next };
    });
  };

  const answered = entry.status._tag === "answered" ? entry.status.answers : null;

  return (
    <CardFrame
      icon={<MessageCircleQuestionIcon />}
      title={pending ? t("question.pending") : t("question.title")}
      attention={pending}
    >
      {entry.questions.map((q) => {
        const picked = answered?.[q.id]?.optionIds ?? chosen[q.id] ?? [];
        const answerText = answered?.[q.id]?.text ?? null;
        return (
          <fieldset key={q.id} className="flex flex-col gap-2" disabled={!pending}>
            <legend className="mb-2 text-sm font-medium">{q.prompt}</legend>
            {(pending || answered) && q.options.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {q.options
                  .filter((o) => pending || picked.includes(o.id))
                  .map((option) => {
                    const on = picked.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={answersOnTap ? undefined : on}
                        onClick={() => choose(q, option.id)}
                        className={cn(
                          "flex min-h-9 w-full items-start gap-2.5 rounded-md border px-3 py-2 text-start text-sm transition-colors duration-(--duration-fast) disabled:cursor-default pointer-coarse:min-h-11",
                          on
                            ? "border-foreground/60 bg-muted"
                            : "border-input hover:bg-muted disabled:hover:bg-transparent",
                        )}
                      >
                        {!answersOnTap && (
                          <span
                            aria-hidden
                            className={cn(
                              "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                              q.multiple ? "rounded-sm" : "rounded-pill",
                              on
                                ? "border-foreground bg-foreground text-background"
                                : "border-input",
                            )}
                          >
                            {on && <CheckIcon className="size-3" strokeWidth={3} />}
                          </span>
                        )}
                        <span className="flex flex-col">
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className={cn(option.style === "destructive" && "text-blocked")}>
                              {option.label}
                            </span>
                            {option.style === "recommended" && (
                              <span className="text-2xs font-medium text-accent">
                                {t("question.recommended")}
                              </span>
                            )}
                          </span>
                          {option.description && (
                            <span className="text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
              </div>
            )}
            {pending && q.acceptsText && (
              <textarea
                rows={1}
                value={typed[q.id] ?? ""}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setTyped((current) => ({ ...current, [q.id]: value }));
                }}
                placeholder={
                  q.options.length > 0 ? t("question.typeInstead") : t("question.typeAnswer")
                }
                aria-label={t("question.typeAnswer")}
                className="field-sizing-content min-h-9 resize-none rounded-md border border-input bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent"
              />
            )}
            {answerText && <p className="text-sm whitespace-pre-wrap">{answerText}</p>}
          </fieldset>
        );
      })}
      {pending ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost-muted" size="sm" onClick={onDismiss}>
            {t("question.dismiss")}
          </Button>
          {!answersOnTap && (
            <Button
              variant="primary"
              size="sm"
              disabled={!complete}
              onClick={() => onAnswer(answers())}
            >
              {t("question.send")}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {entry.status._tag === "answered"
            ? t("question.answered")
            : entry.status._tag === "dismissed"
              ? t("question.dismissed")
              : t("question.expired")}
        </p>
      )}
    </CardFrame>
  );
}
