// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { SessionId } from "@j3-bots/engine-t3";
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

/**
 * The bots with work running in the engine: what a restart of the engine
 * stops. A session counts when a turn of it runs or the engine has a
 * dispatch of it, or when the engine shows a turn it can still run or
 * background work pending. A session whose state cannot be read now counts,
 * so the operator is asked rather than told nothing runs. With the engine not
 * ready, nothing runs in it.
 */
export class RunningWork extends Context.Service<
  RunningWork,
  { readonly bots: Effect.Effect<ReadonlyArray<BotId>> }
>()("@j3-bots/server/turns/RunningWork") {}

export const layer = Layer.effect(
  RunningWork,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engineState = yield* EngineState;
    const observer = yield* Observer;
    const work = sessionWork(sql);

    /** Every session the engine still has in use, retired by J3 Bots or not. */
    const inEngine = SqlSchema.findAll({
      Request: Schema.Void,
      Result: EngineSessionRow,
      execute: () => sql`
        SELECT id, bot_id, engine_session_id FROM sessions
        WHERE lost_at IS NULL AND engine_session_id IS NOT NULL AND engine_retired_at IS NULL
        ORDER BY rowid
      `,
    });

    const running = Effect.fn("RunningWork.running")(function* (
      session: typeof EngineSessionRow.Type,
    ) {
      const local = yield* work(session.id);
      if (local.admitted !== null || local.runningTurns > 0 || local.inEngine > 0) return true;
      return yield* observer.synchronize(session.id, session.engine_session_id).pipe(
        Effect.map(
          ({ backgroundWork, runnableTurns }) =>
            backgroundWork === "pending" || runnableTurns.length > 0,
        ),
        Effect.catchTags({
          SessionNotFound: () => Effect.succeed(false),
          EngineUnavailable: () => Effect.succeed(false),
          EngineIncompatible: () => Effect.succeed(false),
          EngineIndeterminate: () => Effect.succeed(true),
          NotObserved: () => Effect.succeed(true),
        }),
      );
    });

    const bots = Effect.gen(function* () {
      if ((yield* engineState.current).state._tag !== "ready") return [];
      const working = new Set<BotId>();
      for (const session of yield* inEngine(undefined).pipe(Effect.orDie)) {
        if (working.has(session.bot_id)) continue;
        if (yield* running(session)) working.add(session.bot_id);
      }
      return [...working];
    }).pipe(Effect.withSpan("RunningWork.bots"));

    return RunningWork.of({ bots });
  }),
);
