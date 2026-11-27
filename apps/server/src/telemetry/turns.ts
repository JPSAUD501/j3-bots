// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  EffortLevel,
  type FailureClass,
  ModelId,
  ProviderId,
  RoutineTrigger,
  type TelemetryEvent,
  type TelemetryTurnOutcome,
} from "@j3-bots/contracts";
import type { TurnOutcome } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { EngineState } from "../engine/EngineState.ts";
import { json } from "../persistence/columns.ts";
import type { WakeRow } from "../turns/Ledger.ts";
import { effortOf, harnessOf, modelOf, originOf, type WokenBy } from "./events.ts";

const BotRow = Schema.Struct({
  provider_id: ProviderId,
  model_id: ModelId,
  effort: Schema.NullOr(EffortLevel),
});

const TriggerRow = Schema.Struct({ trigger_json: json(RoutineTrigger) });

const outcomeOf = (
  outcome: TurnOutcome,
): { readonly outcome: TelemetryTurnOutcome; readonly failure: FailureClass | null } => {
  switch (outcome._tag) {
    case "completed":
      return { outcome: "completed", failure: null };
    case "interrupted":
    case "cancelled":
      return { outcome: "stopped", failure: null };
    case "failed":
      return { outcome: "failed", failure: outcome.failure };
  }
};

/**
 * The `turn.finished` event of a bot's turn that ended: its harness, its
 * model and effort as the bot has them, where it came from by the wakes it
 * carried, how it ended and how long it ran. None for a bot that is gone.
 */
export const turnFinishedEvent = (
  sql: SqlClient.SqlClient,
  engineState: EngineState["Service"],
) => {
  const bot = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: BotRow,
    execute: (botId) => sql`SELECT provider_id, model_id, effort FROM bots WHERE id = ${botId}`,
  });
  const trigger = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: TriggerRow,
    execute: (routineId) => sql`SELECT trigger_json FROM routines WHERE id = ${routineId}`,
  });
  return Effect.fn("telemetry.turnFinishedEvent")(function* (input: {
    readonly botId: BotId;
    readonly startedAt: DateTime.Utc;
    readonly finishedAt: DateTime.Utc;
    readonly outcome: TurnOutcome;
    readonly wakes: ReadonlyArray<WakeRow>;
  }) {
    const row = yield* bot(input.botId);
    if (Option.isNone(row)) return Option.none<TelemetryEvent>();
    const status = yield* engineState.current;
    const woken = yield* Effect.forEach(input.wakes, (wake) =>
      wake.payload_json._tag === "routine"
        ? trigger(wake.payload_json.routineId).pipe(
            Effect.map((found): WokenBy => ({
              kind: wake.kind,
              trigger: Option.match(found, {
                onNone: () => null,
                onSome: (each) => each.trigger_json._tag,
              }),
            })),
          )
        : Effect.succeed<WokenBy>({ kind: wake.kind, trigger: null }),
    );
    const millis =
      DateTime.toEpochMillis(input.finishedAt) - DateTime.toEpochMillis(input.startedAt);
    return Option.some<TelemetryEvent>({
      event: "turn.finished",
      properties: {
        harness: harnessOf(status, row.value.provider_id),
        model: modelOf(status, { providerId: row.value.provider_id, modelId: row.value.model_id }),
        effort: effortOf(row.value.effort),
        origin: originOf(woken),
        ...outcomeOf(input.outcome),
        durationSeconds: Math.max(0, Math.round(millis / 1000)),
      },
    });
  }, Effect.orDie);
};
