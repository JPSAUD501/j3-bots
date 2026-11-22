// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Question, QuestionAnswer, QuestionAnswers, QuestionOption } from "@j3-bots/contracts";

/** What the operator has picked and typed for one question so far. */
export interface QuestionDraft {
  readonly optionIds: ReadonlyArray<string>;
  readonly text: string;
}

const blank: QuestionDraft = { optionIds: [], text: "" };

/**
 * The answers a card sends, from what the operator picked and typed, or null
 * while some question has neither. Options keep the question's order and only
 * its own ids; a single-choice question keeps one; typed text is trimmed and
 * kept only where the question accepts it.
 */
export function assembleAnswers(
  questions: ReadonlyArray<Question>,
  drafts: ReadonlyMap<string, QuestionDraft>,
): QuestionAnswers | null {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    const draft = drafts.get(question.id) ?? blank;
    const picked = question.options
      .filter((option) => draft.optionIds.includes(option.id))
      .map((option) => option.id);
    const optionIds = question.multiple ? picked : picked.slice(0, 1);
    const text = question.acceptsText ? draft.text.trim() : "";
    if (optionIds.length === 0 && text === "") return null;
    answers[question.id] = { optionIds, text: text === "" ? null : text };
  }
  return answers;
}

/** Text as a reader compares it: case, spacing and closing punctuation set aside. */
const compared = (text: string): string =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?…:;,]+$/u, "")
    .trim();

/**
 * What an option's description adds to its label, or null when it adds
 * nothing: absent, blank, or the label said again.
 */
export function optionDescription(option: QuestionOption): string | null {
  const description = option.description?.trim() ?? "";
  if (description === "") return null;
  return compared(description) === compared(option.label) ? null : description;
}
