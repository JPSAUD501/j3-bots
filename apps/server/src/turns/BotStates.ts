// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type BotState, EntryId } from "@j3-bots/contracts";
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
import { shownStep } from "./shownStep.ts";

const Card = Schema.Struct({ entry_id: EntryId });

const RunningTurn = Schema.Struct({
  started_at: Time,
  last_activity_at: Time,
  work_fold_entry_id: Schema.NullOr(EntryId),
});

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
    /**
     * Whether a change of the bot's settings waits for background work in its
     * main session, which a Stop ends (`EngineSessions`, Settings alignment).
     */
    readonly settingsHeld: (botId: BotId) => Effect.Effect<boolean>;
    /**
     * Whether the bot's opening is still to come or under way: its
     * `first-run` wake waits or is with the engine (`Bot.opening`).
     */
    readonly opening: (botId: BotId) => Effect.Effect<boolean>;
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
        WHERE s.bot_id = ${botId} AND s.lost_at IS NULL AND r.closed_at IS NULL
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
        WHERE s.bot_id = ${botId} AND s.lost_at IS NULL AND t.finished_at IS NULL
        ORDER BY t.started_at DESC LIMIT 1
      `,
    });

    const shown = shownStep(sql);

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

    const heldSession = SqlSchema.findOneOption({
      Request: BotId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (botId) => sql`
        SELECT id FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL AND lost_at IS NULL
          AND settings_pending > 0 AND settings_held = 1
      `,
    });

    const settingsHeld = Effect.fn("BotStates.settingsHeld")(function* (botId: BotId) {
      return Option.isSome(yield* heldSession(botId));
    }, Effect.orDie);

    const openingWake = SqlSchema.findOneOption({
      Request: BotId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (botId) => sql`
        SELECT id FROM wakes
        WHERE bot_id = ${botId} AND status IN ('pending', 'dispatched')
          AND json_extract(payload_json, '$._tag') = 'first-run'
        LIMIT 1
      `,
    });

    const opening = Effect.fn("BotStates.opening")(function* (botId: BotId) {
      return Option.isSome(yield* openingWake(botId));
    }, Effect.orDie);

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
        const step = fold === null ? Option.none() : yield* shown(fold);
        if (Option.isNone(step)) return { _tag: "thinking", since, stalled } as const;
        const latest = step.value;
        const running = latest.status === "running";
        return {
          _tag: "working",
          since,
          stalled,
          activity: running ? latest.label : null,
          tool: running ? latest.tool : null,
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
        WHERE s.lost_at IS NULL AND t.finished_at IS NULL AND t.last_activity_at < ${before}
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

    return BotStates.of({ of, settingsHeld, opening, watchStalls });
  }),
);
