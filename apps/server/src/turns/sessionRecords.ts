// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId, type WorkFoldEntry } from "@j3-bots/contracts";
import { type RequestResolution, TurnId, TurnOutcome } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Entries } from "../entries/Entries.ts";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";
import { DISPATCH_COLUMNS, DispatchRow, type Ledger } from "./Ledger.ts";
import { audienceOf, conversation, type SessionRowId, StoredResponse } from "./model.ts";
import { notices } from "./notices.ts";
import type { Signals } from "./Signals.ts";
import { stopTargets } from "./stopTargets.ts";
import { endedWork, WorkJson } from "./turnWork.ts";
import { waitedWithin } from "./waited.ts";
import type { WorkSteps } from "./WorkSteps.ts";

const LostRow = Schema.Struct({
  bot_id: BotId,
  purpose: Schema.Literals(["main", "side"]),
  retired_at: Schema.NullOr(Schema.String),
});

/** A turn as its end and its work fold need it. */
const FoldTurn = Schema.Struct({
  engine_turn_id: TurnId,
  started_at: Time,
  work_fold_entry_id: Schema.NullOr(EntryId),
});
type FoldTurn = typeof FoldTurn.Type;

/** A session as its turns' work folds need it. */
const FoldSession = Schema.Struct({
  id: Schema.String,
  bot_id: BotId,
  /** A side session runs a routine out of the operator's sight: its turns have no folds. */
  purpose: Schema.Literals(["main", "side"]),
});
type FoldSession = typeof FoldSession.Type;

const OpenRequest = Schema.Struct({
  entry_id: EntryId,
  response_json: Schema.NullOr(json(StoredResponse)),
});

const encodeOutcome = Schema.encodeEffect(json(TurnOutcome));
const encodeWork = Schema.encodeEffect(WorkJson);

const WaitRow = Schema.Struct({ opened_at: Time, closed_at: Schema.NullOr(Time) });

const BackgroundFold = Schema.Struct({ entry_id: EntryId, pending: Flag });

/** How a turn's end reads in its work fold. */
export const endingOf = (outcome: TurnOutcome) =>
  outcome._tag === "completed" ? "completed" : outcome._tag === "failed" ? "failed" : "interrupted";

/**
 * Writes the observer and a lost session share: a turn's end and the work
 * fold that ends with it, and a card whose engine request closed. Runs in
 * the caller's transaction.
 */
export const sessionRecords = (
  sql: SqlClient.SqlClient,
  entries: Entries["Service"],
  workSteps: WorkSteps["Service"],
) => {
  /**
   * The cards the fold's turn waited on the operator for, from arrival until
   * each closed. A card whose answer the engine refused leaves its turn
   * waiting until it ends or is stopped, so it counts as open.
   */
  const waitRows = SqlSchema.findAll({
    Request: EntryId,
    Result: WaitRow,
    execute: (foldId) => sql`
      SELECT e.created_at AS opened_at,
        CASE WHEN json_extract(e.body_json, '$.status._tag') = 'refused' THEN NULL
          ELSE r.closed_at END AS closed_at
      FROM turns t
      JOIN engine_requests r ON r.session_id = t.session_id AND r.engine_turn_id = t.engine_turn_id
      JOIN entries e ON e.id = r.entry_id
      WHERE t.work_fold_entry_id = ${foldId}
    `,
  });

  /**
   * The fold ends with its turn, less the time the turn waited on the
   * operator: `waitedMs` after the fold was written, as clients that count
   * from it read it, and `waitedBeforeMs` from the turn's start until then.
   * `background`: work the turn handed off still runs, and its steps go on
   * until `backgroundEnded`.
   */
  const finishFold = Effect.fn("sessionRecords.finishFold")(function* (
    entryId: EntryId,
    outcome: TurnOutcome,
    at: DateTime.Utc,
    background: boolean,
  ) {
    const found = yield* entries.find(entryId);
    if (Option.isNone(found) || found.value.entry._tag !== "work-fold") return;
    const fold = found.value.entry;
    const waits = (yield* waitRows(entryId)).map((row) => ({
      from: row.opened_at,
      until: row.closed_at,
    }));
    const written = DateTime.min(fold.createdAt, at);
    const waitedBeforeMs =
      fold.turnStartedAt === null ? 0 : waitedWithin(waits, fold.turnStartedAt, written);
    yield* entries.update({
      ...fold,
      status: {
        _tag: "finished",
        finishedAt: at,
        ending: endingOf(outcome),
        waitedMs: waitedWithin(waits, fold.createdAt, at),
        waitedBeforeMs,
        background,
      },
    });
    if (!background) yield* sql.afterCommit(workSteps.finished(entryId));
  }, Effect.orDie);

  /** The folds of the session's ended turns whose handed-off work may have changed. */
  const backgroundFolds = SqlSchema.findAll({
    Request: Schema.String,
    Result: BackgroundFold,
    execute: (sessionId) => sql`
      SELECT t.work_fold_entry_id AS entry_id, t.background_pending AS pending FROM turns t
      JOIN entries e ON e.id = t.work_fold_entry_id
      WHERE t.session_id = ${sessionId} AND t.finished_at IS NOT NULL
        AND (t.background_pending = 1 OR json_extract(e.body_json, '$.status.background') = 1)
    `,
  });

  /**
   * Each ended turn's fold says whether the work it handed off still runs,
   * as the turn's flag does (`turns.background_pending`); `lost`: nothing
   * runs in the session any more. A fold whose work ended changes no more.
   */
  const followBackground = Effect.fn("sessionRecords.followBackground")(function* (
    sessionId: SessionRowId,
    lost: boolean,
  ) {
    for (const row of yield* backgroundFolds(sessionId)) {
      const found = yield* entries.find(row.entry_id);
      if (Option.isNone(found)) continue;
      const fold = found.value.entry;
      if (fold._tag !== "work-fold" || fold.status._tag !== "finished") continue;
      const background = row.pending && !lost;
      if (fold.status.background === background) continue;
      yield* entries.update({ ...fold, status: { ...fold.status, background } });
      if (!background) yield* sql.afterCommit(workSteps.finished(row.entry_id));
    }
  }, Effect.orDie);

  /**
   * The card shows how its request closed: the operator's answer when it was
   * theirs from J3 Bots, expired otherwise. `at` is when it closed, as the
   * engine recorded it, so a close told again after a reconnect or a restart
   * keeps its time. An answer counts as activity in the turn it holds.
   */
  const closeCard = Effect.fn("sessionRecords.closeCard")(function* (
    request: typeof OpenRequest.Type,
    resolution: RequestResolution,
    at: DateTime.Utc,
  ) {
    const closedAt = timeText(at);
    yield* sql`
      UPDATE engine_requests SET closed_at = ${closedAt}
      WHERE entry_id = ${request.entry_id}
    `;
    // The operator's answer moves the turn on: its quiet counts from then, not from the card.
    if (resolution !== "expired") {
      yield* sql`
        UPDATE turns SET last_activity_at = MAX(last_activity_at, ${closedAt})
        WHERE finished_at IS NULL AND (session_id, engine_turn_id) = (
          SELECT session_id, engine_turn_id FROM engine_requests WHERE entry_id = ${request.entry_id}
        )
      `;
    }
    yield* sql`DELETE FROM secret_submissions WHERE entry_id = ${request.entry_id}`;
    const found = yield* entries.find(request.entry_id);
    if (Option.isNone(found)) return;
    const card = found.value.entry;
    const response = request.response_json;
    const answered = resolution === "answered";
    switch (card._tag) {
      case "approval":
        return yield* entries.update({
          ...card,
          status:
            answered && response?._tag === "approval"
              ? { _tag: "decided", decision: response.decision }
              : { _tag: "expired" },
        });
      case "question":
        return yield* entries.update({
          ...card,
          status:
            answered && response?._tag === "question"
              ? { _tag: "answered", answers: response.answers }
              : { _tag: "expired" },
        });
      case "secret-request":
        return yield* entries.update({
          ...card,
          status: resolution === "provided" || resolution === "declined" ? resolution : "expired",
        });
      default:
        return;
    }
  }, Effect.orDie);

  /**
   * The turn's work fold in the bot's conversation, written once: with its
   * first step, starting as `status` (finished, for a step reported after
   * its turn ended), or as the turn ends when it was stopped or failed
   * before one.
   */
  const foldOf = Effect.fn("sessionRecords.foldOf")(function* (
    session: FoldSession,
    turn: FoldTurn,
    status: WorkFoldEntry["status"],
  ) {
    if (turn.work_fold_entry_id !== null) return turn.work_fold_entry_id;
    const entry = yield* entries.append({
      target: { _tag: "conversation", botId: session.bot_id },
      entry: {
        _tag: "work-fold",
        author: { _tag: "bot", botId: session.bot_id },
        turnStartedAt: turn.started_at,
        stepCount: 0,
        apps: [],
        work: null,
        status,
      },
    });
    yield* sql`
      UPDATE turns SET work_fold_entry_id = ${entry.id}
      WHERE session_id = ${session.id} AND engine_turn_id = ${turn.engine_turn_id}
    `;
    return entry.id;
  }, Effect.orDie);

  /**
   * A turn's end, as the engine reports it or as a lost session settles it:
   * the turn records its outcome, and its work fold ends with it. A turn
   * stopped or failed before its first step still says how it ended, in a
   * fold of no steps; one that completed leaves only its reply, and a
   * routine's turn none. `background`: work the turn handed off still runs.
   */
  const endTurn = Effect.fn("sessionRecords.endTurn")(function* (
    session: FoldSession,
    turn: FoldTurn,
    outcome: TurnOutcome,
    at: DateTime.Utc,
    background: boolean,
  ) {
    yield* sql`
      UPDATE turns SET finished_at = ${timeText(at)}, outcome_json = ${yield* encodeOutcome(outcome)}
      WHERE session_id = ${session.id} AND engine_turn_id = ${turn.engine_turn_id}
    `;
    const tellsItsEnd =
      (outcome._tag === "interrupted" || outcome._tag === "failed") && session.purpose === "main";
    const foldId =
      turn.work_fold_entry_id ??
      (tellsItsEnd ? yield* foldOf(session, turn, { _tag: "running" }) : null);
    if (foldId !== null) yield* finishFold(foldId, outcome, at, background);
  }, Effect.orDie);

  return { foldOf, endTurn, finishFold, followBackground, closeCard };
};

/**
 * A session the engine answered it has no such session for
 * (`docs/architecture/server.md`, Sessions). Recorded once, and everything
 * open in it is settled in the same transaction, since nothing runs there any
 * more: its Stop targets settle, a dispatch the engine had whose turn
 * never started fails as `unresolved` with its wakes failed and retryable, a
 * delivered one finishes interrupted with its turn, every open turn and its
 * work fold end interrupted where the turn was last seen working, and its
 * open requests close. A dispatch not yet
 * answered is the sender's, which settles it in the session's gate: it is due
 * at once, whatever its backoff, and the workers are nudged once the loss
 * commits. A live main session's loss shows in the bot's conversation, with a
 * retry of the bot's opening if its turn was cut short, and the rotator gives
 * the bot a new one; one J3 Bots had retired was replaced already, so its
 * loss is not told. Runs in the caller's transaction.
 *
 * A session J3 Bots retired and the engine then archived (`sessionArchived`)
 * is settled the same way, with no `session-lost` notice: the server follows
 * its events no more, so nothing would ever end what is still open there. A
 * turn still open there would end its work fold as stopped, like any turn
 * that did not finish; none is in practice, since a session is retired with
 * a turn running only once it was lost, and so already settled.
 */
export const sessionLoss = (
  sql: SqlClient.SqlClient,
  entries: Entries["Service"],
  ledger: Ledger["Service"],
  workSteps: WorkSteps["Service"],
  signals: Signals["Service"],
) => {
  const { notify } = notices(sql, entries);
  const { endTurn, followBackground, closeCard } = sessionRecords(sql, entries, workSteps);
  const targets = stopTargets(sql);

  const markLost = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, at: Schema.String }),
    Result: LostRow,
    execute: ({ sessionId, at }) => sql`
      UPDATE sessions SET lost_at = ${at}
      WHERE id = ${sessionId} AND lost_at IS NULL
      RETURNING bot_id, purpose, retired_at
    `,
  });

  const inEngine = SqlSchema.findAll({
    Request: Schema.String,
    Result: DispatchRow,
    execute: (sessionId) => sql`
      SELECT ${sql.literal(DISPATCH_COLUMNS)} FROM dispatches
      WHERE session_id = ${sessionId} AND status IN ('accepted', 'delivered')
      ORDER BY rowid
    `,
  });

  const sessionOf = SqlSchema.findOne({
    Request: Schema.String,
    Result: FoldSession,
    execute: (sessionId) => sql`SELECT id, bot_id, purpose FROM sessions WHERE id = ${sessionId}`,
  });

  const openTurns = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ ...FoldTurn.fields, last_activity_at: Time }),
    execute: (sessionId) => sql`
      SELECT engine_turn_id, started_at, work_fold_entry_id, last_activity_at FROM turns
      WHERE session_id = ${sessionId} AND finished_at IS NULL
    `,
  });

  const workingTurns = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      engine_turn_id: TurnId,
      work_fold_entry_id: Schema.NullOr(EntryId),
      work_json: WorkJson,
    }),
    execute: (sessionId) => sql`
      SELECT engine_turn_id, work_fold_entry_id, work_json FROM turns
      WHERE session_id = ${sessionId} AND json_extract(work_json, '$.littleOnes.working') > 0
    `,
  });

  /**
   * Every little one still working in a session nothing runs in any more
   * ended with it, where its turn shows it: on the turn's work fold, or in
   * its room, which no longer counts the session's turns.
   */
  const settleWork = Effect.fnUntraced(function* (sessionId: SessionRowId, now: DateTime.Utc) {
    for (const turn of yield* workingTurns(sessionId)) {
      const work = endedWork(turn.work_json, now);
      yield* sql`
        UPDATE turns SET work_json = ${yield* encodeWork(work)}
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turn.engine_turn_id}
      `;
      const fold =
        turn.work_fold_entry_id === null
          ? Option.none()
          : yield* entries.find(turn.work_fold_entry_id);
      if (
        Option.isSome(fold) &&
        fold.value.entry._tag === "work-fold" &&
        fold.value.entry.work !== null
      ) {
        yield* entries.update({ ...fold.value.entry, work });
      }
    }
  });

  const openRequests = SqlSchema.findAll({
    Request: Schema.String,
    Result: OpenRequest,
    execute: (sessionId) => sql`
      SELECT entry_id, response_json FROM engine_requests
      WHERE session_id = ${sessionId} AND closed_at IS NULL
    `,
  });

  /**
   * Everything open in a session nothing runs in any more, settled at `now`,
   * and its turns where they were last seen working. Returns the dispatches
   * whose turn it interrupted.
   */
  const settleOpen = Effect.fnUntraced(function* (sessionId: SessionRowId, now: DateTime.Utc) {
    const at = timeText(now);
    yield* sql`
      UPDATE sessions SET admitted_turn_id = NULL, admitted_audience = NULL, admitted_room_id = NULL
      WHERE id = ${sessionId}
    `;
    // Settled as they stand: each round keeps what the engine answered for it,
    // a refusal included.
    yield* sql`
      UPDATE stop_targets SET stopped_at = ${at}
      WHERE session_id = ${sessionId} AND stopped_at IS NULL
    `;
    const interrupted: TurnOutcome = { _tag: "interrupted" };
    const ran: Array<DispatchRow> = [];
    for (const dispatch of yield* inEngine(sessionId)) {
      if (dispatch.status === "delivered") {
        yield* ledger.finish(dispatch.id, interrupted);
        ran.push(dispatch);
      } else {
        yield* ledger.abandon(
          dispatch.id,
          yield* targets.wakesAfter(dispatch, { _tag: "failed", reason: "unresolved" }),
        );
      }
    }
    const session = yield* sessionOf(sessionId);
    // Each ends where it was last seen working: the session may have been
    // gone long before the loss was known, as across an outage, and that time
    // is no work of the turn's.
    for (const turn of yield* openTurns(sessionId)) {
      yield* endTurn(session, turn, interrupted, turn.last_activity_at, false);
    }
    yield* followBackground(sessionId, true);
    yield* settleWork(sessionId, now);
    yield* sql`UPDATE engine_tool_calls SET open = 0 WHERE session_id = ${sessionId}`;
    for (const request of yield* openRequests(sessionId)) {
      yield* closeCard(request, "expired", now);
    }
    yield* sql`
      UPDATE dispatches SET next_attempt_at = NULL
      WHERE session_id = ${sessionId} AND status = 'intended'
    `;
    // What waited on the session may settle, its bot may take work
    // elsewhere, a main session is replaced, a side session's routine run is
    // tried again in a fresh one, and its event stream is closed: an engine
    // thread archived from the engine's own console keeps its stream open
    // with nothing more to say (`Observer`).
    yield* sql.afterCommit(
      Effect.all(
        [
          signals.unwatched.fire,
          signals.dispatch.fire,
          signals.recovery.fire,
          signals.stops.fire,
          signals.rotations.fire,
          signals.routines.fire,
        ],
        { discard: true },
      ),
    );
    return ran;
  });

  /**
   * A bot's opening whose turn the loss interrupted is offered again, as an
   * interrupted turn's is (`Observer`), unless a Stop covers it.
   */
  const openingInterrupted = Effect.fnUntraced(function* (dispatch: DispatchRow) {
    const carried = yield* ledger.wakesOf(dispatch.id);
    if (!carried.some((wake) => wake.payload_json._tag === "first-run")) return;
    const audience = audienceOf(dispatch);
    if (yield* targets.covers(dispatch.bot_id, audience, dispatch.seq)) return;
    yield* notify(
      dispatch.bot_id,
      audience,
      { _tag: "turn-failed", failure: "unknown" },
      { dispatchId: dispatch.id, reason: "turn" },
    );
  });

  /** Whether the session was recorded lost by this call. */
  const sessionLost = Effect.fn("sessionLoss.sessionLost")(function* (sessionId: SessionRowId) {
    const now = yield* DateTime.now;
    const [lost] = yield* markLost({ sessionId, at: timeText(now) });
    if (lost === undefined) return false;
    const ran = yield* settleOpen(sessionId, now);
    // A session J3 Bots retired was already replaced: its going is no loss to tell.
    if (lost.purpose === "main" && lost.retired_at === null) {
      yield* notify(lost.bot_id, conversation, { _tag: "session-lost" }, null);
      for (const dispatch of ran) yield* openingInterrupted(dispatch);
    }
    return true;
  }, Effect.orDie);

  /** Records that the engine archived a session J3 Bots retired, and settles what is open in it. */
  const sessionArchived = Effect.fn("sessionLoss.sessionArchived")(function* (
    sessionId: SessionRowId,
  ) {
    const now = yield* DateTime.now;
    const archived = yield* sql`
      UPDATE sessions SET engine_retired_at = ${timeText(now)}
      WHERE id = ${sessionId} AND engine_retired_at IS NULL
      RETURNING id
    `;
    if (archived.length > 0) yield* settleOpen(sessionId, now);
  }, Effect.orDie);

  return { sessionLost, sessionArchived };
};
