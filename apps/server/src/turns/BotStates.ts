// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type BotState, EntryId, WorkStep } from "@j3-bots/contracts";
import { TurnOutcome } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { EngineState } from "../engine/EngineState.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { STALL_AFTER } from "./model.ts";

const Card = Schema.Struct({ entry_id: EntryId });

const RunningTurn = Schema.Struct({
  started_at: Time,
  last_activity_at: Time,
  work_fold_entry_id: Schema.NullOr(EntryId),
});

const StepRow = Schema.Struct({ step_json: json(WorkStep) });

const Continuation = Schema.Struct({
  continuation_resumes_at: Time,
  outcome_json: Schema.NullOr(json(TurnOutcome)),
});

const BotRow = Schema.Struct({ id: BotId, provider_id: Schema.String });

/**
 * What each bot is doing, for the roster (`docs/architecture/server.md`, 4. The
 * turn is observed): read from what the observer applied, never from a
 * client's timer. An engine request waiting on the operator comes first, then
 * a running turn, then a turn blocked until a usage limit resets, then an
 * `ask` card the bot is waiting on.
 */
export class BotStates extends Context.Service<
  BotStates,
  {
    readonly of: (botId: BotId) => Effect.Effect<BotState>;
    /** Tells the roster about turns that just went quiet long enough to look stalled. */
    readonly watchStalls: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/BotStates") {}

export const layer = Layer.effect(
  BotStates,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engineState = yield* EngineState;
    const changes = yield* ChangeLog;

    const engineCard = SqlSchema.findOneOption({
      Request: BotId,
      Result: Card,
      execute: (botId) => sql`
        SELECT r.entry_id FROM engine_requests r JOIN sessions s ON s.id = r.session_id
        WHERE s.bot_id = ${botId} AND r.closed_at IS NULL
        ORDER BY r.rowid LIMIT 1
      `,
    });

    const runningTurn = SqlSchema.findOneOption({
      Request: BotId,
      Result: RunningTurn,
      execute: (botId) => sql`
        SELECT t.started_at, t.last_activity_at, t.work_fold_entry_id
        FROM sessions s JOIN turns t
          ON t.session_id = s.id AND t.engine_turn_id = s.admitted_turn_id
        WHERE s.bot_id = ${botId} AND t.finished_at IS NULL
        ORDER BY t.started_at DESC LIMIT 1
      `,
    });

    const latestStep = SqlSchema.findOneOption({
      Request: EntryId,
      Result: StepRow,
      execute: (foldId) => sql`
        SELECT step_json FROM work_steps WHERE entry_id = ${foldId}
        ORDER BY position DESC LIMIT 1
      `,
    });

    const continuation = SqlSchema.findOneOption({
      Request: BotId,
      Result: Continuation,
      execute: (botId) => sql`
        SELECT continuation_resumes_at, outcome_json FROM dispatches
        WHERE bot_id = ${botId} AND status = 'delivered' AND continuation_resumes_at IS NOT NULL
        ORDER BY continuation_resumes_at LIMIT 1
      `,
    });

    const askCard = SqlSchema.findOneOption({
      Request: BotId,
      Result: Card,
      execute: (botId) => sql`
        SELECT a.entry_id FROM ask_cards a JOIN entries e ON e.id = a.entry_id
        WHERE e.author_bot_id = ${botId} AND a.closed_at IS NULL
        ORDER BY e.seq LIMIT 1
      `,
    });

    const providerOf = SqlSchema.findOneOption({
      Request: BotId,
      Result: BotRow,
      execute: (botId) => sql`SELECT id, provider_id FROM bots WHERE id = ${botId}`,
    });

    const of = Effect.fn("BotStates.of")(function* (botId: BotId) {
      const card = yield* engineCard(botId);
      if (Option.isSome(card)) return { _tag: "waiting", entryId: card.value.entry_id } as const;

      const turn = yield* runningTurn(botId);
      if (Option.isSome(turn)) {
        const now = yield* DateTime.now;
        const stalled = Duration.isGreaterThan(
          DateTime.distance(turn.value.last_activity_at, now),
          STALL_AFTER,
        );
        const since = turn.value.started_at;
        const fold = turn.value.work_fold_entry_id;
        const step = fold === null ? Option.none() : yield* latestStep(fold);
        if (Option.isNone(step)) return { _tag: "thinking", since, stalled } as const;
        const latest = step.value.step_json;
        return {
          _tag: "working",
          since,
          stalled,
          activity: latest.status === "running" ? latest.label : null,
        } as const;
      }

      const pending = yield* continuation(botId);
      if (Option.isSome(pending)) {
        const outcome = pending.value.outcome_json;
        return {
          _tag: "blocked",
          failure: outcome?._tag === "failed" ? outcome.failure : "usage-limit",
          retryAt: pending.value.continuation_resumes_at,
        } as const;
      }
      const bot = yield* providerOf(botId);
      if (Option.isSome(bot)) {
        const status = yield* engineState.current;
        const provider = status.providers.find((p) => p.id === bot.value.provider_id);
        if (provider?.status._tag === "limited") {
          return {
            _tag: "blocked",
            failure: "usage-limit",
            retryAt: provider.status.resetsAt,
          } as const;
        }
      }

      const asked = yield* askCard(botId);
      if (Option.isSome(asked)) return { _tag: "waiting", entryId: asked.value.entry_id } as const;
      return { _tag: "idle" } as const;
    }, Effect.orDie);

    const quietSince = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ bot_id: BotId }),
      execute: (before) => sql`
        SELECT DISTINCT s.bot_id FROM sessions s JOIN turns t
          ON t.session_id = s.id AND t.engine_turn_id = s.admitted_turn_id
        WHERE t.finished_at IS NULL AND t.last_activity_at < ${before}
      `,
    });

    /** Bots already reported stalled, so a quiet turn is reported once, not every minute. */
    const reported = new Set<BotId>();

    const checkStalls = Effect.gen(function* () {
      const before = timeText(DateTime.subtractDuration(yield* DateTime.now, STALL_AFTER));
      const stalled = new Set(
        (yield* quietSince(before).pipe(Effect.orDie)).map((row) => row.bot_id),
      );
      for (const botId of new Set([...stalled, ...reported])) {
        // Entering or leaving the stall changes what the roster shows.
        if (stalled.has(botId) !== reported.has(botId)) {
          yield* changes.touch({ _tag: "bot", botId });
          if (stalled.has(botId)) reported.add(botId);
          else reported.delete(botId);
        }
      }
    });

    const watchStalls = checkStalls.pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.andThen(Effect.never),
    );

    return BotStates.of({ of, watchStalls });
  }),
);
