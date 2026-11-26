// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A turn's plan as its conversation shows it (decision 0071): a short card
 * while the turn runs, one line once it ends. Everything here comes from the
 * plan the server sent; nothing is made up on the client.
 */
import type { Plan } from "@j3-bots/contracts";

/** Where a step stands, as a client draws it: a status it does not know is a step still to do. */
export type PlanStepState = "pending" | "running" | "done";

/** One line of a plan's card. */
export interface PlanLine {
  /** Its place in the plan, from 0: a plan is told whole each time, so a step is its place. */
  readonly index: number;
  readonly text: string;
  readonly state: PlanStepState;
}

/** The most lines a running turn's card takes, a line that counts hidden steps included. */
export const PLAN_LINES = 6;

/**
 * The plan a turn shows. A plan of one step is not shown as a plan: one line
 * that says what the bot is doing is what the turn's own line already is.
 */
export const shownPlan = (plan: Plan | null): Plan | null =>
  plan === null || plan.steps.length < 2 ? null : plan;

/** Every step of `plan` as a line. */
export const planLines = (plan: Plan): ReadonlyArray<PlanLine> =>
  plan.steps.map((step, index) => ({
    index,
    text: step.text,
    state: step.status === "running" || step.status === "done" ? step.status : "pending",
  }));

/** How far a plan is: how many of its steps are done, of how many. */
export interface PlanProgress {
  readonly done: number;
  readonly total: number;
}

export const planProgress = (plan: Plan): PlanProgress => ({
  done: plan.steps.filter((step) => step.status === "done").length,
  total: plan.steps.length,
});

/** What a running turn's card shows of a plan too long to show whole. */
export interface PlanWindow {
  /** How many steps come before the ones shown. */
  readonly before: number;
  readonly lines: ReadonlyArray<PlanLine>;
  /** How many steps come after them. */
  readonly after: number;
}

/**
 * The lines a running turn's card shows, `most` at most, a line that counts
 * the steps left out before and one that counts those after included. A plan
 * that fits is shown whole. A longer one is shown around where the bot is:
 * the step before the first one not yet done, that step, and what follows.
 */
export function planWindow(plan: Plan, most: number = PLAN_LINES): PlanWindow {
  const lines = planLines(plan);
  const total = lines.length;
  if (total <= most) return { before: 0, lines, after: 0 };
  const open = lines.findIndex((line) => line.state !== "done");
  const from = Math.max(0, (open === -1 ? total : open) - 1);
  // From the start, one line counts what follows; at the end, one counts what came before;
  // in between, both do.
  if (from === 0) return { before: 0, lines: lines.slice(0, most - 1), after: total - (most - 1) };
  if (from + (most - 1) >= total) {
    return { before: total - (most - 1), lines: lines.slice(total - (most - 1)), after: 0 };
  }
  return {
    before: from,
    lines: lines.slice(from, from + (most - 2)),
    after: total - from - (most - 2),
  };
}

/**
 * Which of `lines` carries the plan's one live mark: the first step being
 * done now, as its place among `lines`; null when none of them is.
 */
export const liveLine = (lines: ReadonlyArray<PlanLine>): number | null => {
  const at = lines.findIndex((line) => line.state === "running");
  return at === -1 ? null : at;
};
