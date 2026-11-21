// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type Entry, EntryId, RoomId, WorkStep } from "@j3-bots/contracts";
import {
  type BackgroundWork,
  Engine,
  type EngineDown,
  type EngineIncompatible,
  type EngineRequest,
  EventCursor,
  type IdempotencyKey,
  type OpenRequest,
  type PendingContinuation,
  RequestId,
  type RequestResolution,
  type SessionEvent,
  SessionId,
  type SessionNotFound,
  SyncToken,
  type ToolCall,
  type TurnCause,
  TurnId,
  TurnOutcome,
} from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { type EntryDraft, Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { liveTarget as liveTargetOf } from "./liveTarget.ts";
import { DISPATCH_COLUMNS, DispatchRow, dispatchOfKey, Ledger, type WakeRow } from "./Ledger.ts";
import {
  type Audience,
  AudienceColumn,
  audienceColumns,
  audienceOf,
  conversation,
  type DispatchRowId,
  NotObserved,
  SessionRowId,
  StoredResponse,
  SYNC_DEADLINE,
} from "./model.ts";
import { type NoticeRetry, notices } from "./notices.ts";
import { routineSpeech } from "./routineSpeech.ts";
import { endingOf, sessionLoss, sessionRecords } from "./sessionRecords.ts";
import { rotationRequests } from "./rotationRequests.ts";
import { Signals } from "./Signals.ts";
import { stopTargets } from "./stopTargets.ts";
import { Wakes } from "./Wakes.ts";
import { WorkSteps } from "./WorkSteps.ts";

const Watched = Schema.Struct({
  id: SessionRowId,
  bot_id: BotId,
  /** A side session runs one attempt of a routine run, out of the operator's sight. */
  purpose: Schema.Literals(["main", "side"]),
  engine_session_id: SessionId,
  events_cursor: Schema.NullOr(EventCursor),
});
type Watched = typeof Watched.Type;

const TurnRow = Schema.Struct({
  engine_turn_id: TurnId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  finished_at: Schema.NullOr(Time),
  outcome_json: Schema.NullOr(json(TurnOutcome)),
  work_fold_entry_id: Schema.NullOr(EntryId),
});
type TurnRow = typeof TurnRow.Type;

const TurnKey = Schema.Struct({ sessionId: SessionRowId, turnId: TurnId });

const RequestRow = Schema.Struct({
  entry_id: EntryId,
  engine_request_id: RequestId,
  closed_at: Schema.NullOr(Time),
  response_json: Schema.NullOr(json(StoredResponse)),
});

const encodeStep = Schema.encodeEffect(json(WorkStep));
const encodeOutcome = Schema.encodeEffect(json(TurnOutcome));

/** The longest message an entry holds; host speech past it is cut. */
const MESSAGE_LIMIT = 100_000;

/** How long a stream that ended waits before it is opened again: doubling, up to a minute. */
const reopenAfter = (failures: number) =>
  Duration.min(Duration.seconds(2 ** Math.min(failures, 6)), Duration.minutes(1));

/**
 * A followed session: its stream is open once `opened` succeeds, its events
 * are known from a committed cursor once `caughtUp` does, and each
 * `synchronize` waits on its token. Every waiter fails, retryably, when the
 * stream closes.
 */
interface Following {
  readonly _tag: "open";
  readonly opened: Deferred.Deferred<void>;
  /** Completed by `close`: the stream ends, and is not opened again. */
  readonly closed: Deferred.Deferred<void>;
  readonly caughtUp: Deferred.Deferred<void, NotObserved>;
  readonly tokens: Map<SyncToken, Deferred.Deferred<Synchronized, NotObserved>>;
}

/** The session as a `synchronize` left it, beyond what its applied events say. */
export interface Synchronized {
  /**
   * Background work still runs, with no turn running: what a Stop of an idle
   * session interrupts, after it answered.
   */
  readonly backgroundWork: BackgroundWork;
  /**
   * Turns the engine can still run: waiting in its queue, or preparing,
   * starting or running, also ones no event has told of. A Stop sent before
   * one was created did not reach it.
   */
  readonly runnableTurns: ReadonlyArray<TurnId>;
}

/**
 * A session whose stream ended and waits out its backoff before it is opened
 * again: nothing opens it sooner, and it is not ready meanwhile.
 */
interface Reopening {
  readonly _tag: "reopening";
}

/**
 * The events that can change whether a session is idle or a Stop of it is
 * done: a turn's start or end, a dispatch settling, a replacement, a request
 * opening or closing. Only these nudge the dispatcher and the Stop runner.
 */
const changesWork = (event: SessionEvent): boolean => {
  switch (event._tag) {
    case "replaced":
    case "turn-started":
    case "turn-finished":
    case "steered":
    case "steer-dropped":
    case "steer-requeued":
    case "continuation-dropped":
    case "request-opened":
    case "request-closed":
      return true;
    case "turn-queued":
    case "request-updated":
    case "step":
    case "host-speech":
    case "tool-call":
    case "queue-held":
    case "synchronized":
      return false;
  }
};

const SessionNow = Schema.Struct({
  /** Lost, or archived by the engine once J3 Bots retired it: nothing of it is applied. */
  ended: Schema.BooleanFromBit,
  busy: Schema.BooleanFromBit,
});

/**
 * A card with its request's content as the engine now shows it, keeping the
 * card's id, place and status. Undefined when the request would make another
 * kind of card, which an engine request never becomes.
 */
const withContent = (card: Entry, draft: EntryDraft): Entry | undefined => {
  if (card._tag === "approval" && draft._tag === "approval")
    return { ...card, ...draft, status: card.status };
  if (card._tag === "question" && draft._tag === "question")
    return { ...card, ...draft, status: card.status };
  if (card._tag === "secret-request" && draft._tag === "secret-request")
    return { ...card, ...draft, status: card.status };
  return undefined;
};

/** A turn's end, as `turn-finished` and a replacement's ended turns tell it. */
interface TurnEnd {
  readonly turnId: TurnId;
  /**
   * Why it started, which settles the dispatch of a turn that never started
   * by its key. Unknown only for a turn the server held open that the engine
   * no longer lists.
   */
  readonly cause: TurnCause | null;
  readonly outcome: TurnOutcome;
  readonly backgroundWork: boolean;
  readonly continuation: PendingContinuation | null;
  /**
   * A replacement shows the turn that continued it: the engine no longer
   * lists the continuation as pending, but the chain went on.
   */
  readonly continued: boolean;
  /**
   * The engine could not resume the provider's conversation and ran the turn
   * in a fresh one: the session is due for rotation.
   */
  readonly contextRecovered: boolean;
  readonly at: DateTime.Utc;
}

/**
 * Applies each session's engine events (`docs/architecture/server.md`, 4. The
 * turn is observed, and admitted): the turn lifecycle and its dispatches, steer
 * settlements, work steps, host speech, the engine's requests as cards, held
 * queues and Stop confirmation. Every event is applied with its cursor in one
 * transaction, and applying one twice changes nothing, so a replay or a
 * replacement after a restart is harmless. All event handling lives here.
 */
export class Observer extends Context.Service<
  Observer,
  {
    /**
     * Follows the session's events from its stored cursor, unless they are
     * already followed. Returns once the stream is open, so a `synchronize`
     * after it is answered on that stream.
     */
    readonly watch: (sessionId: SessionRowId) => Effect.Effect<void>;
    /**
     * Whether the session's events are followed, known now from a committed
     * snapshot or cursor, and every event so far could be applied: nothing is
     * sent into a session before. It opens no stream and never waits; the
     * event that makes a session ready nudges the dispatcher.
     */
    readonly ready: (sessionId: SessionRowId) => Effect.Effect<boolean>;
    /** Follows every session that is live or still has work to settle. */
    readonly watchAll: Effect.Effect<void>;
    /**
     * Stops following a session the engine took out of use: its stream ends,
     * and nothing opens it again, since a session retired in the engine is no
     * longer one to watch.
     */
    readonly close: (sessionId: SessionRowId) => Effect.Effect<void>;
    /**
     * Returns once every event the engine had recorded for the session when it
     * was called has been applied. Fails with `NotObserved`, to be retried,
     * when the stream closes first or the deadline passes.
     */
    readonly synchronize: (
      sessionId: SessionRowId,
      engineSessionId: SessionId,
    ) => Effect.Effect<Synchronized, EngineDown | SessionNotFound | NotObserved>;
  }
>()("@j3-bots/server/turns/Observer") {}

export const layer = Layer.effect(
  Observer,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const engine = yield* Engine;
    const entries = yield* Entries;
    const ledger = yield* Ledger;
    const wakes = yield* Wakes;
    const signals = yield* Signals;
    const changes = yield* ChangeLog;
    const ids = yield* Ids;
    const workSteps = yield* WorkSteps;
    const scope = yield* Effect.scope;
    const stops = stopTargets(sql);
    const { notify } = notices(sql, entries);
    const spoken = routineSpeech(sql, ids, changes);
    const { sessionLost } = sessionLoss(sql, entries, ledger, workSteps, signals);
    const { requestRotation } = rotationRequests(sql, signals);
    const { finishFold, closeCard } = sessionRecords(sql, entries, workSteps);

    /**
     * Each followed session. The engine sends a `synchronized` only on the
     * streams open when it is asked, so a waiter starts after `opened`.
     */
    const following = new Map<SessionRowId, Following | Reopening>();
    /** Consecutive times a session's stream ended in failure, for its reopening backoff. */
    const failures = new Map<SessionRowId, number>();
    /**
     * Sessions with an event that could not be applied: what the server knows
     * of them is behind, so they are not ready until an event applies again.
     */
    const behind = new Set<SessionRowId>();
    /** Sessions whose failure shows a notice already, until an event applies again. */
    const shown = new Set<SessionRowId>();

    // ---- Reads ----------------------------------------------------------------

    const watchedRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Watched,
      execute: (id) => sql`
        SELECT id, bot_id, purpose, engine_session_id, events_cursor FROM sessions
        WHERE id = ${id} AND engine_session_id IS NOT NULL AND lost_at IS NULL
          AND engine_retired_at IS NULL
      `,
    });

    const sessionsToWatch = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: SessionRowId }),
      execute: () => sql`
        SELECT s.id FROM sessions s
        WHERE s.engine_session_id IS NOT NULL AND s.lost_at IS NULL
          AND s.engine_retired_at IS NULL AND (
          s.retired_at IS NULL
          OR EXISTS (SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL)
          OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.finished_at IS NULL)
        )
      `,
    });

    const turnRow = SqlSchema.findOneOption({
      Request: TurnKey,
      Result: TurnRow,
      execute: ({ sessionId, turnId }) => sql`
        SELECT engine_turn_id, audience, audience_room_id, finished_at, outcome_json,
          work_fold_entry_id
        FROM turns WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
      `,
    });
    const turnOf = (sessionId: SessionRowId, turnId: TurnId) =>
      turnRow({ sessionId, turnId }).pipe(Effect.orDie);

    const openTurnRows = SqlSchema.findAll({
      Request: SessionRowId,
      Result: TurnRow,
      execute: (sessionId) => sql`
        SELECT engine_turn_id, audience, audience_room_id, finished_at, outcome_json,
          work_fold_entry_id
        FROM turns WHERE session_id = ${sessionId} AND finished_at IS NULL
      `,
    });

    const sessionNow = SqlSchema.findOne({
      Request: SessionRowId,
      Result: SessionNow,
      execute: (sessionId) => sql`
        SELECT lost_at IS NOT NULL OR engine_retired_at IS NOT NULL AS ended,
          busy_until IS NOT NULL AS busy
        FROM sessions WHERE id = ${sessionId}
      `,
    });

    /** The dispatch whose turn this is: never a steer riding it. */
    const ownerRow = SqlSchema.findOneOption({
      Request: TurnKey,
      Result: DispatchRow,
      execute: ({ sessionId, turnId }) => sql`
        SELECT ${sql.literal(DISPATCH_COLUMNS)} FROM dispatches
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
          AND status IN ('intended', 'accepted', 'delivered', 'failed')
          AND NOT (delivery = 'steer' AND steer_turn_id = engine_turn_id)
      `,
    });

    /** The dispatch waiting for the pending continuation of a turn. */
    const awaitingOn = SqlSchema.findOneOption({
      Request: TurnKey,
      Result: DispatchRow,
      execute: ({ sessionId, turnId }) => sql`
        SELECT ${sql.literal(DISPATCH_COLUMNS)} FROM dispatches
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId} AND status = 'delivered'
          AND continuation_resumes_at IS NOT NULL
      `,
    });

    /**
     * One link of a continuation chain: the dispatch that waited on the turn
     * `turnId` continues moves to `turnId`. Followed when that turn starts, or
     * ends before it started, whichever is applied first.
     */
    const followLink = Effect.fn("Observer.followLink")(function* (
      sessionId: SessionRowId,
      turnId: TurnId,
      continued: TurnId,
    ) {
      const waiting = yield* awaitingOn({ sessionId, turnId: continued }).pipe(Effect.orDie);
      if (Option.isSome(waiting)) yield* ledger.followContinuation(waiting.value.id, turnId);
    });

    const awaitingRows = SqlSchema.findAll({
      Request: SessionRowId,
      Result: DispatchRow,
      execute: (sessionId) => sql`
        SELECT ${sql.literal(DISPATCH_COLUMNS)} FROM dispatches
        WHERE session_id = ${sessionId} AND status = 'delivered'
          AND continuation_resumes_at IS NOT NULL
      `,
    });

    /** The dispatch a key names, if it was sent into this session. */
    const keyed = Effect.fn("Observer.keyed")(function* (
      sessionId: SessionRowId,
      key: IdempotencyKey,
    ) {
      const found = yield* ledger.find(dispatchOfKey(key));
      return Option.filter(found, (row) => row.session_id === sessionId);
    });

    /** The dispatch a turn delivers: by its cause when known, else by the turn the engine named. */
    const ownerOf = Effect.fn("Observer.ownerOf")(function* (
      sessionId: SessionRowId,
      turnId: TurnId,
      cause: TurnCause | null,
    ) {
      if (cause?._tag === "dispatch") {
        const byKey = yield* keyed(sessionId, cause.key);
        if (Option.isSome(byKey)) return byKey;
      }
      return yield* ownerRow({ sessionId, turnId }).pipe(Effect.orDie);
    });

    const requestRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ sessionId: SessionRowId, requestId: RequestId }),
      Result: RequestRow,
      execute: ({ sessionId, requestId }) => sql`
        SELECT entry_id, engine_request_id, closed_at, response_json FROM engine_requests
        WHERE session_id = ${sessionId} AND engine_request_id = ${requestId}
      `,
    });

    const openRequestRows = SqlSchema.findAll({
      Request: Schema.Struct({ sessionId: SessionRowId, turnId: Schema.NullOr(TurnId) }),
      Result: RequestRow,
      execute: ({ sessionId, turnId }) => sql`
        SELECT entry_id, engine_request_id, closed_at, response_json FROM engine_requests
        WHERE session_id = ${sessionId} AND closed_at IS NULL
          ${turnId === null ? sql`` : sql`AND engine_turn_id = ${turnId}`}
      `,
    });

    const liveTarget = liveTargetOf(sql);

    // ---- Notices and work folds ---------------------------------------------------

    /**
     * What a retry of this turn's failure sends again: the operator's own
     * dispatch, whose turn (or the turn that followed it up) ran.
     */
    const retryOf = (
      dispatchId: DispatchRowId,
      carried: ReadonlyArray<WakeRow>,
    ): NoticeRetry | null => {
      if (carried.some((wake) => wake.kind === "user")) return { dispatchId, reason: "turn" };
      for (const wake of carried) {
        if (wake.payload_json._tag === "undelivered") {
          return { dispatchId: wake.payload_json.dispatchId, reason: "turn" };
        }
      }
      return null;
    };

    const foldStatus = (turn: TurnRow) =>
      turn.finished_at === null || turn.outcome_json === null
        ? ({ _tag: "running" } as const)
        : ({
            _tag: "finished",
            finishedAt: turn.finished_at,
            ending: endingOf(turn.outcome_json),
          } as const);

    /** The turn's work fold in the bot's conversation, written with its first step. */
    const foldOf = Effect.fn("Observer.foldOf")(function* (session: Watched, turn: TurnRow) {
      if (turn.work_fold_entry_id !== null) return turn.work_fold_entry_id;
      const entry = yield* entries.append({
        target: { _tag: "conversation", botId: session.bot_id },
        entry: {
          _tag: "work-fold",
          author: { _tag: "bot", botId: session.bot_id },
          stepCount: 0,
          status: foldStatus(turn),
        },
      });
      yield* sql`
        UPDATE turns SET work_fold_entry_id = ${entry.id}
        WHERE session_id = ${session.id} AND engine_turn_id = ${turn.engine_turn_id}
      `.pipe(Effect.orDie);
      return entry.id;
    });

    /** Something happened in a running turn: it is not stalled. */
    const touchActivity = (sessionId: SessionRowId, turnId: TurnId, at: DateTime.Utc) =>
      sql`
        UPDATE turns SET last_activity_at = MAX(last_activity_at, ${timeText(at)})
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId} AND finished_at IS NULL
      `.pipe(Effect.orDie, Effect.asVoid);

    // ---- The turn lifecycle -------------------------------------------------------

    const startTurn = Effect.fn("Observer.startTurn")(function* (
      session: Watched,
      turnId: TurnId,
      cause: TurnCause,
      at: DateTime.Utc,
    ) {
      if (Option.isSome(yield* turnOf(session.id, turnId))) return;
      let audience: Audience = conversation;
      let fencedBy: string | null = null;
      if (cause._tag === "dispatch") {
        const dispatch = yield* keyed(session.id, cause.key);
        if (Option.isSome(dispatch)) {
          audience = audienceOf(dispatch.value);
          fencedBy = dispatch.value.fenced_by_stop_id;
          yield* ledger.deliver(dispatch.value.id, turnId);
        }
      } else if (cause._tag === "continuation") {
        // One link of the chain: the dispatch and its audience move to this turn.
        const previous = yield* turnOf(session.id, cause.turnId);
        if (Option.isSome(previous)) audience = audienceOf(previous.value);
        yield* followLink(session.id, turnId, cause.turnId);
      }
      const columns = audienceColumns(audience);
      yield* sql`
        INSERT INTO turns (
          session_id, engine_turn_id, audience, audience_room_id, started_at, last_activity_at
        ) VALUES (
          ${session.id}, ${turnId}, ${columns.audience}, ${columns.roomId}, ${timeText(at)},
          ${timeText(at)}
        )
      `;
      // The turn's room may be gone: a deleted room's work keeps its id, which
      // the session's admitted audience, a reference to a room that exists,
      // does not take. Its speech reaches nobody either way.
      yield* sql`
        UPDATE sessions SET admitted_turn_id = ${turnId}, admitted_audience = ${columns.audience},
          admitted_room_id = (SELECT id FROM rooms WHERE id = ${columns.roomId})
        WHERE id = ${session.id}
      `;
      // A Stop round already sent missed this turn, or the engine applied a
      // key a Stop had fenced: it is stopped on sight.
      if (yield* stops.openRound(session.id, fencedBy)) yield* sql.afterCommit(signals.stops.fire);
    }, Effect.orDie);

    /** A dispatch the engine may yet take, or may have taken unseen. */
    const undecided = (row: DispatchRow) =>
      row.status === "intended" || row.status === "accepted" || row.status === "failed";

    /**
     * The engine has a turn it has not started, waiting behind another: the
     * dispatch it delivers is accepted, also one whose recovery gave up, so
     * its message is no longer offered to send again.
     *
     * Seen first here, the key may have landed after a Stop round's cancels,
     * held in the queue that Stop left: like a turn that starts after a round,
     * it opens the next round, which cancels it. Only the first sight does:
     * a replacement that lists it again finds it accepted.
     */
    const queuedTurn = Effect.fn("Observer.queuedTurn")(function* (
      session: Watched,
      turnId: TurnId,
      cause: TurnCause,
    ) {
      if (cause._tag !== "dispatch") return;
      const dispatch = yield* keyed(session.id, cause.key);
      if (Option.isNone(dispatch) || !undecided(dispatch.value)) return;
      yield* ledger.accept(dispatch.value.id, null);
      yield* sql`
        UPDATE dispatches SET engine_turn_id = COALESCE(engine_turn_id, ${turnId})
        WHERE id = ${dispatch.value.id}
      `;
      if (
        dispatch.value.status !== "accepted" &&
        (yield* stops.openRound(session.id, dispatch.value.fenced_by_stop_id))
      ) {
        yield* sql.afterCommit(signals.stops.fire);
      }
    }, Effect.orDie);

    /** The dispatch that owned a turn is over, with its last outcome. */
    const settle = Effect.fn("Observer.settle")(function* (
      session: Watched,
      dispatch: DispatchRow,
      outcome: TurnOutcome,
      backgroundWork: boolean,
    ) {
      const closedBy = dispatch.closed_by ?? (backgroundWork ? "handoff" : null);
      if (dispatch.closed_by === null && closedBy !== null) {
        yield* sql`UPDATE dispatches SET closed_by = ${closedBy} WHERE id = ${dispatch.id}`;
      }
      yield* ledger.finish(dispatch.id, outcome);
      const audience = audienceOf(dispatch);
      const carried = yield* ledger.wakesOf(dispatch.id);
      // A routine's attempt ends with its run (`routines/RoutineRuns.ts`): one
      // that failed is tried again, and the run's history shows it. Nobody
      // waits on it in the conversation.
      if (carried.some((wake) => wake.kind === "routine")) return;
      // What the operator stopped needs no notice and no follow-up, also when
      // the turn ended on its own before the Stop's interrupt reached it.
      if (yield* stops.covers(session.bot_id, audience, dispatch.seq)) return;
      // Interrupted, or a continuation cancelled before it started: the work
      // did not get to its end.
      if (outcome._tag !== "completed") {
        const failure = outcome._tag === "failed" ? outcome.failure : "unknown";
        yield* notify(
          session.bot_id,
          audience,
          { _tag: "turn-failed", failure },
          retryOf(dispatch.id, carried),
        );
        return;
      }
      if (closedBy !== null) return;
      if (carried.some((wake) => wake.kind === "user")) {
        yield* wakes.record([
          {
            botId: session.bot_id,
            kind: "system",
            audience,
            payload: { _tag: "undelivered", dispatchId: dispatch.id },
            sourceEntryId: null,
            hops: 0,
            retryOf: null,
            cause: { _tag: "work", seq: dispatch.seq },
          },
        ]);
        return;
      }
      const followed = retryOf(dispatch.id, carried);
      if (followed !== null) {
        yield* notify(session.bot_id, audience, { _tag: "undelivered" }, followed);
      }
    }, Effect.orDie);

    const finishTurn = Effect.fn("Observer.finishTurn")(function* (session: Watched, end: TurnEnd) {
      const turn = yield* turnOf(session.id, end.turnId);
      if (Option.isSome(turn) && turn.value.finished_at !== null) return;
      // A routine run's attempt may have ended: its run settles, or its session retires.
      if (session.purpose === "side") yield* sql.afterCommit(signals.routines.fire);
      if (Option.isSome(turn)) {
        yield* sql`
          UPDATE turns SET finished_at = ${timeText(end.at)},
            outcome_json = ${yield* encodeOutcome(end.outcome)}
          WHERE session_id = ${session.id} AND engine_turn_id = ${end.turnId}
        `;
        if (turn.value.work_fold_entry_id !== null) {
          yield* finishFold(turn.value.work_fold_entry_id, end.outcome, end.at);
        }
      }
      // The provider's conversation could not be resumed: the bot's main
      // session is replaced once it is idle, with a digest of its own. Any
      // turn's end may also have made a session due for rotation idle, or
      // brought it to its run limit.
      if (end.contextRecovered) {
        yield* requestRotation(session.id, "context-recovered");
      }
      yield* sql.afterCommit(signals.rotations.fire);
      yield* sql`
        UPDATE sessions SET admitted_turn_id = NULL, admitted_audience = NULL,
          admitted_room_id = NULL
        WHERE id = ${session.id} AND admitted_turn_id = ${end.turnId}
      `;
      yield* sql`
        UPDATE engine_tool_calls SET open = 0
        WHERE session_id = ${session.id} AND engine_turn_id = ${end.turnId}
      `;
      // Every request still open on the turn expires with it.
      const open = yield* openRequestRows({ sessionId: session.id, turnId: end.turnId });
      for (const request of open)
        yield* closeRequest(session, request.engine_request_id, "expired");

      // A continuation that ended before it started still ends its chain's work.
      if (end.cause?._tag === "continuation") {
        yield* followLink(session.id, end.turnId, end.cause.turnId);
      }
      const owner = yield* ownerOf(session.id, end.turnId, end.cause);
      if (Option.isNone(owner)) return;
      const dispatch = owner.value;
      if (dispatch.status === "finished" || dispatch.status === "dropped") return;
      if (dispatch.status !== "delivered") {
        // It ended without starting: a Stop cancelled it while it waited, or it
        // failed before the provider took it, which the engine refused it with.
        yield* ledger.accept(dispatch.id, null);
        const after = yield* stops.wakesAfter(
          dispatch,
          end.outcome._tag === "cancelled"
            ? { _tag: "dropped" }
            : { _tag: "failed", reason: "rejected" },
        );
        yield* ledger.drop(dispatch.id, end.turnId, after);
        return;
      }
      if (end.continuation !== null) {
        yield* ledger.awaitContinuation(dispatch.id, end.outcome, end.continuation.resumesAt);
        return;
      }
      // The chain went on while the server was away: the link is followed
      // when the turn that continued it is applied, right after this one.
      if (end.continued) {
        yield* ledger.awaitContinuation(dispatch.id, end.outcome, end.at);
        return;
      }
      // A continuation cancelled before it started ran nothing: the work
      // ended as the turn it was to continue did, as when one is dropped.
      const ranNothing = end.cause?._tag === "continuation" && end.outcome._tag === "cancelled";
      const outcome = ranNothing ? (dispatch.outcome_json ?? end.outcome) : end.outcome;
      yield* settle(session, dispatch, outcome, end.backgroundWork);
    }, Effect.orDie);

    const continuationDropped = Effect.fn("Observer.continuationDropped")(function* (
      session: Watched,
      turnId: TurnId,
    ) {
      for (const dispatch of yield* awaitingRows(session.id)) {
        if (dispatch.engine_turn_id !== turnId) continue;
        yield* settle(session, dispatch, dispatch.outcome_json ?? { _tag: "interrupted" }, false);
      }
    }, Effect.orDie);

    // ---- Steers -------------------------------------------------------------------

    const steered = Effect.fn("Observer.steered")(function* (
      session: Watched,
      key: IdempotencyKey,
      turnId: TurnId,
    ) {
      const dispatch = yield* keyed(session.id, key);
      if (Option.isNone(dispatch) || !undecided(dispatch.value)) return;
      yield* ledger.deliver(dispatch.value.id, turnId);
      // A steer rides the turn it steered, which has ended: it finishes with it.
      const turn = yield* turnOf(session.id, turnId);
      const outcome = Option.flatMap(turn, (row) => Option.fromNullishOr(row.outcome_json));
      yield* ledger.finish(
        dispatch.value.id,
        Option.getOrElse(outcome, () => ({ _tag: "completed" }) as const),
      );
    });

    /**
     * Stop ended the turn the steer was to ride before it took it. The event
     * names that turn, so the dispatch settles even when the reply that would
     * have named it was lost.
     */
    const steerDropped = Effect.fn("Observer.steerDropped")(function* (
      session: Watched,
      key: IdempotencyKey,
      turnId: TurnId,
    ) {
      const dispatch = yield* keyed(session.id, key);
      if (Option.isNone(dispatch) || !undecided(dispatch.value)) return;
      yield* ledger.accept(dispatch.value.id, null);
      yield* ledger.drop(
        dispatch.value.id,
        turnId,
        yield* stops.wakesAfter(dispatch.value, { _tag: "dropped" }),
      );
    });

    const steerRequeued = Effect.fn("Observer.steerRequeued")(function* (
      session: Watched,
      key: IdempotencyKey,
      followUpTurnId: TurnId,
    ) {
      const dispatch = yield* keyed(session.id, key);
      if (Option.isNone(dispatch) || !undecided(dispatch.value)) return;
      // It now owns the follow-up turn, and is delivered when that starts.
      yield* ledger.accept(dispatch.value.id, null);
      yield* sql`
        UPDATE dispatches SET engine_turn_id = ${followUpTurnId} WHERE id = ${dispatch.value.id}
      `.pipe(Effect.orDie);
    });

    // ---- Steps, speech and tool calls -----------------------------------------------

    const step = Effect.fn("Observer.step")(function* (
      session: Watched,
      turnId: TurnId,
      work: WorkStep,
      at: DateTime.Utc,
    ) {
      const turn = yield* turnOf(session.id, turnId);
      if (Option.isNone(turn)) return;
      // A routine run works out of the operator's sight: its turn has no fold.
      if (session.purpose === "side") return yield* touchActivity(session.id, turnId, at);
      const foldId = yield* foldOf(session, turn.value);
      yield* sql`
        INSERT INTO work_steps (entry_id, step_id, position, step_json)
        VALUES (
          ${foldId}, ${work.id},
          (SELECT COALESCE(MAX(position) + 1, 0) FROM work_steps WHERE entry_id = ${foldId}),
          ${yield* encodeStep(work)}
        )
        ON CONFLICT (entry_id, step_id) DO UPDATE SET step_json = excluded.step_json
      `;
      yield* sql.afterCommit(workSteps.changed(foldId, work));
      const [count] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM work_steps WHERE entry_id = ${foldId}
      `;
      const fold = yield* entries.find(foldId);
      if (
        Option.isSome(fold) &&
        fold.value.entry._tag === "work-fold" &&
        fold.value.entry.stepCount !== (count?.n ?? 0)
      ) {
        yield* entries.update({ ...fold.value.entry, stepCount: count?.n ?? 0 });
      }
      yield* touchActivity(session.id, turnId, at);
    }, Effect.orDie);

    /** The host's own speech tool, delivered once per speech like a `say` without `done`. */
    const hostSpeech = Effect.fn("Observer.hostSpeech")(function* (
      session: Watched,
      speech: {
        readonly speechId: string;
        readonly turnId: TurnId;
        readonly text: string;
        readonly at: DateTime.Utc;
      },
    ) {
      const fresh = yield* sql`
        INSERT INTO host_speech (session_id, speech_id) VALUES (${session.id}, ${speech.speechId})
        ON CONFLICT DO NOTHING RETURNING speech_id
      `;
      if (fresh.length === 0) return;
      yield* touchActivity(session.id, speech.turnId, speech.at);
      const turn = yield* turnOf(session.id, speech.turnId);
      const audience = Option.match(turn, { onNone: () => conversation, onSome: audienceOf });
      // Speech replayed after its room was archived reaches nobody.
      const target = yield* liveTarget(session.bot_id, audience);
      if (target === null) return;
      const entry = yield* entries.append({
        target,
        entry: {
          _tag: "message",
          author: { _tag: "bot", botId: session.bot_id },
          text: speech.text.slice(0, MESSAGE_LIMIT),
          attachments: [],
          mentions: { _tag: "bots", ids: [] },
          delivery: { _tag: "delivered" },
          commandId: null,
        },
      });
      yield* sql`
        UPDATE host_speech SET entry_id = ${entry.id}
        WHERE session_id = ${session.id} AND speech_id = ${speech.speechId}
      `;
      yield* spoken.said({
        sessionId: session.id,
        botId: session.bot_id,
        entryId: entry.id,
        text: entry._tag === "message" ? entry.text : speech.text,
      });
    }, Effect.orDie);

    /**
     * The engine's record of a `j3` tool call, which a bot tool request is
     * matched against. A call told open again carries the input the engine
     * recorded last, which the bridge's request has: it replaces the digest
     * while the call is open and no request claimed it. A claimed or closed
     * call keeps what it was matched or ended with.
     */
    const toolCall = Effect.fn("Observer.toolCall")(function* (
      session: Watched,
      turnId: TurnId,
      call: ToolCall,
      open: boolean,
      at: DateTime.Utc,
    ) {
      yield* sql`
        INSERT INTO engine_tool_calls (
          session_id, engine_call_id, engine_turn_id, tool, input_digest, open, seen_at
        ) VALUES (
          ${session.id}, ${call.callId}, ${turnId}, ${call.tool}, ${call.inputDigest},
          ${open ? 1 : 0}, ${timeText(at)}
        )
        ON CONFLICT (session_id, engine_call_id) DO UPDATE SET
          input_digest = CASE
            WHEN engine_tool_calls.open = 1 AND excluded.open = 1 AND NOT EXISTS (
              SELECT 1 FROM tool_calls p
              WHERE p.session_id = engine_tool_calls.session_id
                AND p.engine_call_id = engine_tool_calls.engine_call_id
            ) THEN excluded.input_digest
            ELSE engine_tool_calls.input_digest
          END,
          open = min(engine_tool_calls.open, excluded.open)
      `;
      yield* touchActivity(session.id, turnId, at);
    }, Effect.orDie);

    // ---- Engine requests ----------------------------------------------------------

    const cardOf = (botId: BotId, request: EngineRequest): EntryDraft => {
      const author = { _tag: "bot", botId } as const;
      switch (request._tag) {
        case "approval":
          return {
            _tag: "approval",
            author,
            kind: request.kind,
            action: request.action,
            detail: request.detail,
            reason: request.reason,
            exact: request.exact,
            sessionGrant: request.sessionGrant,
            status: { _tag: "pending" },
          };
        case "question":
          return {
            _tag: "question",
            author,
            origin: "engine",
            questions: request.questions,
            status: { _tag: "pending" },
          };
        case "unsupported-question":
          // Never part of a question: a card that says why it cannot be shown,
          // whose only answer is a dismiss, which the bot reads as "no".
          return {
            _tag: "question",
            author,
            origin: "engine",
            questions: [
              {
                id: "unsupported",
                prompt:
                  request.exceeds === "questions"
                    ? `The bot asked ${request.count} questions at once, and a card holds at most ${request.max}. Dismiss it to answer no; the bot can ask again in a message.`
                    : `The bot asked a question with ${request.count} options, and a card shows at most ${request.max}. Dismiss it to answer no; the bot can ask again in a message.`,
                options: [],
                acceptsText: false,
                multiple: false,
              },
            ],
            status: { _tag: "pending" },
          };
        case "secret":
          return {
            _tag: "secret-request",
            author,
            label: request.label,
            reason: request.reason,
            url: request.url,
            placeholder: request.placeholder,
            status: "pending",
          };
      }
    };

    /**
     * An open request's card shows what the engine now records for it, while
     * it waits. Its status stays: an answer already on its way is the one
     * sent. A closed request's card no longer changes.
     */
    const updateRequest = Effect.fn("Observer.updateRequest")(function* (
      session: Watched,
      requestId: RequestId,
      request: EngineRequest,
    ) {
      const known = yield* requestRow({ sessionId: session.id, requestId });
      if (Option.isNone(known) || known.value.closed_at !== null) return;
      const found = yield* entries.find(known.value.entry_id);
      if (Option.isNone(found)) return;
      const card = found.value.entry;
      const updated = withContent(card, cardOf(session.bot_id, request));
      if (updated !== undefined && !Equal.equals(updated, card)) yield* entries.update(updated);
    }, Effect.orDie);

    /**
     * The request becomes a card in the bot's conversation, once. A request
     * already known, as a replacement lists it again, shows what it shows now.
     */
    const openRequest = Effect.fn("Observer.openRequest")(function* (
      session: Watched,
      open: OpenRequest,
    ) {
      const known = yield* requestRow({ sessionId: session.id, requestId: open.requestId });
      if (Option.isSome(known)) return yield* updateRequest(session, open.requestId, open.request);
      const entry = yield* entries.append({
        target: { _tag: "conversation", botId: session.bot_id },
        entry: cardOf(session.bot_id, open.request),
      });
      yield* sql`
        INSERT INTO engine_requests (entry_id, session_id, engine_request_id, engine_turn_id)
        VALUES (${entry.id}, ${session.id}, ${open.requestId}, ${open.turnId})
      `;
      yield* touchActivity(session.id, open.turnId, open.openedAt);
    }, Effect.orDie);

    /** The card shows how its request closed, once. */
    const closeRequest = Effect.fn("Observer.closeRequest")(function* (
      session: Watched,
      requestId: RequestId,
      resolution: RequestResolution,
    ) {
      const known = yield* requestRow({ sessionId: session.id, requestId });
      if (Option.isNone(known) || known.value.closed_at !== null) return;
      yield* closeCard(known.value, resolution);
    }, Effect.orDie);

    // ---- Replacement ----------------------------------------------------------------

    const replaced = Effect.fn("Observer.replaced")(function* (
      session: Watched,
      event: Extract<SessionEvent, { readonly _tag: "replaced" }>,
    ) {
      // Requests the engine closed explicitly first: whatever is still open
      // afterwards and not listed has expired, and an answered card must not
      // read as expired because the turn that asked it ended before.
      for (const closed of event.closedRequests) {
        yield* closeRequest(session, closed.requestId, closed.resolution);
      }
      // The turns some later turn continued: their dispatches follow the link
      // rather than settle, wherever in the snapshot the successor is.
      const continued = new Set<string>(
        [...event.openTurns, ...event.endedTurns].flatMap((turn) =>
          turn.cause._tag === "continuation" ? [turn.cause.turnId] : [],
        ),
      );
      // Ended turns in the order they ended, so a continuation's link is followed in order.
      const ended = [...event.endedTurns].sort((a, b) =>
        DateTime.isLessThan(a.finishedAt, b.finishedAt) ? -1 : 1,
      );
      for (const turn of ended) {
        if (turn.startedAt !== null)
          yield* startTurn(session, turn.turnId, turn.cause, turn.startedAt);
        for (const work of turn.steps) yield* step(session, turn.turnId, work, turn.finishedAt);
        yield* finishTurn(session, {
          turnId: turn.turnId,
          cause: turn.cause,
          outcome: turn.outcome,
          backgroundWork: turn.backgroundWork,
          continuation: turn.continuation,
          continued: continued.has(turn.turnId),
          contextRecovered: turn.contextRecovered,
          at: turn.finishedAt,
        });
      }
      for (const turn of event.openTurns) {
        if (turn.startedAt !== null) {
          yield* startTurn(session, turn.turnId, turn.cause, turn.startedAt);
        } else {
          yield* queuedTurn(session, turn.turnId, turn.cause);
        }
        for (const work of turn.steps) yield* step(session, turn.turnId, work, event.at);
        for (const call of turn.toolCalls)
          yield* toolCall(session, turn.turnId, call, true, event.at);
        const listed = turn.toolCalls.map((call) => call.callId);
        yield* sql`
          UPDATE engine_tool_calls SET open = 0
          WHERE session_id = ${session.id} AND engine_turn_id = ${turn.turnId}
            ${listed.length === 0 ? sql`` : sql`AND NOT ${sql.in("engine_call_id", listed)}`}
        `;
      }
      // A turn held open that the engine no longer lists has ended.
      const live = new Set<string>([
        ...event.openTurns.map((turn) => turn.turnId),
        ...event.endedTurns.map((turn) => turn.turnId),
      ]);
      for (const turn of yield* openTurnRows(session.id)) {
        if (live.has(turn.engine_turn_id)) continue;
        yield* finishTurn(session, {
          turnId: turn.engine_turn_id,
          cause: null,
          outcome: { _tag: "interrupted" },
          backgroundWork: false,
          continuation: null,
          continued: false,
          contextRecovered: false,
          at: event.at,
        });
      }
      // A continuation the engine no longer has pending, and that no turn took, was dropped.
      for (const turn of event.endedTurns) {
        if (turn.continuation === null && !continued.has(turn.turnId)) {
          yield* continuationDropped(session, turn.turnId);
        }
      }
      for (const settlement of event.steers) {
        if (settlement.settlement === "read") {
          yield* steered(session, settlement.key, settlement.turnId);
        } else {
          yield* steerDropped(session, settlement.key, settlement.turnId);
        }
      }
      for (const open of event.openRequests) yield* openRequest(session, open);
      const stillOpen = new Set<string>(event.openRequests.map((open) => open.requestId));
      for (const request of yield* openRequestRows({ sessionId: session.id, turnId: null })) {
        if (!stillOpen.has(request.engine_request_id)) {
          yield* closeRequest(session, request.engine_request_id, "expired");
        }
      }
      for (const speech of event.hostSpeech) yield* hostSpeech(session, speech);
      if (event.queueHeld) {
        yield* queueHeld(session, event.cursor);
      } else {
        // Nothing is held any more: a hold recorded before is stale.
        yield* sql`
          UPDATE sessions SET queue_held_cursor = NULL, queue_resumed_cursor = NULL,
            queue_resume_failures = 0, queue_resume_at = NULL
          WHERE id = ${session.id}
        `;
      }
    }, Effect.orDie);

    // ---- Held queues ------------------------------------------------------------------

    /** A new hold to resume once, by the resumer (`HeldQueues.ts`). */
    const queueHeld = Effect.fn("Observer.queueHeld")(function* (
      session: Watched,
      cursor: EventCursor,
    ) {
      yield* sql`
        UPDATE sessions SET queue_held_cursor = ${cursor}, queue_resume_failures = 0,
          queue_resume_at = NULL
        WHERE id = ${session.id} AND queue_held_cursor IS NOT ${cursor}
      `;
      yield* sql.afterCommit(signals.resumes.fire);
    }, Effect.orDie);

    // ---- Applying events --------------------------------------------------------------

    const applyEvent = Effect.fn("Observer.applyEvent")(function* (
      session: Watched,
      follow: Following,
      event: SessionEvent,
    ) {
      switch (event._tag) {
        case "replaced":
          return yield* replaced(session, event);
        case "turn-started":
          return yield* startTurn(session, event.turnId, event.cause, event.startedAt);
        case "turn-queued":
          return yield* queuedTurn(session, event.turnId, event.cause);
        case "steered":
          return yield* steered(session, event.key, event.turnId);
        case "steer-dropped":
          return yield* steerDropped(session, event.key, event.turnId);
        case "steer-requeued":
          return yield* steerRequeued(session, event.key, event.followUpTurnId);
        case "step":
          return yield* step(session, event.turnId, event.step, event.at);
        case "host-speech":
          return yield* hostSpeech(session, event);
        case "tool-call":
          return yield* toolCall(
            session,
            event.turnId,
            event.call,
            event.state === "open",
            event.at,
          );
        case "request-opened":
          return yield* openRequest(session, event.open);
        case "request-updated":
          return yield* updateRequest(session, event.requestId, event.request);
        case "request-closed":
          return yield* closeRequest(session, event.requestId, event.resolution);
        case "turn-finished":
          return yield* finishTurn(session, {
            turnId: event.turnId,
            cause: event.cause,
            outcome: event.outcome,
            backgroundWork: event.backgroundWork,
            continuation: event.continuation,
            continued: false,
            contextRecovered: event.contextRecovered,
            at: event.finishedAt,
          });
        case "continuation-dropped":
          return yield* continuationDropped(session, event.turnId);
        case "queue-held":
          return yield* queueHeld(session, event.cursor);
        case "synchronized": {
          const waiting = follow.tokens.get(event.token);
          if (waiting !== undefined) {
            yield* sql.afterCommit(
              Deferred.succeed(waiting, {
                backgroundWork: event.backgroundWork,
                runnableTurns: event.runnableTurns,
              }),
            );
          }
          return;
        }
      }
    });

    /**
     * One event and its cursor, in one transaction, unless the session was
     * recorded lost, or archived, meanwhile: what is open there was settled
     * then, so nothing more of its stream is applied, and this says to stop
     * reading it. Once an event commits the session's state
     * is known from here: it is marked ready before the change is published,
     * so whoever sees the change finds the session ready. A busy refusal's
     * deadline ends with it. Only then are the workers nudged, and only when
     * something they wait on may have changed: the dispatcher when the event
     * can change whether the session is idle, when it ended a busy deadline or
     * made the session ready again, the Stop runner when it can change
     * whether a Stop is done, and the routine runner on the same terms for a
     * side session.
     */
    const apply = Effect.fn("Observer.apply")(function* (
      session: Watched,
      follow: Following,
      event: SessionEvent,
    ) {
      const caughtUp = yield* Deferred.poll(follow.caughtUp);
      const wasReady = Option.isSome(caughtUp) && !behind.has(session.id);
      const applied = yield* transaction(
        Effect.gen(function* () {
          const now = yield* sessionNow(session.id);
          if (now.ended) return null;
          yield* applyEvent(session, follow, event);
          yield* sql`
            UPDATE sessions SET events_cursor = ${event.cursor}, busy_until = NULL,
              busy_refusals = 0
            WHERE id = ${session.id}
          `;
          yield* sql.afterCommit(
            Effect.sync(() => {
              failures.delete(session.id);
              behind.delete(session.id);
              shown.delete(session.id);
            }).pipe(Effect.andThen(Deferred.succeed(follow.caughtUp, undefined))),
          );
          yield* changes.touch({ _tag: "bot", botId: session.bot_id });
          return { busyEnded: now.busy };
        }),
      ).pipe(Effect.orDie);
      if (applied === null) return false;
      const work = changesWork(event);
      if (work || applied.busyEnded || !wasReady) yield* signals.dispatch.fire;
      if (work) yield* signals.stops.fire;
      // A session due for rotation is replaced only once its events are known.
      if (!wasReady) yield* signals.rotations.fire;
      // A side session's attempt waits for it to be ready, and its retirement
      // for its work to end.
      if (session.purpose === "side" && (work || !wasReady)) yield* signals.routines.fire;
      return true;
    });

    // ---- Following sessions -----------------------------------------------------------

    /**
     * Opens the session's stream again once its backoff passes. Until then it
     * stays `reopening`, so nothing opens it sooner and it is not ready.
     */
    const reopen = Effect.fn("Observer.reopen")(
      function* (sessionId: SessionRowId, marker: Reopening) {
        const failed = (failures.get(sessionId) ?? 0) + 1;
        failures.set(sessionId, failed);
        yield* Effect.sleep(reopenAfter(failed));
        if (following.get(sessionId) !== marker) return;
        following.delete(sessionId);
        yield* watch(sessionId);
      },
      Effect.forkIn(scope),
      Effect.asVoid,
    );

    /** The session's stream will be opened again: it is `reopening` from now. */
    const willReopen = (sessionId: SessionRowId, follow: Following) =>
      Effect.suspend(() => {
        if (following.get(sessionId) !== follow) return Effect.void;
        const marker: Reopening = { _tag: "reopening" };
        following.set(sessionId, marker);
        return reopen(sessionId, marker);
      });

    /** The session's stream will not be opened again: nothing follows it. */
    const forget = (sessionId: SessionRowId, follow: Following) =>
      Effect.sync(() => {
        if (following.get(sessionId) === follow) following.delete(sessionId);
      });

    /** Every waiter on a stream that closed fails, to be retried. */
    const closeWaiters = Effect.fn("Observer.closeWaiters")(function* (follow: Following) {
      const closed = new NotObserved();
      yield* Deferred.fail(follow.caughtUp, closed);
      for (const waiting of follow.tokens.values()) yield* Deferred.fail(waiting, closed);
    });

    /**
     * The notice of an event that cannot be applied, shown once: in its own
     * transaction, and counted as shown only once it commits. One that cannot
     * be written is logged and tried again the next time the event fails.
     */
    const showObservationFailed = (session: Watched) =>
      Effect.suspend(() =>
        shown.has(session.id)
          ? Effect.void
          : transaction(
              notify(session.bot_id, conversation, { _tag: "observation-failed" }, null),
            ).pipe(
              Effect.andThen(Effect.sync(() => shown.add(session.id))),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logError("The notice of an event that cannot be applied failed", cause),
              ),
            ),
      );

    /**
     * What a stream's end means for the session: whether it is opened again.
     * An event that cannot be applied is not skipped: it is logged with its
     * cause, shown once as a notice, and read again.
     */
    const endOf = Effect.fn("Observer.endOf")(function* (
      session: Watched,
      exit: Exit.Exit<void, SessionNotFound | EngineIncompatible>,
    ) {
      if (Exit.isSuccess(exit)) {
        // It stopped because the session was lost, or the engine ended it.
        if (Option.isNone(yield* watchedRow(session.id).pipe(Effect.orDie))) {
          return "forget" as const;
        }
        yield* Effect.logWarning("A session's event stream ended; it is opened again");
        return "reopen" as const;
      }
      if (Cause.hasInterruptsOnly(exit.cause)) return "forget" as const;
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error) && error.value._tag === "SessionNotFound") {
        yield* Effect.logWarning("The engine no longer has a session", error.value);
        yield* transaction(
          Effect.gen(function* () {
            if (yield* sessionLost(session.id)) {
              yield* changes.touch({ _tag: "bot", botId: session.bot_id });
            }
          }),
        ).pipe(Effect.orDie);
        return "forget" as const;
      }
      if (Option.isSome(error)) {
        yield* Effect.logError("A session's event stream failed", error.value);
      } else {
        behind.add(session.id);
        yield* Effect.logError("A session event could not be applied", exit.cause);
        yield* showObservationFailed(session);
      }
      return "reopen" as const;
    });

    /**
     * A session's stream ended. It is opened again with backoff unless the
     * session is gone or the server is stopping, also when handling its end
     * failed. Its waiters fail last, so one that retries finds the session as
     * its end left it.
     */
    const ended = Effect.fn("Observer.ended")(
      function* (
        session: Watched,
        follow: Following,
        exit: Exit.Exit<void, SessionNotFound | EngineIncompatible>,
      ) {
        const next = yield* endOf(session, exit).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError("A session's stream end could not be handled", cause).pipe(
                Effect.as("reopen" as const),
              ),
          ),
        );
        yield* next === "reopen" ? willReopen(session.id, follow) : forget(session.id, follow);
      },
      (effect, _session, follow) => Effect.ensuring(effect, closeWaiters(follow)),
    );

    /**
     * Opens the session's stream and starts reading it. A failure to open it
     * leaves nothing behind: what was subscribed is closed, its waiters fail,
     * and it is opened again with backoff.
     */
    const open = Effect.fn("Observer.open")(function* (sessionId: SessionRowId, follow: Following) {
      const row = yield* watchedRow(sessionId).pipe(Effect.orDie);
      if (Option.isNone(row)) {
        // Nothing to follow: not opened yet, retired or lost.
        yield* forget(sessionId, follow);
        yield* closeWaiters(follow);
        return;
      }
      const session = row.value;
      // Started here rather than in the fiber that reads it: a stream counts
      // as open from when it is subscribed (`Engine.events`), and starting it
      // before `watch` returns is what lets a `synchronize` rely on it.
      const streamScope = yield* Scope.fork(scope);
      const pull = yield* Stream.toPull(
        engine.events({ sessionId: session.engine_session_id, after: session.events_cursor }),
      ).pipe(
        Scope.provide(streamScope),
        Effect.onError(() => Scope.close(streamScope, Exit.void)),
      );
      // A committed cursor already says where the session stands; without
      // one, the first `replaced` does once it is applied.
      if (session.events_cursor !== null) yield* Deferred.succeed(follow.caughtUp, undefined);
      yield* Stream.fromPull(Effect.succeed(pull)).pipe(
        Stream.interruptWhen(Deferred.await(follow.closed)),
        // Read until the session is recorded lost or archived: what is
        // buffered after that is never applied.
        Stream.runForEachWhile((event) => apply(session, follow, event)),
        Effect.onExit((exit) =>
          ended(session, follow, exit).pipe(Effect.ensuring(Scope.close(streamScope, Exit.void))),
        ),
        Effect.forkIn(scope),
      );
    });

    const watch = (sessionId: SessionRowId): Effect.Effect<void> =>
      Effect.suspend(() => {
        // Looked up and claimed in one step, so two callers never open two streams.
        const existing = following.get(sessionId);
        if (existing?._tag === "open") return Deferred.await(existing.opened);
        // Its backoff opens it again.
        if (existing?._tag === "reopening") return Effect.void;
        const follow: Following = {
          _tag: "open",
          opened: Deferred.makeUnsafe<void>(),
          closed: Deferred.makeUnsafe<void>(),
          caughtUp: Deferred.makeUnsafe<void, NotObserved>(),
          tokens: new Map(),
        };
        following.set(sessionId, follow);
        return open(sessionId, follow).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError(
                "A session's stream could not be opened; it is tried again",
                cause,
              ).pipe(
                Effect.andThen(willReopen(sessionId, follow)),
                Effect.ensuring(closeWaiters(follow)),
              ),
          ),
          Effect.onInterrupt(() => Effect.andThen(forget(sessionId, follow), closeWaiters(follow))),
          Effect.ensuring(Deferred.succeed(follow.opened, undefined)),
        );
      }).pipe(Effect.withSpan("Observer.watch"));

    const ready = Effect.fn("Observer.ready")(function* (sessionId: SessionRowId) {
      const follow = following.get(sessionId);
      // An event that cannot be applied leaves what the server knows behind.
      if (follow?._tag !== "open" || behind.has(sessionId)) return false;
      const caughtUp = yield* Deferred.poll(follow.caughtUp);
      if (Option.isNone(caughtUp)) return false;
      return Exit.isSuccess(yield* Effect.exit(caughtUp.value));
    });

    const close = (sessionId: SessionRowId) =>
      Effect.suspend(() => {
        const current = following.get(sessionId);
        following.delete(sessionId);
        failures.delete(sessionId);
        behind.delete(sessionId);
        shown.delete(sessionId);
        return current?._tag === "open" ? Deferred.succeed(current.closed, undefined) : Effect.void;
      }).pipe(Effect.asVoid, Effect.withSpan("Observer.close"));

    const watchAll = Effect.gen(function* () {
      for (const { id } of yield* sessionsToWatch(undefined).pipe(Effect.orDie)) yield* watch(id);
    }).pipe(Effect.withSpan("Observer.watchAll"));

    const synchronize = Effect.fn("Observer.synchronize")(
      function* (sessionId: SessionRowId, engineSessionId: SessionId) {
        yield* watch(sessionId);
        const token = SyncToken.make(yield* ids.make("sync"));
        const applied = Deferred.makeUnsafe<Synchronized, NotObserved>();
        // Registered only on a stream still open: one that closed has failed
        // its waiters already and would never fail this one.
        const follow = yield* Effect.sync(() => {
          const current = following.get(sessionId);
          if (current?._tag !== "open") return undefined;
          current.tokens.set(token, applied);
          return current;
        });
        if (follow === undefined) return yield* new NotObserved();
        // Abandoned at the deadline, the call is interrupted, which cancels
        // the adapter's catch-up for it.
        return yield* engine
          .synchronize({ sessionId: engineSessionId, token })
          .pipe(
            Effect.andThen(Deferred.await(applied)),
            Effect.ensuring(Effect.sync(() => follow.tokens.delete(token))),
          );
      },
      Effect.timeoutOrElse({
        duration: SYNC_DEADLINE,
        orElse: () => Effect.fail(new NotObserved()),
      }),
    );

    return Observer.of({
      watch,
      ready,
      close,
      watchAll,
      synchronize,
    });
  }),
);
