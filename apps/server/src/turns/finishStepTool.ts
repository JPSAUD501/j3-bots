// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineRunId, RoutineStep } from "@j3-bots/contracts";
import type { ToolInput } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { json } from "../persistence/columns.ts";
import { RoutineRuns } from "../routines/RoutineRuns.ts";
import type { StepReport } from "../routines/runSteps.ts";
import { TurnToolRefused } from "../tools/TurnTools.ts";
import { SessionRowId } from "./model.ts";
import type { Once } from "./routineTool.ts";

type FinishStepInput = ToolInput<"finish_step">;

const StepOfSession = Schema.Struct({
  wake_id: Schema.String,
  run_id: RoutineRunId,
  position: Schema.Int,
  steps_json: json(Schema.Array(RoutineStep)),
});

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
      SELECT s.side_wake_id AS wake_id, r.id AS run_id, r.step AS position, r.steps_json
      FROM sessions s JOIN routine_runs r ON r.wake_id = s.side_wake_id
      WHERE s.id = ${sessionId} AND s.purpose = 'side' AND r.status = 'running'
        AND r.steps_json IS NOT NULL AND r.step IS NOT NULL
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
