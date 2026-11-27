// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId, RoutineRunId, RoutineStep } from "@j3-bots/contracts";
import type { ToolInput } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, json } from "../persistence/columns.ts";
import { RoutineRuns } from "../routines/RoutineRuns.ts";
import { StepReport } from "../routines/runSteps.ts";
import { laterStepsFit } from "../routines/stepFit.ts";
import { TurnToolRefused } from "../tools/TurnTools.ts";
import { SessionRowId } from "./model.ts";
import type { Once } from "./routineTool.ts";

type FinishStepInput = ToolInput<"finish_step">;

const StepOfSession = Schema.Struct({
  wake_id: Schema.String,
  run_id: RoutineRunId,
  routine_id: RoutineId,
  name: Schema.String,
  trigger_data: Schema.NullOr(Schema.String),
  on_event: Flag,
  position: Schema.Int,
  steps_json: json(Schema.Array(RoutineStep)),
});

const ReportRow = Schema.Struct({ position: Schema.Int, report_json: json(StepReport) });

const refuse = (reason: string) => new TurnToolRefused({ reason });

/** What comes after a bot step before the next one: a condition, a yes, both or neither. */
const followingOf = (steps: ReadonlyArray<RoutineStep>, position: number) => {
  let condition: string | null = null;
  let yes: { readonly onlyIf: string | null } | null = null;
  for (const step of steps.slice(position + 1)) {
    if (step._tag === "bot") break;
    if (step._tag === "condition") condition = step.check;
    else yes = { onlyIf: step.onlyIf };
  }
  return { condition, yes };
};

/**
 * Why a report does not give what comes after the step needs, in words for
 * the bot, or undefined when it does. A step that could not go on needs
 * nothing more than its reason.
 */
const reportProblem = (
  input: FinishStepInput,
  following: ReturnType<typeof followingOf>,
): string | undefined => {
  if (input.blocked === true) return undefined;
  const { condition, yes } = following;
  if (condition !== null && input.goOn === undefined) {
    return `A condition follows your step, "${condition}": say with goOn whether it holds.`;
  }
  if (condition === null && input.goOn !== undefined) {
    return "No condition follows your step: leave goOn out.";
  }
  const asked = condition === null || input.goOn === true;
  if (yes === null) {
    return input.ask === undefined ? undefined : "No yes follows your step: leave ask out.";
  }
  if (asked && yes.onlyIf === null && input.ask === undefined) {
    return "Your user's yes follows your step: give ask, the question and the labels of its two choices.";
  }
  return undefined;
};

/**
 * `finish_step` (decision 0080): the bot of a step of a routine with several
 * steps reports it, from that step's side session, once per attempt. The run
 * moves on from the report once the step's turn has ended
 * (`RoutineRuns.settle`).
 */
export const finishStepTool = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* RoutineRuns;

  const stepOf = SqlSchema.findOneOption({
    Request: SessionRowId,
    Result: StepOfSession,
    execute: (sessionId) => sql`
      SELECT s.side_wake_id AS wake_id, r.id AS run_id, r.routine_id, ro.name, r.trigger_data,
        json_extract(ro.trigger_json, '$._tag') = 'event' AS on_event, r.step AS position,
        r.steps_json
      FROM sessions s JOIN routine_runs r ON r.wake_id = s.side_wake_id
      JOIN routines ro ON ro.id = r.routine_id
      WHERE s.id = ${sessionId} AND s.purpose = 'side' AND r.status = 'running'
        AND r.steps_json IS NOT NULL AND r.step IS NOT NULL
    `,
  });

  /** What the steps before this one reported, in this run. */
  const reportsBefore = SqlSchema.findAll({
    Request: Schema.Struct({ runId: RoutineRunId, position: Schema.Int }),
    Result: ReportRow,
    execute: ({ runId, position }) => sql`
      SELECT position, report_json FROM routine_run_steps
      WHERE run_id = ${runId} AND position < ${position} AND report_json IS NOT NULL
    `,
  });

  return Effect.fn("FinishStepTool.finishStep")(function* (
    request: { readonly sessionId: SessionRowId },
    input: FinishStepInput,
    once: Once,
  ) {
    const found = yield* stepOf(request.sessionId).pipe(Effect.orDie);
    if (Option.isNone(found)) {
      return yield* refuse(
        "finish_step reports a step of a routine with several steps, from that step's own run; this turn is not one.",
      );
    }
    const { wake_id: wakeId, run_id: runId, position, steps_json: steps } = found.value;
    const problem = reportProblem(input, followingOf(steps, position));
    if (problem !== undefined) return yield* refuse(problem);
    const report: StepReport = {
      result: input.result,
      handoff: input.handoff ?? null,
      goOn: input.goOn ?? null,
      ask: input.ask ?? null,
      blocked: input.blocked === true,
    };
    if (report.handoff !== null) {
      const before = yield* reportsBefore({ runId, position }).pipe(Effect.orDie);
      const fits = laterStepsFit({
        at: yield* DateTime.now,
        routineId: found.value.routine_id,
        runId,
        name: found.value.name,
        steps,
        position,
        reports: [
          ...before.map((row) => ({
            position: row.position,
            result: row.report_json.result,
            handoff: row.report_json.handoff,
          })),
          { position, result: report.result, handoff: report.handoff },
        ],
        triggerData: found.value.trigger_data,
        onEvent: found.value.on_event,
      });
      if (!fits) {
        return yield* refuse(
          "Your handoff makes the steps after yours too large to start: shorten it to only what they need, and call finish_step again.",
        );
      }
    }
    return yield* once(
      Effect.gen(function* () {
        if (!(yield* runs.report({ runId, wakeId, report }))) {
          return yield* refuse("Your step has its report already. End your turn.");
        }
        return {
          status: "recorded",
          next: "End your turn now: the routine goes on once it has ended.",
        } satisfies Schema.Json;
      }),
    );
  });
});
