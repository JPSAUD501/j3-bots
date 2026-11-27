// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoutineId, RoutineRunId, RoutineStep } from "@j3-bots/contracts";
import { PROFILE_LIMITS } from "@j3-bots/contracts";
import type { EarlierStep, RoutineStepWake, Wake } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import { fitsEngine } from "../turns/envelopes.ts";

/** What a report of a step held, as far as the steps after it are told. */
export interface ReportSoFar {
  readonly position: number;
  readonly result: string;
  readonly handoff: string | null;
}

/**
 * What the later steps' envelopes may carry that is not known yet: a yes's
 * question and note, the trigger's text, when the run was due. Each holds at
 * most a few thousand characters, defused tags included.
 */
const UNKNOWN_RESERVE = 6_000;
const LONGEST_RESULT = 200;
const LONGEST_QUESTION = 2_000;
const LONGEST_NOTE = 2_000;

const placeholder = (length: number) => "x".repeat(length);

/** A zone's name is a few words at most, which the reserve covers. */
const ZONE = DateTime.zoneMakeNamedUnsafe("UTC");

/**
 * Whether every later bot step of a run still fits the engine's input with
 * what the run carries so far: its trigger data, each step's own brief, and
 * the reports given, `reports` including the one being made (decision 0080).
 * A later step that has not reported yet counts with the longest result line
 * and no handoff, since its own handoff is checked when it is made; a yes
 * before a step counts with the longest question and note.
 */
export function laterStepsFit(run: {
  readonly at: DateTime.Utc;
  readonly routineId: RoutineId;
  readonly runId: RoutineRunId;
  readonly name: string;
  readonly steps: ReadonlyArray<RoutineStep>;
  readonly position: number;
  readonly reports: ReadonlyArray<ReportSoFar>;
  readonly triggerData: string | null;
}): boolean {
  const bots = run.steps.flatMap((step, index) => (step._tag === "bot" ? [index] : []));
  const reported = new Map(run.reports.map((report) => [report.position, report]));
  return bots
    .filter((index) => index > run.position)
    .every((index) => {
      const step = run.steps[index];
      if (step?._tag !== "bot") return true;
      const earlier: Array<EarlierStep> = bots
        .filter((before) => before < index)
        .map((before) => {
          const report = reported.get(before);
          const done = run.steps[before];
          const action = done?._tag === "bot" ? done.action : "";
          return {
            bot: placeholder(PROFILE_LIMITS.name),
            action,
            result: report?.result ?? placeholder(LONGEST_RESULT),
            handoff: report?.handoff ?? null,
          };
        });
      const wake: Wake = {
        at: run.at,
        timeZone: ZONE,
        sinceLastTurn: [],
        kind: "routine",
        routine: {
          id: run.routineId,
          name: run.name,
          trigger: { type: "webhook" },
          instruction: step.instruction,
        },
        step: {
          number: bots.indexOf(index) + 1,
          of: bots.length,
          action: step.action,
          earlier,
          approved:
            run.steps[index - 1]?._tag === "yes"
              ? { question: placeholder(LONGEST_QUESTION), note: placeholder(LONGEST_NOTE) }
              : null,
          next: null,
        } satisfies RoutineStepWake,
        runId: run.runId,
        recentRuns: [],
        recentRunsLeftOut: false,
        triggerData: run.triggerData,
        dueAt: null,
      };
      return fitsEngine(wake, UNKNOWN_RESERVE);
    });
}
