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

/**
 * `keepOpening`: the bot's `first-run` wake, while the engine has not got it,
 * waits on instead of being cancelled. A change of provider stops the work in
 * progress but not the hello a new bot has yet to send.
 */
interface StopOptions {
  readonly keepOpening: boolean;
}

const Round = Schema.Struct({
  stop_id: Schema.String,
  session_id: SessionRowId,
  round: Schema.Int,
  engine_key: IdempotencyKey,
  sent: Schema.BooleanFromBit,
  engine_session_id: Schema.NullOr(SessionId),
  due_at: Schema.NullOr(Time),
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
 * left for a later pass (also when a durable deadline of its own now holds
 * it), or refused by an engine that cannot take commands, which ends the
 * pass.
 */
type Progress = "done" | "deferred" | "unavailable";

/** What a pass of the runner collects: work it left, and its earliest deadline. */
type Outcome = ReturnType<typeof passOutcome>;

/**
 * The operator's Stop (`docs/architecture/server.md`, Stop): recorded in one
 * transaction with its targets, fences and cancelled wakes. Then, per target
 * session: once the recovery has settled every dispatch whose answer was
 * lost, each latest round is issued and sent through the session's gate,
 * which only acknowledges it; the session's events are then synchronized past
 * that acknowledgment, which marks the round observed. A target is confirmed
 * only from events applied once all its latest rounds are observed, never
 * from what the server knew before; while they still show work it targets,
 * fresh rounds follow on the rounds' own deadlines (`stopTargets`). The
 * runner is a reconciler over the targets: a session that cannot go on now
 * waits for a later pass alone, and a round that waits holds back no other.
 */
export class Stops extends Context.Service<
  Stops,
  {
    /** Records a Stop of the bot's work in scope, in the caller's transaction. */
    readonly record: (botId: BotId, scope: StopScope, options?: StopOptions) => Effect.Effect<void>;
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

    /** Whether a wake column set is the bot's opening (`StopOptions`). */
    const opening = sql`json_extract(payload_json, '$._tag') = 'first-run'`;

    const record = Effect.fn("Stops.record")(function* (
      botId: BotId,
      scope: StopScope,
      options: StopOptions = { keepOpening: false },
    ) {
      const at = timeText(yield* DateTime.now);
      const landing = mayLand(sql);
      // Every session of the bot with work in scope that may be in the engine:
      // a turn running, or a dispatch the engine has or may yet take. A bot
      // Stop reaches every live session too, for background work the server
      // does not see. A session the engine retired has nothing left in it to
      // stop: its retirement ended what ran there. A room's Stop reaches no
      // background work its turns left: room turns, and the Stop of their
      // work, arrive with M3 (`docs/architecture/server.md`, Rooms).
      const sessions = yield* sql<{ readonly id: string }>`
        SELECT s.id FROM sessions s
        WHERE s.bot_id = ${botId} AND s.lost_at IS NULL AND s.engine_retired_at IS NULL AND (
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
        // The turns it reaches: their work is covered, also a turn no
        // dispatch began, which the dispatch mark cannot tell.
        if (sessionIds.length > 0) {
          yield* sql`
            UPDATE turns SET stop_id = ${stopId}
            WHERE finished_at IS NULL AND ${sql.in("session_id", sessionIds)} AND ${inScope(scope)}
          `;
        }
        // What the bot's work in scope sent its teammates is covered with it:
        // a message not delivered yet is cancelled below, and wherever it
        // would wait again (`Ledger`).
        yield* sql`
          UPDATE handoffs SET stop_id = ${stopId}
          WHERE tool_call_id IN (
            SELECT id FROM tool_calls
            WHERE session_id IN (SELECT id FROM sessions WHERE bot_id = ${botId})
              AND ${inScope(scope)}
          )
        `;
        const unsent = yield* sql<{ readonly id: string }>`
          SELECT w.id FROM wakes w JOIN handoffs h ON h.received_entry_id = w.source_entry_id
          WHERE w.status = 'pending' AND w.kind = 'bot' AND h.stop_id = ${stopId}
        `;
        yield* ledger.cancelWakes(unsent.map((wake) => wake.id));
        yield* sql`
          DELETE FROM held_messages
          WHERE consumed_dispatch_id IS NULL AND handoff_entry_id IN (
            SELECT received_entry_id FROM handoffs WHERE stop_id = ${stopId}
          )
        `;
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
          // covers them, and wait again when they were private work or an
          // opening this Stop keeps (a system wake is dispatched alone).
          if (dispatch.status === "intended" && dispatch.attempts === 0) {
            const kept =
              options.keepOpening &&
              (yield* sql`
                SELECT 1 FROM wakes WHERE dispatch_id = ${dispatch.id} AND ${opening}
              `).length > 0;
            yield* ledger.release(
              dispatch.id,
              kept ? { _tag: "pending" } : yield* targets.wakesAfter(dispatch, { _tag: "unsent" }),
            );
          }
        }
      }
      const pending = yield* sql<{ readonly id: string; readonly kind: string }>`
        SELECT id, kind FROM wakes
        WHERE bot_id = ${botId} AND status = 'pending' AND ${inScope(scope)}
          ${options.keepOpening ? sql`AND NOT (${opening})` : sql``}
      `;
      yield* ledger.cancelWakes(pending.map((wake) => wake.id));
      yield* sql.afterCommit(signals.stops.fire);
      // A routine run whose attempt waited is settled now, and its side
      // session retired.
      if (pending.some((wake) => wake.kind === "routine")) {
        yield* sql.afterCommit(signals.routines.fire);
      }
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
          s.engine_session_id, t.due_at, t.retry_at
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
      EngineUnavailable: () => Effect.succeed<Progress>("unavailable"),
      EngineIncompatible: () => Effect.succeed<Progress>("unavailable"),
      // No answer: this session is tried again on a later pass.
      EngineIndeterminate: () => Effect.succeed<Progress>("deferred"),
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
          // Acknowledged, or found moot: either way it gets its grace.
          Effect.andThen(transaction(targets.acknowledge(round)).pipe(Effect.orDie)),
          Effect.as<Progress>("done"),
          Effect.catchTags({
            // The engine has no such session: nothing runs there.
            SessionNotFound: () =>
              transaction(sessionLost(round.session_id)).pipe(Effect.as<Progress>("done")),
            // Refused while its work can still run, which spends the key: a
            // fresh round goes out once its backoff passes.
            StopRejected: () =>
              transaction(targets.rejectRound(round)).pipe(Effect.as<Progress>("deferred")),
            ...downProgress,
          }),
        ),
      );
    });

    /**
     * A Stop of a session was confirmed: what it held back may go, a rotation
     * waiting on it and a spent side session's retirement included.
     */
    const settledSession = Effect.all(
      [
        signals.dispatch.fire,
        signals.recovery.fire,
        signals.resumes.fire,
        signals.rotations.fire,
        signals.routines.fire,
      ],
      { discard: true },
    );

    /**
     * The session's events are brought past every round acknowledged so far,
     * and the targets are judged from what they show. Confirmation comes only
     * from here, after a `synchronize`, never from one event as it is
     * applied: the event after it may start a turn the engine had waiting.
     *
     * With nothing at the marker beyond the applied events, the rounds are
     * observed, and the targets are confirmed if the events show nothing left
     * running. Background work the engine still counts as pending, or a run
     * it can still run (waiting, preparing, starting or running), also one no
     * event told of, leaves them unobserved, and the session is synchronized
     * again a few seconds later. Either way, while
     * the engine still shows work the Stop targets, a target whose latest
     * round's grace passed gets a fresh round (`stopTargets.recheck`): the
     * rule holds by the runner's own deadlines, whatever the events say.
     */
    const observe = Effect.fn("Stops.observe")(function* (
      sessionId: SessionRowId,
      engineSessionId: SessionId,
      outcome: Outcome,
    ) {
      // Only a target's latest round is observed, once acknowledged: one a
      // fresh round superseded decides nothing, and a target whose latest
      // round is not sent yet waits for it.
      const sent = yield* sql<{ readonly stop_id: string; readonly round: number }>`
        SELECT t.stop_id, t.round FROM stop_targets t
        WHERE t.session_id = ${sessionId} AND t.stopped_at IS NULL AND t.sent_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id AND u.round > t.round
          )
      `.pipe(Effect.orDie);
      if (sent.length === 0) return "done" satisfies Progress;
      const synced = yield* observer.synchronize(sessionId, engineSessionId).pipe(
        Effect.map(
          ({ backgroundWork, runnableTurns }) =>
            ({
              _tag: "synchronized",
              // An acknowledged round proves no interrupt: the engine's state
              // after it is what counts, also for work its interrupt missed.
              // Work the engine's stop does not reach is not waited on: no
              // round would end it.
              engineShows: backgroundWork.stoppable || runnableTurns.length > 0,
            }) as const,
        ),
        Effect.catchTags({
          SessionNotFound: () =>
            transaction(sessionLost(sessionId)).pipe(Effect.as({ _tag: "lost" } as const)),
          // The marker did not come in time: only this session waits.
          NotObserved: () => Effect.succeed({ _tag: "deferred" } as const),
          EngineIndeterminate: () => Effect.succeed({ _tag: "deferred" } as const),
          // A catch-up that could not reach the engine is this session's
          // alone: the pass goes on with the others.
          EngineUnavailable: () => Effect.succeed({ _tag: "deferred" } as const),
          EngineIncompatible: () => Effect.succeed({ _tag: "unavailable" } as const),
        }),
      );
      if (synced._tag === "lost") return "done" satisfies Progress;
      if (synced._tag !== "synchronized") return synced._tag satisfies Progress;
      const { engineShows } = synced;
      const judged = yield* transaction(
        Effect.gen(function* () {
          const at = timeText(yield* DateTime.now);
          if (!engineShows) {
            for (const round of sent) {
              yield* sql`
                UPDATE stop_targets SET observed_at = ${at}
                WHERE stop_id = ${round.stop_id} AND session_id = ${sessionId}
                  AND round = ${round.round} AND observed_at IS NULL
              `;
            }
            if (yield* targets.confirm(sessionId)) return { confirmed: true, next: null } as const;
          }
          const { opened, next } = yield* targets.recheck(sessionId, engineShows);
          if (opened) yield* sql.afterCommit(signals.stops.fire);
          return { confirmed: false, next } as const;
        }),
      ).pipe(Effect.orDie);
      if (judged.confirmed) yield* settledSession;
      outcome.until(judged.next);
      return engineShows ? "deferred" : "done";
    });

    /**
     * Step 2 to 4 for one session: settle, send, observe. Each round not sent
     * yet goes once its own backoff passed; one that waits, or whose send
     * could not finish now, holds back no other.
     */
    const advance = Effect.fn("Stops.advance")(function* (
      rounds: ReadonlyArray<Round>,
      outcome: Outcome,
    ) {
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
      const now = yield* DateTime.now;
      let sending: Progress = "done";
      for (const round of rounds) {
        if (round.sent) continue;
        if (round.due_at !== null && DateTime.isGreaterThan(round.due_at, now)) {
          outcome.until(round.due_at);
          continue;
        }
        const progress = yield* sendRound(round, engineSessionId);
        if (progress === "unavailable") return progress;
        if (progress === "deferred") sending = progress;
      }
      // A round whose send did not finish leaves its target unconfirmable:
      // the session is observed once it went out.
      if (sending === "deferred") return sending;
      return yield* observe(first.session_id, engineSessionId, outcome);
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
    const supervised = (sessionId: SessionRowId, rounds: ReadonlyArray<Round>, outcome: Outcome) =>
      advance(rounds, outcome).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("A Stop round failed; it is tried again later", cause).pipe(
              Effect.andThen(retryLater(sessionId)),
              Effect.map((at): Progress => {
                outcome.until(at);
                return "done";
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
      // Each bot that had work addressed to the room: its room Stop selects
      // what is still in scope. When nothing is, it records no Stop, and still
      // cancels the bot's pending wakes in scope and fires the Stop signal.
      const working = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ bot_id: BotId }),
        execute: () => sql`
          SELECT bot_id FROM dispatches WHERE audience = 'room' AND audience_room_id = ${roomId}
          UNION
          SELECT s.bot_id FROM turns t JOIN sessions s ON s.id = t.session_id
          WHERE t.audience = 'room' AND t.audience_room_id = ${roomId}
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
