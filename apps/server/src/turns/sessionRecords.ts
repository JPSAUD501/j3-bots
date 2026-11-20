// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, EntryId } from "@j3-bots/contracts";
import { type RequestResolution, TurnId, TurnOutcome } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Entries } from "../entries/Entries.ts";
import { json, timeText } from "../persistence/columns.ts";
import { DISPATCH_COLUMNS, DispatchRow, type Ledger } from "./Ledger.ts";
import { conversation, type SessionRowId, StoredResponse } from "./model.ts";
import { notices } from "./notices.ts";
import type { Signals } from "./Signals.ts";
import { stopTargets } from "./stopTargets.ts";
import type { WorkSteps } from "./WorkSteps.ts";

const LostRow = Schema.Struct({ bot_id: BotId, purpose: Schema.Literals(["main", "side"]) });

const OpenTurn = Schema.Struct({
  engine_turn_id: TurnId,
  work_fold_entry_id: Schema.NullOr(EntryId),
});

const OpenRequest = Schema.Struct({
  entry_id: EntryId,
  response_json: Schema.NullOr(json(StoredResponse)),
});

const encodeOutcome = Schema.encodeEffect(json(TurnOutcome));

/** How a turn's end reads in its work fold. */
export const endingOf = (outcome: TurnOutcome) =>
  outcome._tag === "completed" ? "completed" : outcome._tag === "failed" ? "failed" : "interrupted";

/**
 * Writes the observer and a lost session share: a work fold that ends with
 * its turn, and a card whose engine request closed. Runs in the caller's
 * transaction.
 */
export const sessionRecords = (
  sql: SqlClient.SqlClient,
  entries: Entries["Service"],
  workSteps: WorkSteps["Service"],
) => {
  const finishFold = Effect.fn("sessionRecords.finishFold")(function* (
    entryId: EntryId,
    outcome: TurnOutcome,
    at: DateTime.Utc,
  ) {
    const found = yield* entries.find(entryId);
    if (Option.isNone(found) || found.value.entry._tag !== "work-fold") return;
    yield* entries.update({
      ...found.value.entry,
      status: { _tag: "finished", finishedAt: at, ending: endingOf(outcome) },
    });
    yield* sql.afterCommit(workSteps.finished(entryId));
  });

  /**
   * The card shows how its request closed: the operator's answer when it was
   * theirs from J3 Bots, expired otherwise.
   */
  const closeCard = Effect.fn("sessionRecords.closeCard")(function* (
    request: typeof OpenRequest.Type,
    resolution: RequestResolution,
  ) {
    yield* sql`
      UPDATE engine_requests SET closed_at = ${timeText(yield* DateTime.now)}
      WHERE entry_id = ${request.entry_id}
    `;
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
          status: !answered
            ? { _tag: "expired" }
            : response?._tag === "question"
              ? { _tag: "answered", answers: response.answers }
              : response?._tag === "dismiss"
                ? { _tag: "dismissed" }
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

  return { finishFold, closeCard };
};

/**
 * A session the engine answered it has no such session for
 * (`docs/architecture/server.md`, Sessions). Recorded once, and everything
 * open in it is settled in the same transaction, since nothing runs there any
 * more: its Stop targets settle, a dispatch the engine had whose turn
 * never started fails as `unresolved` with its wakes failed and retryable, a
 * delivered one finishes interrupted with its turn, every open turn and its
 * work fold end interrupted, and its open requests close. A dispatch not yet
 * answered is the sender's, which settles it in the session's gate: it is due
 * at once, whatever its backoff, and the workers are nudged once the loss
 * commits. A main session's loss shows in the bot's conversation, and the
 * rotator gives the bot a new one. Runs in the caller's transaction.
 */
export const sessionLoss = (
  sql: SqlClient.SqlClient,
  entries: Entries["Service"],
  ledger: Ledger["Service"],
  workSteps: WorkSteps["Service"],
  signals: Signals["Service"],
) => {
  const { notify } = notices(sql, entries);
  const { finishFold, closeCard } = sessionRecords(sql, entries, workSteps);
  const targets = stopTargets(sql);

  const markLost = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, at: Schema.String }),
    Result: LostRow,
    execute: ({ sessionId, at }) => sql`
      UPDATE sessions SET lost_at = ${at}, admitted_turn_id = NULL, admitted_audience = NULL,
        admitted_room_id = NULL
      WHERE id = ${sessionId} AND lost_at IS NULL
      RETURNING bot_id, purpose
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

  const openTurns = SqlSchema.findAll({
    Request: Schema.String,
    Result: OpenTurn,
    execute: (sessionId) => sql`
      SELECT engine_turn_id, work_fold_entry_id FROM turns
      WHERE session_id = ${sessionId} AND finished_at IS NULL
    `,
  });

  const openRequests = SqlSchema.findAll({
    Request: Schema.String,
    Result: OpenRequest,
    execute: (sessionId) => sql`
      SELECT entry_id, response_json FROM engine_requests
      WHERE session_id = ${sessionId} AND closed_at IS NULL
    `,
  });

  /** Whether the session was recorded lost by this call. */
  const sessionLost = Effect.fn("sessionLoss.sessionLost")(function* (sessionId: SessionRowId) {
    const now = yield* DateTime.now;
    const at = timeText(now);
    const [lost] = yield* markLost({ sessionId, at });
    if (lost === undefined) return false;
    // Settled as they stand: each round keeps what the engine answered for it,
    // a refusal included.
    yield* sql`
      UPDATE stop_targets SET stopped_at = ${at}
      WHERE session_id = ${sessionId} AND stopped_at IS NULL
    `;
    const interrupted: TurnOutcome = { _tag: "interrupted" };
    for (const dispatch of yield* inEngine(sessionId)) {
      if (dispatch.status === "delivered") {
        yield* ledger.finish(dispatch.id, interrupted);
      } else {
        yield* ledger.abandon(
          dispatch.id,
          yield* targets.wakesAfter(dispatch, { _tag: "failed", reason: "unresolved" }),
        );
      }
    }
    const outcome = yield* encodeOutcome(interrupted);
    for (const turn of yield* openTurns(sessionId)) {
      yield* sql`
        UPDATE turns SET finished_at = ${at}, outcome_json = ${outcome}
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turn.engine_turn_id}
      `;
      if (turn.work_fold_entry_id !== null) {
        yield* finishFold(turn.work_fold_entry_id, interrupted, now);
      }
    }
    yield* sql`UPDATE engine_tool_calls SET open = 0 WHERE session_id = ${sessionId}`;
    for (const request of yield* openRequests(sessionId)) yield* closeCard(request, "expired");
    yield* sql`
      UPDATE dispatches SET next_attempt_at = NULL
      WHERE session_id = ${sessionId} AND status = 'intended'
    `;
    if (lost.purpose === "main") {
      yield* notify(lost.bot_id, conversation, { _tag: "session-lost" }, null);
    }
    // What waited on the session may settle, its bot may take work
    // elsewhere, and a main session is replaced.
    yield* sql.afterCommit(
      Effect.all(
        [signals.dispatch.fire, signals.recovery.fire, signals.stops.fire, signals.rotations.fire],
        { discard: true },
      ),
    );
    return true;
  }, Effect.orDie);

  return { sessionLost };
};
