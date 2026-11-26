// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LittleOne } from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { PlanProgress, PlanStepState } from "../presentation/turnWork.ts";

/** A plan in one line: "Plan done, 4 of 4", or "Plan, 2 of 4 done" for one a turn left unfinished. */
export const planTitle = ({ done, total }: PlanProgress, i18n: I18n): string =>
  i18n.t(done === total ? "plan.done" : "plan.partial", { done, total });

const stepWords: Record<PlanStepState, KeyWith<never>> = {
  pending: "plan.step.pending",
  running: "plan.step.running",
  done: "plan.step.done",
};

/** Where a step stands, in words, for whoever cannot see its mark. */
export const planStepText = (state: PlanStepState, i18n: I18n): string => i18n.t(stepWords[state]);

/**
 * What a little one does, as its line says it: its own few words, or, when
 * the engine gave it none, that it works on a part of what the bot is doing.
 */
export const littleOneText = (one: Pick<LittleOne, "label">, i18n: I18n): string =>
  one.label ?? i18n.t("littleOnes.unnamed");
