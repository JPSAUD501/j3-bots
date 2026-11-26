// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, ProviderId } from "@j3-bots/contracts";
import { isBackgroundWorkPending, SessionId } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { EngineState } from "../engine/EngineState.ts";
import { SessionRowId } from "./model.ts";
import { Observer } from "./Observer.ts";
import { sessionWork } from "./sessionWork.ts";

const EngineSessionRow = Schema.Struct({
  id: SessionRowId,
  bot_id: BotId,
  engine_session_id: SessionId,
});

/** How many sessions `bots` reads from the engine at once. */
const READ_CONCURRENCY = 4;

/**
 * The bots with work running in the engine: what a restart of the engine
 * stops. A session counts when a turn of it runs, the engine has a dispatch
 * of it or may have one whose answer was lost, or the engine shows a turn it
 * can still run or background work pending. A session whose state cannot be
 * read now counts, so the operator is asked rather than told nothing runs.
 * With the engine not ready, nothing runs in it. Read under a `SendPause`, so
 * no first send lands between the reading and what the caller does with it.
 */
export class RunningWork extends Context.Service<
  RunningWork,
  {
    readonly bots: Effect.Effect<ReadonlyArray<BotId>>;
    /**
     * The bots with work running in sessions on `providerId`: the provider
     * each session runs on, which a bot whose model changed may still have
     * a session of until it is stopped.
     */
    readonly botsOn: (providerId: ProviderId) => Effect.Effect<ReadonlyArray<BotId>>;
    /** The engine's sessions still in use on `providerId`, running or not. */
    readonly sessionsOn: (providerId: ProviderId) => Effect.Effect<ReadonlyArray<SessionId>>;
  }
>()("@j3-bots/server/turns/RunningWork") {}

export const layer = Layer.effect(
  RunningWork,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engineState = yield* EngineState;
    const observer = yield* Observer;
    const work = sessionWork(sql);

    /** Every session the engine still has in use, retired by J3 Bots or not; on one provider when given. */
    const inEngine = SqlSchema.findAll({
      Request: Schema.NullOr(ProviderId),
      Result: EngineSessionRow,
      execute: (providerId) => sql`
        SELECT id, bot_id, engine_session_id FROM sessions
        WHERE lost_at IS NULL AND engine_session_id IS NOT NULL AND engine_retired_at IS NULL
          AND (${providerId} IS NULL OR provider_id = ${providerId})
        ORDER BY rowid
      `,
    });

    /** Whether the session has a dispatch sent whose answer is not known: the engine may have it. */
    const sentUnanswered = SqlSchema.findAll({
      Request: SessionRowId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (sessionId) => sql`
        SELECT id FROM dispatches
        WHERE session_id = ${sessionId} AND status = 'intended' AND attempts > 0
        LIMIT 1
      `,
    });

    const running = Effect.fn("RunningWork.running")(function* (
      session: typeof EngineSessionRow.Type,
    ) {
      const local = yield* work(session.id);
      if (local.admitted !== null || local.runningTurns > 0 || local.inEngine > 0) return true;
      if ((yield* sentUnanswered(session.id).pipe(Effect.orDie)).length > 0) return true;
      return yield* observer.synchronize(session.id, session.engine_session_id).pipe(
        Effect.map(
          ({ backgroundWork, runnableTurns }) =>
            isBackgroundWorkPending(backgroundWork) || runnableTurns.length > 0,
        ),
        // Only a session the engine no longer has runs nothing for certain.
        Effect.catchTags({
          SessionNotFound: () => Effect.succeed(false),
          EngineUnavailable: () => Effect.succeed(true),
          EngineIncompatible: () => Effect.succeed(true),
          EngineIndeterminate: () => Effect.succeed(true),
          NotObserved: () => Effect.succeed(true),
        }),
      );
    });

    const busy = Effect.fn("RunningWork.busy")(function* (providerId: ProviderId | null) {
      if ((yield* engineState.current).state._tag !== "ready") return [];
      const sessions = yield* inEngine(providerId).pipe(Effect.orDie);
      const found = yield* Effect.forEach(
        sessions,
        (session) => Effect.map(running(session), (runs) => (runs ? [session.bot_id] : [])),
        { concurrency: READ_CONCURRENCY },
      );
      return [...new Set(found.flat())];
    });

    const sessionsOn = (providerId: ProviderId) =>
      inEngine(providerId).pipe(
        Effect.orDie,
        Effect.map((sessions) => sessions.map((session) => session.engine_session_id)),
      );

    return RunningWork.of({ bots: busy(null), botsOn: busy, sessionsOn });
  }),
);
