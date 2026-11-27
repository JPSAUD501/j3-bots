// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A turn's plan and its little ones for the gallery: each state they can be
 * in, and one turn played from its first step to its end. Development only.
 */
import {
  LittleOneId,
  type LittleOne,
  type LittleOnes,
  type Plan,
  type PlanStep,
  type TurnWork,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { SAMPLE_NOW } from "./sample";

const ago = (seconds: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) - seconds * 1000);

const STEPS = ["Read the brief", "Compare the three vendors", "Write the comparison", "Send it"];

/** A plan of `texts`, the first `done` steps done and the next one being done. */
export function samplePlan(done: number, texts: ReadonlyArray<string> = STEPS): Plan {
  const steps = texts.map((text, index): PlanStep => ({
    text,
    status: index < done ? "done" : index === done ? "running" : "pending",
  }));
  const [first, ...rest] = steps;
  return { steps: [first ?? { text: "Reply", status: "pending" }, ...rest] };
}

/** A plan too long to show whole: twenty steps, eleven done. */
export const longPlan = samplePlan(
  11,
  Array.from({ length: 20 }, (_, index) => `Check the invoice of month ${index + 1}`),
);

const LABELS = [
  "Checking Acme's prices",
  "Reading what customers say about Globex in forums and reviews",
  "Looking into Initech's support",
  "Comparing contract terms",
  "Checking who else uses them",
  "Adding up the yearly cost",
];

const little = (index: number, status: LittleOne["status"] = "working"): LittleOne => ({
  id: LittleOneId.make(`little-${index}`),
  label: LABELS[index % LABELS.length] ?? null,
  status,
  startedAt: ago(95 - index * 4),
  finishedAt: status === "working" ? null : ago(3),
});

/** A family: the status of each little one in turn, and how many work beyond those listed. */
export const sampleLittleOnes = (
  statuses: ReadonlyArray<LittleOne["status"]>,
  unlisted = 0,
): LittleOnes => {
  const ones = statuses.map((status, index) => little(index, status));
  return {
    ones,
    working: ones.filter((one) => one.status === "working").length + unlisted,
    total: ones.length + unlisted,
  };
};

/** One little one the engine gave no words for: its line says so in the operator's language. */
export const unnamedLittleOne: LittleOnes = {
  ones: [{ ...little(0), label: null }],
  working: 1,
  total: 1,
};

const none = sampleLittleOnes([]);

/** One beat of the turn the gallery plays: what its work is from `at` ms on, and whether it still runs. */
export interface PlayedBeat {
  readonly at: number;
  readonly work: TurnWork;
  readonly live: boolean;
  /** What the bot is doing, as its line says it. */
  readonly doing: string;
}

/**
 * A turn played whole: a plan of four steps; on the second the bot splits
 * into three little ones, one of which fails; then it finishes the plan.
 */
export const playedTurn: ReadonlyArray<PlayedBeat> = [
  {
    at: 0,
    work: { plan: samplePlan(0), littleOnes: none },
    live: true,
    doing: "Reading the brief",
  },
  {
    at: 1400,
    work: { plan: samplePlan(1), littleOnes: none },
    live: true,
    doing: "Comparing the three vendors",
  },
  {
    at: 2200,
    work: { plan: samplePlan(1), littleOnes: sampleLittleOnes(["working", "working", "working"]) },
    live: true,
    doing: "Comparing the three vendors",
  },
  {
    at: 6200,
    work: { plan: samplePlan(1), littleOnes: sampleLittleOnes(["working", "done", "working"]) },
    live: true,
    doing: "Comparing the three vendors",
  },
  {
    at: 7900,
    work: { plan: samplePlan(1), littleOnes: sampleLittleOnes(["working", "done", "failed"]) },
    live: true,
    doing: "Comparing the three vendors",
  },
  {
    at: 10_800,
    work: { plan: samplePlan(1), littleOnes: sampleLittleOnes(["done", "done", "failed"]) },
    live: true,
    doing: "Comparing the three vendors",
  },
  {
    at: 12_000,
    work: { plan: samplePlan(2), littleOnes: sampleLittleOnes(["done", "done", "failed"]) },
    live: true,
    doing: "Writing the comparison",
  },
  {
    at: 13_300,
    work: { plan: samplePlan(3), littleOnes: sampleLittleOnes(["done", "done", "failed"]) },
    live: true,
    doing: "Sending it",
  },
  {
    at: 14_400,
    work: { plan: samplePlan(4), littleOnes: sampleLittleOnes(["done", "done", "failed"]) },
    live: true,
    doing: "Sending it",
  },
  {
    at: 14_900,
    work: { plan: samplePlan(4), littleOnes: sampleLittleOnes(["done", "done", "failed"]) },
    live: false,
    doing: "",
  },
];

/**
 * A turn that hands its little ones off: it splits into three, replies and
 * ends while they still work, and they come home one by one after its reply,
 * the last of them failing (decision 0095).
 */
export const playedHandOff: ReadonlyArray<PlayedBeat> = [
  { at: 0, work: { plan: null, littleOnes: none }, live: true, doing: "Reading the brief" },
  {
    at: 1200,
    work: { plan: null, littleOnes: sampleLittleOnes(["working", "working", "working"]) },
    live: true,
    doing: "Comparing the three vendors",
  },
  {
    at: 4600,
    work: { plan: null, littleOnes: sampleLittleOnes(["working", "working", "working"]) },
    live: false,
    doing: "",
  },
  {
    at: 7600,
    work: { plan: null, littleOnes: sampleLittleOnes(["done", "working", "working"]) },
    live: false,
    doing: "",
  },
  {
    at: 9600,
    work: { plan: null, littleOnes: sampleLittleOnes(["done", "done", "working"]) },
    live: false,
    doing: "",
  },
  {
    at: 11_800,
    work: { plan: null, littleOnes: sampleLittleOnes(["done", "done", "failed"]) },
    live: false,
    doing: "",
  },
];

/** One beat of the room the gallery plays: a member's work from `at` ms on, null once its turn there is over. */
export interface PlayedRoomBeat {
  readonly at: number;
  readonly work: TurnWork | null;
}

/**
 * A member's turn in a room, played whole, with no plan: it splits into two
 * little ones, one does its part, the other fails, and its turn ends.
 */
export const playedRoom: ReadonlyArray<PlayedRoomBeat> = [
  { at: 0, work: null },
  { at: 900, work: { plan: null, littleOnes: sampleLittleOnes(["working", "working"]) } },
  { at: 4600, work: { plan: null, littleOnes: sampleLittleOnes(["done", "working"]) } },
  { at: 6400, work: { plan: null, littleOnes: sampleLittleOnes(["done", "failed"]) } },
  { at: 10_500, work: null },
];
