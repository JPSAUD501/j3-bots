// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandId,
  type Conflict,
  EntryId,
  NotFound,
  RoomId,
} from "@j3-bots/contracts";
import { Engine, IdempotencyKey, SessionId, TurnId } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import { BotStore } from "../bots/BotStore.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { RoomWork } from "../rooms/RoomWork.ts";
import { Ledger } from "./Ledger.ts";
import {
  type Audience,
  AudienceColumn,
  DispatchRowId,
  DispatchSeq,
  ROOM_ROUND_HOLD_BOUND,
  SessionRowId,
} from "./model.ts";
import { Observer, type Synchronized } from "./Observer.ts";
import { behindOpeningSql } from "./openings.ts";
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
 * waits on instead of being cancelled, and so do the operator's messages held
 * behind an opening that has not ended (`behindOpeningSql`,
 * `Pipeline.sendMessage`). A change of provider stops the work in progress but
 * not the hello a new bot has yet to send, nor what the operator wrote while
 * it waited. Once the opening has ended, those messages are ordinary work, and
 * the Stop cancels them as it does any other.
 */
interface StopOptions {
  readonly keepOpening: boolean;
}

const Round = Schema.Struct({
  stop_id: Schema.String,
  /** The room a `room` Stop is for; null for a `bot` Stop. */
  room_id: Schema.NullOr(RoomId),
  /** The one turn a Stop the server recorded for it ends (`endTurn`); null for any other. */
  engine_turn_id: Schema.NullOr(TurnId),
  session_id: SessionRowId,
  round: Schema.Int,
  engine_key: IdempotencyKey,
  sent: Schema.BooleanFromBit,
  engine_session_id: Schema.NullOr(SessionId),
  due_at: Schema.NullOr(Time),
  retry_at: Schema.NullOr(Time),
});
type Round = typeof Round.Type;

/**
 * A Stop that ends only some of its target session's work: a room's, its
 * work for the room; a turn's, that turn and the background work it started.
 */
type Narrow =
  | { readonly _tag: "room"; readonly roomId: RoomId }
  | { readonly _tag: "turn"; readonly turnId: TurnId };

const narrowOf = (round: Round): Narrow | null => {
  if (round.engine_turn_id !== null) return { _tag: "turn", turnId: round.engine_turn_id };
  if (round.room_id !== null) return { _tag: "room", roomId: round.room_id };
  return null;
};

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

/**
 * Whether a round goes, as judged in the session's gate: `send`; `held`, done
 * for now; `refresh`, for a later pass's fresh report; or `settled` unsent.
 */
type Verdict = "held" | "refresh" | "settled" | "send";

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
    /**
     * Records, in the caller's transaction, a Stop of one turn while it runs:
     * the turn and the background work it started, in its session, and
     * nothing else (`docs/architecture/server.md`, Stop). The server's own,
     * for a turn whose request for help in the bot's browser closed it: it
     * covers no work and cancels no wake, and the turn's end is not a failure
     * (`stopTargets.endedOnRequest`). A turn that already ended needs none.
     */
    readonly endTurn: (
      botId: BotId,
      turn: {
        readonly sessionId: SessionRowId;
        readonly turnId: TurnId;
        readonly audience: Audience;
      },
    ) => Effect.Effect<void>;
    /** `bot.stop`. */
    readonly stopBot: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /**
     * One pass of the runner over every unsettled target, and every session
     * whose background work is due a check.
     */
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
    const changes = yield* ChangeLog;
    const targets = stopTargets(sql);
    const { sessionLost } = sessionLoss(sql, yield* Entries, ledger, yield* WorkSteps, signals);

    /** Whether an audience column pair is in a Stop's scope. */
    const inScope = (scope: StopScope) =>
      scope._tag === "bot"
        ? sql`1`
        : sql`(audience = 'room' AND audience_room_id = ${scope.roomId})`;

    /**
     * Confirms the session's targets (`stopTargets.confirm`); once one is, the
     * roster is told about its bot, whose rooms' work may have ended with the
     * Stop (`RoomStates`).
     */
    const botOfSession = SqlSchema.findOneOption({
      Request: SessionRowId,
      Result: Schema.Struct({ bot_id: BotId }),
      execute: (sessionId) => sql`SELECT bot_id FROM sessions WHERE id = ${sessionId}`,
    });
    const confirm = Effect.fn("Stops.confirm")(function* (sessionId: SessionRowId) {
      if (!(yield* targets.confirm(sessionId))) return false;
      const session = yield* botOfSession(sessionId).pipe(Effect.orDie);
      if (Option.isSome(session)) {
        yield* changes.touch({ _tag: "bot", botId: session.value.bot_id });
      }
      return true;
    });

    /** Whether a wake column set is the bot's opening (`StopOptions`). */
    const opening = sql`json_extract(payload_json, '$._tag') = 'first-run'`;

    /**
     * Fences the dispatches `fenceable` selects with the Stop, in the
     * caller's transaction. An undecided one the engine may have goes to the
     * recovery; one never sent is released, its wakes cancelled when the Stop
     * covers them and pending again when they were other work, or an opening
     * `keepOpening` keeps.
     */
    const fence = Effect.fn("Stops.fence")(function* (
      stopId: string,
      at: string,
      fenceable: Statement.Fragment,
      keepOpening: boolean,
    ) {
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
            keepOpening &&
            (yield* sql`
            SELECT 1 FROM wakes WHERE dispatch_id = ${dispatch.id} AND ${opening}
          `).length > 0;
          yield* ledger.release(
            dispatch.id,
            kept ? { _tag: "pending" } : yield* targets.wakesAfter(dispatch, { _tag: "unsent" }),
          );
        }
      }
    });

    const record = Effect.fn("Stops.record")(function* (
      botId: BotId,
      scope: StopScope,
      options: StopOptions = { keepOpening: false },
    ) {
      const at = timeText(yield* DateTime.now);
      const landing = mayLand(sql);
      // Every session of the bot with work in scope that may be in the engine:
      // a turn running, a turn whose background work the engine last
      // reported still pending, or a dispatch the engine has or may yet take.
      // So a room's Stop reaches the background work its turns started, by
      // the turn that started it, never by the session's work as a whole. A
      // bot Stop reaches every live session too, for background work the
      // server does not see. A session the engine retired has nothing left in
      // it to stop: its retirement ended what ran there.
      const sessions = yield* sql<{ readonly id: string }>`
        SELECT s.id FROM sessions s
        WHERE s.bot_id = ${botId} AND s.lost_at IS NULL AND s.engine_retired_at IS NULL AND (
          ${scope._tag === "bot" ? sql`(s.retired_at IS NULL AND s.engine_session_id IS NOT NULL) OR` : sql``}
          EXISTS (
            SELECT 1 FROM turns WHERE session_id = s.id AND finished_at IS NULL AND ${inScope(scope)}
          )
          OR EXISTS (
            SELECT 1 FROM turns
            WHERE session_id = s.id AND background_pending = 1 AND ${inScope(scope)}
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
      // A room Stop is recorded even when none of the bot's work there is
      // live: it still covers what work the bot began before it would post
      // to the room, as a turn of its own conversation (`Wakes.record`,
      // `Speech.messageRoom`).
      if (sessionIds.length > 0 || (anyFenceable?.n ?? 0) > 0 || scope._tag === "room") {
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
        // dispatch began, which the dispatch mark cannot tell. So is what
        // those turns sent their teammates, and only that: a message from
        // work that had ended was that work's result, and one an earlier
        // Stop covered stays that Stop's. What such a message has not
        // delivered yet is cancelled here, and wherever it would wait again
        // (`Ledger`); the operator's Retry of one is the operator's word,
        // also once the recipient's Stop held it.
        if (sessionIds.length > 0) {
          yield* sql`
            UPDATE turns SET stop_id = ${stopId}
            WHERE finished_at IS NULL AND ${sql.in("session_id", sessionIds)} AND ${inScope(scope)}
          `;
          yield* sql`
            UPDATE handoffs SET stop_id = ${stopId}
            WHERE stop_id IS NULL AND tool_call_id IN (
              SELECT c.id FROM tool_calls c JOIN turns t
                ON t.session_id = c.session_id AND t.engine_turn_id = c.engine_turn_id
              WHERE t.stop_id = ${stopId}
            )
          `;
          const unsent = yield* sql<{ readonly id: string }>`
            SELECT w.id FROM wakes w JOIN handoffs h ON h.received_entry_id = w.source_entry_id
            WHERE w.status = 'pending' AND w.kind = 'bot' AND w.retry_of IS NULL
              AND h.stop_id = ${stopId}
          `;
          yield* ledger.cancelWakes(unsent.map((wake) => wake.id));
          const held = yield* sql<{ readonly handoff_entry_id: string }>`
            DELETE FROM held_messages
            WHERE consumed_dispatch_id IS NULL AND retried = 0 AND handoff_entry_id IN (
              SELECT received_entry_id FROM handoffs WHERE stop_id = ${stopId}
            )
            RETURNING handoff_entry_id
          `;
          yield* ledger.heldRemoved(
            held.map((row) => EntryId.make(row.handoff_entry_id)),
            "stopped",
          );
        }
        yield* fence(stopId, at, fenceable, options.keepOpening);
      }
      // A teammate's urgent message among them waits on as a held one: the
      // Stop ends this bot's work, not what its teammates told it (`Ledger`).
      const pending = yield* sql<{ readonly id: string; readonly kind: string }>`
        SELECT id, kind FROM wakes
        WHERE bot_id = ${botId} AND status = 'pending' AND ${inScope(scope)}
          ${options.keepOpening ? sql`AND NOT (${opening}) AND NOT ${behindOpeningSql(sql, "wakes")}` : sql``}
      `;
      yield* ledger.cancelWakes(pending.map((wake) => wake.id));
      yield* sql.afterCommit(signals.stops.fire);
      // A routine run whose attempt waited is settled now, and its side
      // session retired.
      if (pending.some((wake) => wake.kind === "routine")) {
        yield* sql.afterCommit(signals.routines.fire);
      }
    }, Effect.orDie);

    const endTurn = Effect.fn("Stops.endTurn")(function* (
      botId: BotId,
      turn: {
        readonly sessionId: SessionRowId;
        readonly turnId: TurnId;
        readonly audience: Audience;
      },
    ) {
      const [running] = yield* sql`
        SELECT 1 FROM turns
        WHERE session_id = ${turn.sessionId} AND engine_turn_id = ${turn.turnId}
          AND finished_at IS NULL
      `;
      if (running === undefined) return;
      const at = timeText(yield* DateTime.now);
      const stopId = yield* ids.make("stop");
      const roomId = turn.audience._tag === "room" ? turn.audience.roomId : null;
      yield* sql`
        INSERT INTO stops (id, bot_id, scope, room_id, created_at, dispatch_mark, engine_turn_id)
        VALUES (
          ${stopId}, ${botId}, ${roomId === null ? "bot" : "room"}, ${roomId}, ${at},
          (SELECT COALESCE(MAX(seq), 0) FROM dispatches), ${turn.turnId}
        )
      `;
      yield* sql`
        INSERT INTO stop_targets (stop_id, session_id, round, engine_key)
        VALUES (${stopId}, ${turn.sessionId}, 0, ${stopKey(stopId, turn.sessionId, 0)})
      `;
      // The engine's stop ends the whole session, so nothing undecided goes
      // into it meanwhile; work that never went waits again, since this Stop
      // covers none.
      yield* fence(
        stopId,
        at,
        sql`
          session_id = ${turn.sessionId} AND (status = 'intended' OR ${mayLand(sql)})
            AND fenced_by_stop_id IS NULL
        `,
        false,
      );
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
        SELECT t.stop_id, p.room_id, p.engine_turn_id, t.session_id, t.round, t.engine_key,
          t.sent_at IS NOT NULL AS sent, s.engine_session_id, t.due_at, t.retry_at
        FROM stop_targets t JOIN sessions s ON s.id = t.session_id
        JOIN stops p ON p.id = t.stop_id
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
     * Whether the session's queue is held, as far as the events show: the
     * engine starts no turn waiting in it until the server resumes it.
     */
    const queueHeld = (sessionId: SessionRowId) => sql`
      EXISTS (
        SELECT 1 FROM sessions qh_session
        WHERE qh_session.id = ${sessionId} AND qh_session.queue_held_cursor IS NOT NULL
          AND qh_session.queue_held_cursor IS NOT qh_session.queue_resumed_cursor
      )
    `;

    /**
     * Whether a row of `turns` or `dispatches`, by its alias, is the narrow
     * Stop's own work: for a room's, its audience is the room; for a turn's,
     * it is that turn, or a dispatch it delivers.
     */
    const own = (narrow: Narrow, alias: string) => {
      const row = sql.literal(alias);
      return narrow._tag === "room"
        ? sql`(${row}.audience = 'room' AND ${row}.audience_room_id = ${narrow.roomId})`
        : sql`(${row}.engine_turn_id = ${narrow.turnId})`;
    };

    /**
     * Whether the session runs a turn other than the narrow Stop's own work,
     * as far as the events show. Its round is not sent then, since the
     * engine's stop would end that work too: it waits for that turn, which
     * ends on its own, and whose end nudges the runner.
     */
    const runsOtherWork = (sessionId: SessionRowId, narrow: Narrow) =>
      sql<{ readonly n: number }>`
        SELECT 1 AS n FROM turns oa_turn
        WHERE oa_turn.session_id = ${sessionId} AND oa_turn.finished_at IS NULL
          AND NOT ${own(narrow, "oa_turn")}
        LIMIT 1
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /**
     * Whether the dispatch, of other work, cannot start its turn as far as
     * the server sees: the engine did not answer it as started, and the
     * Stop's own turn runs ahead of it, or the engine holds the queue, as it
     * does with a steer requeued behind a turn that failed. The Stop's round
     * then cancels it with its own work.
     */
    const waitsBehind = (sessionId: SessionRowId, narrow: Narrow, dispatch: Statement.Fragment) =>
      sql`(
        NOT (
          ${dispatch}.disposition IS 'started'
          AND ${dispatch}.engine_turn_id = ${dispatch}.disposition_turn_id
        )
        AND (
          EXISTS (
            SELECT 1 FROM turns wb_own
            WHERE wb_own.session_id = ${sessionId} AND wb_own.finished_at IS NULL
              AND ${own(narrow, "wb_own")}
          )
          OR ${queueHeld(sessionId)}
        )
      )`;

    /**
     * Whether the session has a dispatch of other work than the narrow
     * Stop's that the engine took and whose turn has not ended as far as the
     * events show: it may be starting, or running unseen. So does the
     * operator's steer until its settlement arrives, which the engine sends
     * after the end of the turn it steered: taken, dropped, or requeued as a
     * follow-up turn. Except a dispatch whose turn the events have not shown
     * start while it cannot start (`waitsBehind`). The turn's start or end,
     * and the dispatch's settling, nudge the runner.
     */
    const awaitsOtherWork = (sessionId: SessionRowId, narrow: Narrow) =>
      sql<{ readonly n: number }>`
        SELECT 1 AS n FROM dispatches oa_dispatch
        WHERE oa_dispatch.session_id = ${sessionId} AND oa_dispatch.status = 'accepted'
          AND NOT ${own(narrow, "oa_dispatch")}
          AND NOT (
            EXISTS (
              SELECT 1 FROM turns oa_ended
              WHERE oa_ended.session_id = ${sessionId}
                AND oa_ended.engine_turn_id = oa_dispatch.engine_turn_id
                AND oa_ended.finished_at IS NOT NULL
            )
            AND NOT (
              oa_dispatch.disposition IS 'steered'
              AND oa_dispatch.engine_turn_id = oa_dispatch.disposition_turn_id
            )
          )
          AND NOT (
            oa_dispatch.engine_turn_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM turns oa_seen
              WHERE oa_seen.session_id = ${sessionId}
                AND oa_seen.engine_turn_id = oa_dispatch.engine_turn_id
            )
            AND ${waitsBehind(sessionId, narrow, sql.literal("oa_dispatch"))}
          )
        LIMIT 1
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /**
     * A narrow Stop's round held back only by work the server cannot see
     * run, which holds it at most `ROOM_ROUND_HOLD_BOUND` from when it first
     * did, as stored on the round: `held` until then, with the runner due
     * back at the bound, and `overdue` after. An overdue round goes as a bot
     * Stop's would while its own work still runs or is flagged
     * (`judgeNarrowRound`),
     * and what it ends fails `stopped`, which the operator can retry.
     */
    const unseenHold = Effect.fn("Stops.unseenHold")(function* (round: Round, outcome: Outcome) {
      const now = yield* DateTime.now;
      const [row] = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ held_since: Time }),
        execute: () => sql`
          UPDATE stop_targets SET held_since = COALESCE(held_since, ${timeText(now)})
          WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
            AND round = ${round.round}
          RETURNING held_since
        `,
      })(undefined);
      const bound = DateTime.addDuration(row?.held_since ?? now, ROOM_ROUND_HOLD_BOUND);
      if (DateTime.isLessThan(now, bound)) {
        outcome.until(bound);
        return "held" as const;
      }
      yield* Effect.logWarning(
        "A room's Stop round waited its bound on work it cannot see run; it goes now",
      ).pipe(Effect.annotateLogs({ stopId: round.stop_id, sessionId: round.session_id }));
      return "overdue" as const;
    }, Effect.orDie);

    /**
     * What holds a narrow Stop's round back: `held` while a dispatch's answer
     * is not known yet or a turn of other work runs, which end on their own,
     * and for a bounded time while only work the server cannot see run does
     * (`unseenHold`); `free` when nothing does. The bound counts again from
     * the next time unseen work alone holds the round once a turn of other
     * work was admitted (`stopTargets.admitted`).
     */
    const narrowRoundHold = Effect.fn("Stops.narrowRoundHold")(function* (
      round: Round,
      narrow: Narrow,
      outcome: Outcome,
    ) {
      if (yield* inFlight(round.session_id)) return "held" as const;
      if (yield* runsOtherWork(round.session_id, narrow)) return "held" as const;
      if (yield* awaitsOtherWork(round.session_id, narrow)) {
        return yield* unseenHold(round, outcome);
      }
      return "free" as const;
    });

    /**
     * What of the narrow Stop's own work the session's applied events still
     * show: `running`, a turn of it not finished or a dispatch of it the
     * engine has or may be taking; `flagged`, a turn of it whose background
     * work the engine last reported pending. A dispatch whose recovery gave
     * up counts as neither: its fence reopens the Stop if its key lands
     * (`stopTargets.openRound`).
     */
    const ownWork = (sessionId: SessionRowId, narrow: Narrow) =>
      SqlSchema.findOne({
        Request: Schema.Void,
        Result: Schema.Struct({ running: Schema.BooleanFromBit, flagged: Schema.BooleanFromBit }),
        execute: () => sql`
          SELECT
            EXISTS (
              SELECT 1 FROM turns ow_turn WHERE ow_turn.session_id = ${sessionId}
                AND ow_turn.finished_at IS NULL AND ${own(narrow, "ow_turn")}
            ) OR EXISTS (
              SELECT 1 FROM dispatches ow_dispatch WHERE ow_dispatch.session_id = ${sessionId}
                AND ${own(narrow, "ow_dispatch")}
                AND (
                  ow_dispatch.status IN ('accepted', 'delivered')
                  OR (ow_dispatch.status = 'intended' AND ow_dispatch.attempts > 0)
                )
            ) AS running,
            EXISTS (
              SELECT 1 FROM turns ow_flagged WHERE ow_flagged.session_id = ${sessionId}
                AND ow_flagged.background_pending = 1 AND ${own(narrow, "ow_flagged")}
            ) AS flagged
        `,
      })(undefined).pipe(Effect.orDie);

    /**
     * Whose the turns the engine's report lists as runnable are, by the
     * server's rows: its turns, and the dispatches that name a turn
     * (`engine_turn_id`), admitted or not. `own`: one is the narrow Stop's
     * own work, which the round ends with the rest of it, and which may be an
     * active run, while the engine lists no background work. `unseen`: one
     * may start or run for other work with no event telling of it, which a
     * round would interrupt: one no dispatch of the Stop's own work names,
     * unless a dispatch of other work names it whose turn cannot start
     * (`waitsBehind`), which the round cancels. An engine-queued run no
     * dispatch names, such as the wake of a background command, is unseen
     * also behind a held queue: the turn whose work it reports may be the
     * Stop's own.
     */
    const runnableOf = Effect.fn("Stops.runnableOf")(function* (
      sessionId: SessionRowId,
      narrow: Narrow,
      runnable: ReadonlyArray<TurnId>,
    ) {
      if (runnable.length === 0) return { own: false, unseen: false };
      const turns = yield* sql<{ readonly engine_turn_id: string; readonly own: number }>`
        SELECT ro_turn.engine_turn_id, ${own(narrow, "ro_turn")} AS own
        FROM turns ro_turn
        WHERE ro_turn.session_id = ${sessionId} AND ${sql.in("ro_turn.engine_turn_id", runnable)}
      `;
      const named = yield* sql<{
        readonly engine_turn_id: string;
        readonly own: number;
        readonly waits: number;
      }>`
        SELECT ro_dispatch.engine_turn_id, ${own(narrow, "ro_dispatch")} AS own,
          ${waitsBehind(sessionId, narrow, sql.literal("ro_dispatch"))} AS waits
        FROM dispatches ro_dispatch
        WHERE ro_dispatch.session_id = ${sessionId}
          AND ${sql.in("ro_dispatch.engine_turn_id", runnable)}
      `;
      const seen = new Map(turns.map((row) => [row.engine_turn_id, row.own === 1]));
      const whose = runnable.map((turnId) => {
        const isOwn = seen.get(turnId);
        // A turn of other work the events show running holds the round
        // before this (`narrowRoundHold`): one listed here no longer runs as
        // far as they show, and may still, unseen.
        if (isOwn !== undefined) return isOwn ? "own" : "unseen";
        const naming = named.filter((row) => row.engine_turn_id === turnId);
        if (naming.some((row) => row.own === 1)) return "own";
        return naming.length > 0 && naming.every((row) => row.waits === 1) ? "waits" : "unseen";
      });
      return { own: whose.includes("own"), unseen: whose.includes("unseen") };
    }, Effect.orDie);

    /** Whether the engine's report lists background work the narrow Stop's own turns started. */
    const listsOwnWork = Effect.fn("Stops.listsOwnWork")(function* (
      sessionId: SessionRowId,
      narrow: Narrow,
      listed: ReadonlyArray<TurnId>,
    ) {
      if (listed.length === 0) return false;
      const rows = yield* sql`
        SELECT 1 FROM turns lo_turn
        WHERE lo_turn.session_id = ${sessionId} AND ${own(narrow, "lo_turn")}
          AND ${sql.in("lo_turn.engine_turn_id", listed)}
        LIMIT 1
      `;
      return rows.length > 0;
    }, Effect.orDie);

    /**
     * A narrow Stop's target with nothing of its own work left in the
     * session settles without a round: its turns ended, and the engine's
     * latest report shows no background work they started. Dispatches its Stop fenced keep their
     * fence, so one that lands after all reopens it.
     */
    const settleUnsent = Effect.fn("Stops.settleUnsent")(function* (round: Round) {
      yield* sql`
        UPDATE stop_targets SET stopped_at = ${timeText(yield* DateTime.now)}
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND stopped_at IS NULL
      `;
      // The roster shows the room's work as it is once its Stop settled (`RoomStates`).
      if (round.room_id !== null) yield* changes.touch({ _tag: "room", roomId: round.room_id });
    }, Effect.orDie);

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
     * What a `synchronize`'s failure means for one session's Stop work: a
     * catch-up that could not reach the engine is this session's alone, and
     * the pass goes on with the others, as for an observation.
     */
    const syncDownProgress = {
      ...downProgress,
      EngineUnavailable: () => Effect.succeed<Progress>("deferred"),
    };

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

    /** Issues the round and sends its commands, inside the gate. */
    const sendJudged = (round: Round, engineSessionId: SessionId) =>
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
      );

    /**
     * The one decision for a narrow Stop's round, a room's or a turn's, in
     * the session's gate, where a send into the session is claimed, on a
     * report of the engine's taken this pass (`report`): `held` while other
     * work holds it (`narrowRoundHold`); `settled` once nothing of its own
     * work is left there; `refresh`, for the next pass and its fresh report,
     * while, within the bound, the report lists a runnable turn that may
     * start or run unseen (`runnableOf`); and `send` while its own work runs,
     * the report lists a runnable turn of its own or the background work its
     * own turns started, or the round is overdue on its bound with its own
     * work flagged. A report whose runnable turns are none of its own and
     * none unseen leaves the background work it lists complete: one that
     * lists none of its own settles the round unsent.
     */
    const judgeNarrowRound = Effect.fn("Stops.judgeNarrowRound")(function* (
      round: Round,
      narrow: Narrow,
      report: Synchronized,
      outcome: Outcome,
    ): Effect.fn.Return<Verdict> {
      const hold = yield* narrowRoundHold(round, narrow, outcome);
      if (hold === "held") return "held";
      const left = yield* ownWork(round.session_id, narrow);
      if (left.running || left.flagged) {
        const runnable = yield* runnableOf(round.session_id, narrow, report.runnableTurns);
        let overdue = hold === "overdue";
        if (runnable.unseen && !overdue) {
          if ((yield* unseenHold(round, outcome)) === "held") return "refresh";
          overdue = true;
        }
        if (
          left.running ||
          runnable.own ||
          overdue ||
          (yield* listsOwnWork(round.session_id, narrow, report.backgroundWork.turns))
        ) {
          return "send";
        }
      }
      yield* transaction(settleUnsent(round)).pipe(Effect.orDie);
      return "settled";
    });

    /**
     * Sends one round's commands through the gate, which only acknowledges
     * them. The round is issued, durably, before the call. `judged` decides,
     * in the gate, whether it goes: always for a bot Stop's round, as
     * `judgeNarrowRound` decides for a room's or a turn's.
     */
    const sendRound = Effect.fn("Stops.sendRound")(function* (
      round: Round,
      engineSessionId: SessionId,
      judged: Effect.Effect<Verdict>,
    ) {
      return yield* gate.run(round.session_id)(
        Effect.gen(function* () {
          const verdict = yield* judged;
          if (verdict === "held") return "done" satisfies Progress;
          if (verdict === "refresh") return "deferred" satisfies Progress;
          if (verdict === "settled") {
            yield* settledSession;
            return "done" satisfies Progress;
          }
          return yield* sendJudged(round, engineSessionId);
        }),
      );
    });

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
            if (yield* confirm(sessionId)) return { confirmed: true, next: null } as const;
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
        const confirmed = yield* transaction(confirm(first.session_id)).pipe(Effect.orDie);
        if (confirmed) yield* settledSession;
        return "done" satisfies Progress;
      }
      yield* observer.watch(first.session_id);
      const now = yield* DateTime.now;
      let sending: Progress = "done";
      let report: Synchronized | null = null;
      for (const round of rounds) {
        if (round.sent) continue;
        if (round.due_at !== null && DateTime.isGreaterThan(round.due_at, now)) {
          outcome.until(round.due_at);
          continue;
        }
        // A room's or a turn's Stop waits rather than end other work: the
        // engine's stop ends the whole session. A turn of other work the
        // events show running holds it with no more asked. Otherwise its
        // round is judged on a report of the engine's taken this pass, one
        // for the session, asked for outside the gate, which no step holds
        // while it waits for events: the events alone may be stale, as when
        // the session's stream stalls. One that cannot be had now leaves the
        // round for a later pass; a session the engine no longer has is lost.
        let judged: Effect.Effect<Verdict> = Effect.succeed("send");
        const narrow = narrowOf(round);
        if (narrow !== null) {
          if (yield* runsOtherWork(round.session_id, narrow)) continue;
          if (report === null) {
            const refreshed = yield* observer.synchronize(round.session_id, engineSessionId).pipe(
              Effect.catchTags({
                SessionNotFound: () =>
                  transaction(sessionLost(round.session_id)).pipe(Effect.as<Progress>("done")),
                NotObserved: () => Effect.succeed<Progress>("deferred"),
                ...syncDownProgress,
              }),
            );
            if (refreshed === "deferred") {
              sending = refreshed;
              continue;
            }
            if (typeof refreshed === "string") return refreshed;
            report = refreshed;
          }
          judged = judgeNarrowRound(round, narrow, report, outcome);
        }
        const progress = yield* sendRound(round, engineSessionId, judged);
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

    /**
     * Sessions where a turn ended while turns of theirs had background work
     * flagged (`Observer`), with no report of the engine's since, and no turn
     * the events show running. Not one a Stop's target still holds, whose
     * runner asks for reports of its own, nor one whose queue the engine
     * holds, whose waiting turns keep any report from being the check: each
     * would be asked again every pass. The heartbeat finds it once neither
     * holds.
     */
    const backgroundDue = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: SessionRowId, engine_session_id: SessionId }),
      execute: () => sql`
        SELECT s.id, s.engine_session_id FROM sessions s
        WHERE s.background_check_due = 1 AND s.lost_at IS NULL AND s.engine_retired_at IS NULL
          AND s.engine_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM turns bd_turn
            WHERE bd_turn.session_id = s.id AND bd_turn.finished_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets bd_target
            WHERE bd_target.session_id = s.id AND bd_target.stopped_at IS NULL
          )
          AND NOT (
            s.queue_held_cursor IS NOT NULL AND s.queue_held_cursor IS NOT s.queue_resumed_cursor
          )
        ORDER BY s.rowid
      `,
    });

    /**
     * Asks the engine for the session's background work while no turn runs.
     * A report taken while nothing runs or waits, this one or another's,
     * makes the check due no more (`Observer`): it clears the flags of the
     * turns whose work it no longer lists. Any other leaves the check due, and
     * the end of a turn that ran or waited makes it due again. So a flag does not
     * outlive its work for long, whether or not a Stop ever looks at it. A
     * defect is logged, and the check waits for its next pass.
     */
    const checkBackground = Effect.fn("Stops.checkBackground")(
      function* (session: { readonly id: SessionRowId; readonly engine_session_id: SessionId }) {
        yield* observer.watch(session.id);
        if (!(yield* observer.ready(session.id))) return "deferred" satisfies Progress;
        return yield* observer.synchronize(session.id, session.engine_session_id).pipe(
          Effect.as<Progress>("done"),
          Effect.catchTags({
            SessionNotFound: () =>
              transaction(sessionLost(session.id)).pipe(Effect.as<Progress>("done")),
            NotObserved: () => Effect.succeed<Progress>("deferred"),
            ...syncDownProgress,
          }),
        );
      },
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.as(
            Effect.logError("A session's background work could not be checked", cause),
            "done" satisfies Progress,
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
        for (const session of yield* backgroundDue(undefined).pipe(Effect.orDie)) {
          const progress = yield* checkBackground(session);
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

    return Stops.of({ record, endTurn, stopBot, runPending, run });
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
    const signals = yield* Signals;

    /**
     * Each member of the room, and each bot that had work addressed to it,
     * gets a room Stop, which selects what is still in scope: its turns and
     * dispatches, and the background work its turns started. A member with
     * none gets one all the same: its mark covers what the member's work
     * begun before it, as a turn of its own conversation, would still post to
     * the room. Every wake still held for the room is cancelled.
     */
    const stop = Effect.fn("RoomWork.stop")(function* (roomId: RoomId) {
      const working = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ bot_id: BotId }),
        execute: () => sql`
          SELECT bot_id FROM room_members WHERE room_id = ${roomId}
          UNION
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
    }, Effect.orDie);

    /** Expires the open `ask` cards of the room, of the given bots or of all: no answer can reach them. */
    const expireAsks = Effect.fn("RoomWork.expireAsks")(function* (
      roomId: RoomId,
      botIds: ReadonlyArray<BotId> | null,
    ) {
      const open = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ entry_id: EntryId }),
        execute: () => sql`
          SELECT ea_card.entry_id FROM ask_cards ea_card
          JOIN entries ea_entry ON ea_entry.id = ea_card.entry_id
          WHERE ea_card.closed_at IS NULL AND ea_card.audience = 'room'
            AND ea_card.audience_room_id = ${roomId}
            ${botIds === null ? sql`` : sql`AND ${sql.in("ea_entry.author_bot_id", botIds)}`}
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

    const end = Effect.fn("RoomWork.end")(function* (roomId: RoomId) {
      yield* stop(roomId);
      yield* expireAsks(roomId, null);
    });

    const leave = Effect.fn("RoomWork.leave")(function* (
      roomId: RoomId,
      botIds: ReadonlyArray<BotId>,
    ) {
      if (botIds.length === 0) return;
      // Its room dispatches never sent go back with their wakes cancelled:
      // the engine has none of them, and a send would show the bot the room
      // it left.
      const unsent = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ id: DispatchRowId }),
        execute: () => sql`
          SELECT id FROM dispatches
          WHERE status = 'intended' AND attempts = 0 AND audience_room_id = ${roomId}
            AND ${sql.in("bot_id", botIds)}
        `,
      })(undefined);
      // The operator's messages they never received count them no more, as
      // for a deleted bot: every wake of theirs for the room not finished,
      // pending, in a dispatch never sent, or failed, is marked before the
      // wakes are cancelled, which shows those messages.
      const unsentIds = unsent.map((row) => row.id);
      const inUnsent = unsentIds.length > 0 ? sql.in("dispatch_id", unsentIds) : sql`0`;
      const marked = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ source_entry_id: Schema.NullOr(EntryId) }),
        execute: () => sql`
          UPDATE wakes SET recipient_left = 1
          WHERE audience_room_id = ${roomId} AND ${sql.in("bot_id", botIds)}
            AND recipient_left = 0
            AND (
              status IN ('pending', 'failed') OR (status = 'dispatched' AND ${inUnsent})
            )
          RETURNING source_entry_id
        `,
      })(undefined);
      for (const id of unsentIds) yield* ledger.release(id, { _tag: "cancelled" });
      const pending = yield* sql<{ readonly id: string }>`
        SELECT id FROM wakes
        WHERE status = 'pending' AND audience = 'room' AND audience_room_id = ${roomId}
          AND ${sql.in("bot_id", botIds)}
      `;
      yield* ledger.cancelWakes(pending.map((wake) => wake.id));
      // A failed wake keeps its status: its message shows the other
      // recipients' delivery now.
      yield* ledger.refreshMessages(
        marked.flatMap((row) => (row.source_entry_id === null ? [] : [row.source_entry_id])),
      );
      // The room's notices of their turns offer no Retry: they have nothing
      // there to run again. Their questions for the room can no longer be
      // answered there.
      const offered = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ entry_id: EntryId }),
        execute: () => sql`
          SELECT lv_retry.entry_id FROM notice_retries lv_retry
          JOIN dispatches lv_dispatch ON lv_dispatch.id = lv_retry.dispatch_id
          WHERE lv_dispatch.audience_room_id = ${roomId} AND ${sql.in("lv_dispatch.bot_id", botIds)}
        `,
      })(undefined);
      for (const { entry_id } of offered) {
        const found = yield* entries.find(entry_id);
        if (Option.isSome(found) && found.value.entry._tag === "notice") {
          const notice = found.value.entry;
          if (notice.retryable) yield* entries.update({ ...notice, retryable: false });
        }
      }
      yield* expireAsks(roomId, botIds);
      // What they still run for the room is stopped, as the room's Stop
      // stops it: a turn running there, and the background work their room
      // turns started. Their speech there is refused meanwhile
      // (`liveTarget`).
      for (const botId of botIds) yield* stops.record(botId, { _tag: "room", roomId });
      // A session whose room start was released unsent can take the bot's
      // other wakes, which waited behind it.
      if (unsentIds.length > 0) {
        yield* sql.afterCommit(signals.dispatch.fire);
      }
    }, Effect.orDie);

    return RoomWork.of({ end, stop, leave });
  }),
);
