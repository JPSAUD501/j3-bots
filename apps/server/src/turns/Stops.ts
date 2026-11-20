// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandId,
  type Conflict,
  EntryId,
  NotFound,
  RoomId,
} from "@j3-bots/contracts";
import { Engine, IdempotencyKey, SessionId } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { BotStore } from "../bots/BotStore.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { RoomWork } from "../rooms/RoomWork.ts";
import { Ledger } from "./Ledger.ts";
import { AudienceColumn, DispatchRowId, DispatchSeq, SessionRowId } from "./model.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { DEFECT_RETRY, type Pass, onePassAtATime, passOutcome, reconcile } from "./reconciler.ts";
import { SessionGate } from "./SessionGate.ts";
import { sessionLoss } from "./sessionRecords.ts";
import { Signals } from "./Signals.ts";
import { stopKey, stopTargets } from "./stopTargets.ts";
import { WorkSteps } from "./WorkSteps.ts";

/** What a Stop ends: all of a bot's work, or only the work addressed to one room. */
export type StopScope =
  | { readonly _tag: "bot" }
  | { readonly _tag: "room"; readonly roomId: RoomId };

const Round = Schema.Struct({
  stop_id: Schema.String,
  session_id: SessionRowId,
  round: Schema.Int,
  engine_key: IdempotencyKey,
  sent: Schema.BooleanFromBit,
  engine_session_id: Schema.NullOr(SessionId),
  retry_at: Schema.NullOr(Time),
});
type Round = typeof Round.Type;

const Fenced = Schema.Struct({
  id: DispatchRowId,
  bot_id: BotId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  status: Schema.Literals(["intended", "failed"]),
  attempts: Schema.Int,
  seq: DispatchSeq,
});

/**
 * How one session's Stop work went in a pass of the runner: done for now
 * (also when it waits for the recovery, whose settling nudges the runner),
 * left for a later pass, or refused by the engine, which ends the pass.
 */
type Progress = "done" | "deferred" | "unavailable";

/**
 * The operator's Stop (`docs/architecture/server.md`, Stop): recorded in one
 * transaction with its targets, fences and cancelled wakes. Then, per target
 * session: once the recovery has settled every dispatch whose answer was
 * lost, each latest round is issued and sent through the session's gate,
 * which only acknowledges it; the session's events are then synchronized past
 * that acknowledgment, which marks the round observed. A target is confirmed
 * only from events applied once all its latest rounds are observed, never
 * from what the server knew before. The runner is a reconciler over the
 * targets: a session that cannot go on now waits for a later pass alone.
 */
export class Stops extends Context.Service<
  Stops,
  {
    /** Records a Stop of the bot's work in scope, in the caller's transaction. */
    readonly record: (botId: BotId, scope: StopScope) => Effect.Effect<void>;
    /** `bot.stop`. */
    readonly stopBot: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /** One pass of the runner over every unsettled target. */
    readonly runPending: Effect.Effect<void>;
    /** The runner, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/Stops") {}

/**
 * A dispatch whose recovery gave up may still land: the engine keeps its key
 * for good, so a Stop over its work fences it (`stopTargets.openRound`).
 */
const mayLand = (sql: SqlClient.SqlClient) =>
  sql`(status = 'failed' AND failure_reason = 'unresolved')`;

export const layer = Layer.effect(
  Stops,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const ids = yield* Ids;
    const engine = yield* Engine;
    const gate = yield* SessionGate;
    const ledger = yield* Ledger;
    const signals = yield* Signals;
    const observer = yield* Observer;
    const readiness = yield* Readiness;
    const receipts = yield* CommandReceipts;
    const bots = yield* BotStore;
    const targets = stopTargets(sql);
    const { sessionLost } = sessionLoss(sql, yield* Entries, ledger, yield* WorkSteps, signals);

    /** Whether an audience column pair is in a Stop's scope. */
    const inScope = (scope: StopScope) =>
      scope._tag === "bot"
        ? sql`1`
        : sql`(audience = 'room' AND audience_room_id = ${scope.roomId})`;

    const record = Effect.fn("Stops.record")(function* (botId: BotId, scope: StopScope) {
      const at = timeText(yield* DateTime.now);
      const landing = mayLand(sql);
      // Every session of the bot with work in scope that may be in the engine.
      // A bot Stop reaches every live session too, for background work the
      // server does not see.
      const sessions = yield* sql<{ readonly id: string }>`
        SELECT s.id FROM sessions s WHERE s.bot_id = ${botId} AND s.lost_at IS NULL AND (
          ${scope._tag === "bot" ? sql`(s.retired_at IS NULL AND s.engine_session_id IS NOT NULL) OR` : sql``}
          EXISTS (
            SELECT 1 FROM turns WHERE session_id = s.id AND finished_at IS NULL AND ${inScope(scope)}
          )
          OR EXISTS (
            SELECT 1 FROM dispatches WHERE session_id = s.id AND ${inScope(scope)} AND (
              (status = 'intended' AND attempts > 0) OR status IN ('accepted', 'delivered')
              OR ${landing}
            )
          )
        )
      `;
      const sessionIds = sessions.map((s) => s.id);
      // A dispatch in scope never sent is fenced even when no session needs
      // the engine's Stop, so it is never sent; in a target session, every
      // undecided dispatch is, since the engine's Stop ends the whole session.
      // So is one that may still land, so that its landing reopens this Stop
      // (`stopTargets.openRound`); it stays failed and the recovery's no more.
      const fenceable = sql`
        bot_id = ${botId} AND (status = 'intended' OR ${landing}) AND fenced_by_stop_id IS NULL
          AND (${inScope(scope)}${sessionIds.length > 0 ? sql` OR ${sql.in("session_id", sessionIds)}` : sql``})
      `;
      const [anyFenceable] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM dispatches WHERE ${fenceable}
      `;
      if (sessionIds.length > 0 || (anyFenceable?.n ?? 0) > 0) {
        const stopId = yield* ids.make("stop");
        // It covers the work of every dispatch written before it, and of none after.
        yield* sql`
          INSERT INTO stops (id, bot_id, scope, room_id, created_at, dispatch_mark)
          VALUES (
            ${stopId}, ${botId}, ${scope._tag}, ${scope._tag === "room" ? scope.roomId : null}, ${at},
            (SELECT COALESCE(MAX(seq), 0) FROM dispatches)
          )
        `;
        for (const sessionId of sessionIds) {
          yield* sql`
            INSERT INTO stop_targets (stop_id, session_id, round, engine_key)
            VALUES (${stopId}, ${sessionId}, 0, ${stopKey(stopId, sessionId, 0)})
          `;
        }
        const fenced = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Fenced,
          execute: () => sql`
            UPDATE dispatches SET fenced_by_stop_id = ${stopId}, updated_at = ${at},
              next_attempt_at = CASE
                WHEN status = 'intended' AND attempts > 0 THEN NULL ELSE next_attempt_at
              END
            WHERE ${fenceable}
            RETURNING id, bot_id, audience, audience_room_id, status, attempts, seq
          `,
        })(undefined);
        // An undecided one the engine may have is settled by the recovery,
        // which owns it from here: once now, since the Stop waits on it, then
        // with its backoff.
        if (fenced.some((dispatch) => dispatch.status === "intended" && dispatch.attempts > 0)) {
          yield* sql.afterCommit(signals.recovery.fire);
        }
        for (const dispatch of fenced) {
          // Never sent: released. Its wakes are cancelled when this Stop
          // covers them, and wait again when they were private work.
          if (dispatch.status === "intended" && dispatch.attempts === 0) {
            yield* ledger.release(
              dispatch.id,
              yield* targets.wakesAfter(dispatch, { _tag: "unsent" }),
            );
          }
        }
      }
      const pending = yield* sql<{ readonly id: string }>`
        SELECT id FROM wakes WHERE bot_id = ${botId} AND status = 'pending' AND ${inScope(scope)}
      `;
      yield* ledger.cancelWakes(pending.map((wake) => wake.id));
      yield* sql.afterCommit(signals.stops.fire);
    }, Effect.orDie);

    const stopBot = Effect.fn("Stops.stopBot")(function* (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "bot.stop",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          if (Option.isNone(yield* bots.find(input.botId))) {
            return yield* new NotFound({ resource: "bot" });
          }
          yield* record(input.botId, { _tag: "bot" });
        }),
      });
    });

    // ---- The runner -------------------------------------------------------------

    /** The latest round of each unconfirmed target, issued or not. */
    const latestRounds = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Round,
      execute: () => sql`
        SELECT t.stop_id, t.session_id, t.round, t.engine_key, t.sent_at IS NOT NULL AS sent,
          s.engine_session_id, t.retry_at
        FROM stop_targets t JOIN sessions s ON s.id = t.session_id
        WHERE t.stopped_at IS NULL AND s.lost_at IS NULL
          AND t.round = (
            SELECT MAX(u.round) FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id
          )
        ORDER BY t.session_id, t.stop_id
      `,
    });

    /**
     * Dispatches of the session whose answer is not known yet, fenced or not:
     * the recovery settles them first, as confirmation requires.
     */
    const inFlight = (sessionId: SessionRowId) =>
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM dispatches
        WHERE session_id = ${sessionId} AND status = 'intended' AND attempts > 0
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      );

    /**
     * The round is issued before its commands go: a turn whose start the
     * events show after this may have been missed by them, and opens the
     * next round.
     */
    const issue = Effect.fn("Stops.issue")(function* (round: Round) {
      yield* sql`
        UPDATE stop_targets SET issued_at = COALESCE(issued_at, ${timeText(yield* DateTime.now)})
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
    }, Effect.orDie);

    /** The engine acknowledged the round's commands. */
    const markSent = Effect.fn("Stops.markSent")(function* (round: Round) {
      yield* sql`
        UPDATE stop_targets SET sent_at = ${timeText(yield* DateTime.now)}
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
    }, Effect.orDie);

    /** A session the engine never had runs nothing: its round counts as observed at once. */
    const markNothingToStop = Effect.fn("Stops.markNothingToStop")(function* (round: Round) {
      const at = timeText(yield* DateTime.now);
      yield* sql`
        UPDATE stop_targets SET issued_at = COALESCE(issued_at, ${at}),
          sent_at = COALESCE(sent_at, ${at}), observed_at = COALESCE(observed_at, ${at})
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
    }, Effect.orDie);

    /** What an engine call's failure means for one session's Stop work. */
    const downProgress = {
      // Nothing was sent: the engine cannot take commands, and the pass ends.
      EngineUnavailable: () => Effect.succeed("unavailable" satisfies Progress as Progress),
      EngineIncompatible: () => Effect.succeed("unavailable" satisfies Progress as Progress),
      // No answer: this session is tried again on a later pass.
      EngineIndeterminate: () => Effect.succeed("deferred" satisfies Progress as Progress),
    };

    /**
     * Sends one round's commands through the gate, which only acknowledges
     * them. The round is issued, durably, before the call.
     */
    const sendRound = Effect.fn("Stops.sendRound")(function* (
      round: Round,
      engineSessionId: SessionId,
    ) {
      return yield* gate.run(round.session_id)(
        issue(round).pipe(
          Effect.andThen(engine.stop({ key: round.engine_key, sessionId: engineSessionId })),
          Effect.andThen(markSent(round)),
          Effect.as("done" satisfies Progress as Progress),
          // The engine has no such session: nothing runs there.
          Effect.catchTag("SessionNotFound", () =>
            transaction(sessionLost(round.session_id)).pipe(Effect.as("done" satisfies Progress)),
          ),
          Effect.catchTags(downProgress),
        ),
      );
    });

    /** A Stop of a session was confirmed: what it held back may go. */
    const settledSession = Effect.all(
      [signals.dispatch.fire, signals.recovery.fire, signals.resumes.fire],
      { discard: true },
    );

    /**
     * The session's events are brought past every round acknowledged so far:
     * those rounds are observed, and the target is confirmed if the events
     * now show nothing left running. Confirmation comes only from here, after
     * a `synchronize`, never from one event as it is applied: the event after
     * it may start a turn the engine had waiting. Background work the engine
     * still counts as pending at the marker leaves the rounds unobserved:
     * the engine interrupts it after the stop answered, and its end is seen
     * only by synchronizing again, on a later pass.
     */
    const observe = Effect.fn("Stops.observe")(function* (
      sessionId: SessionRowId,
      engineSessionId: SessionId,
    ) {
      const sent = yield* sql<{ readonly stop_id: string; readonly round: number }>`
        SELECT stop_id, round FROM stop_targets
        WHERE session_id = ${sessionId} AND stopped_at IS NULL AND sent_at IS NOT NULL
      `.pipe(Effect.orDie);
      if (sent.length === 0) return "done" satisfies Progress;
      const synced = yield* observer.synchronize(sessionId, engineSessionId).pipe(
        Effect.map(({ backgroundWork }): Progress => (backgroundWork ? "deferred" : "done")),
        Effect.catchTags({
          SessionNotFound: () =>
            transaction(sessionLost(sessionId)).pipe(Effect.as("lost" as const)),
          // The marker did not come in time: only this session waits.
          NotObserved: () => Effect.succeed("deferred" satisfies Progress as Progress),
          ...downProgress,
          // A catch-up that could not reach the engine is this session's
          // alone: the pass goes on with the others.
          EngineUnavailable: () => Effect.succeed("deferred" satisfies Progress as Progress),
        }),
      );
      if (synced === "lost") return "done" satisfies Progress;
      if (synced !== "done") return synced;
      const confirmed = yield* transaction(
        Effect.gen(function* () {
          const at = timeText(yield* DateTime.now);
          for (const round of sent) {
            yield* sql`
              UPDATE stop_targets SET observed_at = ${at}
              WHERE stop_id = ${round.stop_id} AND session_id = ${sessionId}
                AND round = ${round.round} AND observed_at IS NULL
            `;
          }
          return yield* targets.confirm(sessionId);
        }),
      ).pipe(Effect.orDie);
      if (confirmed) yield* settledSession;
      return "done" satisfies Progress;
    });

    /** Step 2 to 4 for one session: settle, send, observe. */
    const advance = Effect.fn("Stops.advance")(function* (rounds: ReadonlyArray<Round>) {
      const [first] = rounds;
      if (first === undefined) return "done" satisfies Progress;
      // The recovery settles every dispatch whose answer was lost, on its
      // own backoff, so nothing the bot was sent lands behind the Stop; it
      // nudges the runner when it does.
      if (yield* inFlight(first.session_id)) return "done" satisfies Progress;
      const engineSessionId = first.engine_session_id;
      if (engineSessionId === null) {
        for (const round of rounds) yield* markNothingToStop(round);
        const confirmed = yield* transaction(targets.confirm(first.session_id)).pipe(Effect.orDie);
        if (confirmed) yield* settledSession;
        return "done" satisfies Progress;
      }
      yield* observer.watch(first.session_id);
      for (const round of rounds) {
        if (round.sent) continue;
        const progress = yield* sendRound(round, engineSessionId);
        if (progress !== "done") return progress;
      }
      return yield* observe(first.session_id, engineSessionId);
    });

    const bySession = (rounds: ReadonlyArray<Round>) => {
      const grouped = new Map<SessionRowId, Array<Round>>();
      for (const round of rounds) {
        const list = grouped.get(round.session_id) ?? [];
        list.push(round);
        grouped.set(round.session_id, list);
      }
      return [...grouped];
    };

    /** When the session's Stop work is tried again after a defect, if one is ahead. */
    const retryOf = (rounds: ReadonlyArray<Round>) => {
      let at: DateTime.Utc | null = null;
      for (const round of rounds) {
        if (
          round.retry_at !== null &&
          (at === null || DateTime.isGreaterThan(round.retry_at, at))
        ) {
          at = round.retry_at;
        }
      }
      return at;
    };

    /** A defect in a session's Stop work: tried again there after a durable deadline. */
    const retryLater = Effect.fn("Stops.retryLater")(function* (sessionId: SessionRowId) {
      const at = DateTime.addDuration(yield* DateTime.now, DEFECT_RETRY);
      yield* sql`
        UPDATE stop_targets SET retry_at = ${timeText(at)}
        WHERE session_id = ${sessionId} AND stopped_at IS NULL
      `.pipe(Effect.orDie);
      return at;
    });

    /**
     * Runs one session's Stop work. A defect is logged and only that session
     * waits, until a durable deadline like every other worker's item, as T3
     * Code's effect worker does with each item.
     */
    const supervised = (
      sessionId: SessionRowId,
      rounds: ReadonlyArray<Round>,
      outcome: ReturnType<typeof passOutcome>,
    ) =>
      advance(rounds).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("A Stop round failed; it is tried again later", cause).pipe(
              Effect.andThen(retryLater(sessionId)),
              Effect.map((at) => {
                outcome.until(at);
                return "done" satisfies Progress as Progress;
              }),
            ),
        ),
      );

    const runPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        const rounds = yield* latestRounds(undefined).pipe(Effect.orDie);
        for (const [sessionId, session] of bySession(rounds)) {
          const retry = retryOf(session);
          if (retry !== null && DateTime.isGreaterThan(retry, now)) {
            outcome.until(retry);
            continue;
          }
          const progress = yield* supervised(sessionId, session, outcome);
          if (progress === "unavailable") return { _tag: "unavailable" } as const;
          if (progress === "deferred") outcome.defer();
        }
        return outcome.done();
      }).pipe(Effect.withSpan("Stops.runPending")),
    );

    const runPending = Effect.asVoid(runPass);

    const run = reconcile({
      name: "The Stop runner",
      pass: runPass,
      signal: signals.stops,
      readiness,
    });

    return Stops.of({ record, stopBot, runPending, run });
  }),
);

/**
 * `RoomWork` on top of Stops: archiving or deleting a room stops each member's
 * work addressed to it, cancels the wakes still held for it and expires its
 * open `ask` cards, all in the caller's transaction.
 */
export const roomWorkLayer = Layer.effect(
  RoomWork,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* Stops;
    const entries = yield* Entries;
    const ledger = yield* Ledger;

    const end = Effect.fn("RoomWork.end")(function* (roomId: RoomId) {
      const working = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ bot_id: BotId }),
        execute: () => sql`
          SELECT DISTINCT s.bot_id FROM sessions s
          WHERE EXISTS (
            SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.finished_at IS NULL
              AND t.audience = 'room' AND t.audience_room_id = ${roomId}
          ) OR EXISTS (
            SELECT 1 FROM dispatches d WHERE d.session_id = s.id
              AND d.audience = 'room' AND d.audience_room_id = ${roomId}
              AND (d.status IN ('intended', 'accepted', 'delivered') OR ${mayLand(sql)})
          )
        `,
      })(undefined);
      for (const { bot_id } of working) yield* stops.record(bot_id, { _tag: "room", roomId });

      const pending = yield* sql<{ readonly id: string }>`
        SELECT id FROM wakes
        WHERE status = 'pending' AND audience = 'room' AND audience_room_id = ${roomId}
      `;
      yield* ledger.cancelWakes(pending.map((wake) => wake.id));

      const open = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ entry_id: EntryId }),
        execute: () => sql`
          SELECT entry_id FROM ask_cards
          WHERE closed_at IS NULL AND audience = 'room' AND audience_room_id = ${roomId}
        `,
      })(undefined);
      for (const { entry_id } of open) {
        yield* sql`UPDATE ask_cards SET closed_at = ${timeText(yield* DateTime.now)} WHERE entry_id = ${entry_id}`;
        const card = yield* entries.find(entry_id);
        if (Option.isSome(card) && card.value.entry._tag === "question") {
          yield* entries.update({ ...card.value.entry, status: { _tag: "expired" } });
        }
      }
    }, Effect.orDie);

    return RoomWork.of({ end });
  }),
);
