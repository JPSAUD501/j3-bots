// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A turn's plan and little ones as every client shows them (decision 0070):
 * which plan is worth a checklist, how far it got, and which of the bot's
 * little ones are drawn beside it. The server sends a turn's work only to its
 * audience: on the private work fold (`WorkFoldEntry.work`) or by the member
 * in a room (`Room.memberWork`).
 */
import type {
  BotId,
  BotState,
  LittleOne,
  LittleOnes,
  Plan,
  PlanStep,
  Room,
  TurnWork,
  WorkFoldEntry,
} from "@j3-bots/contracts";

/** The most little ones a client draws; the rest are told as "+N". */
export const MAX_SHOWN_LITTLE_ONES = 4;

/** Where a plan step stands as drawn: a status this build does not know is still to do. */
export type PlanStepState = "pending" | "running" | "done";

export const planStepState = (step: PlanStep): PlanStepState =>
  step.status === "unknown" ? "pending" : step.status;

/** The turn's plan, when it is worth drawing as one: a plan of a single step is not. */
export const shownPlan = (work: TurnWork | null): Plan | null =>
  work?.plan != null && work.plan.steps.length > 1 ? work.plan : null;

/** How far a plan got: its steps done, of all of them ("Plan done, 4 of 4"). */
export interface PlanProgress {
  readonly done: number;
  readonly total: number;
}

export const planProgress = (plan: Plan): PlanProgress => ({
  done: plan.steps.filter((step) => planStepState(step) === "done").length,
  total: plan.steps.length,
});

/** How a little one's work stands as drawn: one with a status this build does not know has ended. */
export type LittleOneState = "working" | "done" | "failed";

export const littleOneState = (one: LittleOne): LittleOneState =>
  one.status === "unknown" ? "done" : one.status;

/**
 * The little ones drawn beside the bot: those still working, in the order
 * they started, at most `MAX_SHOWN_LITTLE_ONES`, and how many more work
 * than that. One that ended leaves the list; a client keys each by its id to
 * draw it going back, as done or failed.
 */
export interface ShownLittleOnes {
  readonly shown: ReadonlyArray<LittleOne>;
  readonly more: number;
}

export const shownLittleOnes = (littleOnes: LittleOnes | null): ShownLittleOnes => {
  if (littleOnes === null) return { shown: [], more: 0 };
  const shown = littleOnes.ones
    .filter((one) => littleOneState(one) === "working")
    .slice(0, MAX_SHOWN_LITTLE_ONES);
  return { shown, more: Math.max(0, littleOnes.working - shown.length) };
};

/**
 * Whether a turn that has ended still has little ones at work: work it handed
 * off goes on after the bot's reply, and its row keeps them under the bot's
 * face until the last is home (decision 0095).
 */
export const littleOnesOut = (fold: WorkFoldEntry | null): boolean =>
  fold !== null && fold.status._tag === "finished" && (fold.work?.littleOnes.working ?? 0) > 0;

/**
 * How many of a bot's little ones are at work, in the turn under way and
 * those its ended turns handed off, whatever it does now.
 */
export const littleOnesAtWork = (state: BotState): number => state.littleOnes ?? 0;

/**
 * For a bot whose state counts its little ones at work (the roster's dots):
 * how many to draw, and how many more there are.
 */
export const littleOneDots = (
  working: number,
): { readonly dots: number; readonly more: number } => ({
  dots: Math.min(working, MAX_SHOWN_LITTLE_ONES),
  more: Math.max(0, working - MAX_SHOWN_LITTLE_ONES),
});

/** The work of the member's turn for the room, while it runs and has a plan or little ones. */
export const memberWorkOf = (room: Room, botId: BotId): TurnWork | null =>
  room.status === "active"
    ? (room.memberWork.find((member) => member.botId === botId)?.work ?? null)
    : null;
