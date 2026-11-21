// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Question } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { assembleAnswers, type QuestionDraft } from "./question.ts";

const question = (id: string, extra: Partial<Question> = {}): Question => ({
  id,
  prompt: "Which?",
  options: ["a", "b", "c"].map((o) => ({ id: o, label: o, description: null, style: "default" })),
  acceptsText: false,
  multiple: false,
  ...extra,
});

const drafts = (entries: Record<string, QuestionDraft>) => new Map(Object.entries(entries));

describe("assembleAnswers", () => {
  it("waits until every question has an option or text", () => {
    const questions = [question("pick"), question("note", { options: [], acceptsText: true })];
    expect(assembleAnswers(questions, drafts({ pick: { optionIds: ["a"], text: "" } }))).toBeNull();
    expect(
      assembleAnswers(
        questions,
        drafts({ pick: { optionIds: ["a"], text: "" }, note: { optionIds: [], text: "   " } }),
      ),
    ).toBeNull();
    expect(
      assembleAnswers(
        questions,
        drafts({ pick: { optionIds: ["a"], text: "" }, note: { optionIds: [], text: " soon " } }),
      ),
    ).toEqual({ pick: { optionIds: ["a"], text: null }, note: { optionIds: [], text: "soon" } });
  });

  it("keeps the question's own options, in its order, and one where only one is allowed", () => {
    const many = question("many", { multiple: true });
    expect(
      assembleAnswers([many], drafts({ many: { optionIds: ["c", "x", "a"], text: "" } })),
    ).toEqual({ many: { optionIds: ["a", "c"], text: null } });
    expect(
      assembleAnswers([question("one")], drafts({ one: { optionIds: ["c", "b"], text: "" } })),
    ).toEqual({ one: { optionIds: ["b"], text: null } });
  });

  it("drops typed text a question does not accept", () => {
    expect(
      assembleAnswers([question("one")], drafts({ one: { optionIds: [], text: "maybe" } })),
    ).toBeNull();
  });
});
