// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type Entry,
  EntryId,
  type FailureClass,
  type HandoffEntry,
  type HandoffState,
  type MessageDelivery,
  type Notice,
  RoomId,
} from "@j3-bots/contracts";
import { type DispatchDisposition, IdempotencyKey, TurnId, TurnOutcome } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { notices, operatorWroteSql } from "./notices.ts";
import { fromBeforeFreshStartSql } from "./rotationRequests.ts";
import {
  AudienceColumn,
  audienceOf,
  DispatchRowId,
  DispatchSeq,
  DispatchStatus,
  SessionRowId,
  WakeFailure,
  WakeKind,
  WakePayload,
  WakeStatus,
} from "./model.ts";

export const DispatchRow = Schema.Struct({
  seq: DispatchSeq,
  id: DispatchRowId,
  bot_id: BotId,
  session_id: SessionRowId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  delivery: Schema.Literals(["start", "steer"]),
  steer_turn_id: Schema.NullOr(TurnId),
  fresh_context: Schema.BooleanFromBit,
  envelope: Schema.String,
  status: DispatchStatus,
  disposition: Schema.NullOr(Schema.Literals(["started", "queued", "steered", "new-turn"])),
  engine_turn_id: Schema.NullOr(TurnId),
  continuation_resumes_at: Schema.NullOr(Time),
  fenced_by_stop_id: Schema.NullOr(Schema.String),
  outcome_json: Schema.NullOr(json(TurnOutcome)),
  attempts: Schema.Int,
  indeterminate_answers: Schema.Int,
  staging_failures: Schema.Int,
  next_attempt_at: Schema.NullOr(Time),
  closed_by: Schema.NullOr(Schema.Literals(["done", "ask", "handoff"])),
  created_at: Time,
});
export type DispatchRow = typeof DispatchRow.Type;

export const DISPATCH_COLUMNS = `
  seq, id, bot_id, session_id, audience, audience_room_id, delivery, steer_turn_id, fresh_context,
  envelope, status, disposition, engine_turn_id, continuation_resumes_at, fenced_by_stop_id,
  outcome_json, attempts, indeterminate_answers, staging_failures, next_attempt_at, closed_by,
  created_at
`;

export const WakeRow = Schema.Struct({
  id: Schema.String,
  bot_id: BotId,
  kind: WakeKind,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  hops: Schema.Int,
  payload_json: json(WakePayload),
  status: WakeStatus,
  source_entry_id: Schema.NullOr(EntryId),
  created_at: Time,
});
export type WakeRow = typeof WakeRow.Type;

export const WAKE_COLUMNS = `
  id, bot_id, kind, audience, audience_room_id, hops, payload_json, status, source_entry_id,
  created_at
`;

/** What becomes of the wakes of a dispatch that ends undelivered. */
export type WakesAfter =
  /** They wait again, for the next dispatch. */
  | { readonly _tag: "pending" }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "failed"; readonly reason: WakeFailure };

/**
 * How the notice of an answer or an opening names why it did not reach the
 * bot: a key never resolved is the engine's to blame, and a room's Stop is
 * the operator's.
 */
const unshownFailure: Record<WakeFailure, FailureClass> = {
  rejected: "unknown",
  unresolved: "engine-unavailable",
  stopped: "stopped",
};

const FailedWake = Schema.Struct({
  id: Schema.String,
  bot_id: BotId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  payload_json: json(WakePayload),
  source_entry_id: Schema.NullOr(EntryId),
});

const encodeOutcome = Schema.encodeEffect(json(TurnOutcome));

/**
 * The dispatches whose failed wakes the engine certainly does not have: a
 * failed wake of any other (one the engine accepted late) may still reach the
 * bot, so its message is not failed, and a retry would send it twice. A
 * released dispatch never has failed wakes: its wakes wait again or are
 * cancelled.
 */
export const UNDELIVERED: ReadonlyArray<DispatchStatus> = ["failed", "dropped"];

/**
 * Whether the teammate message whose received card is `entry` reached its
 * recipient: a turn started with an envelope that carried it, as a wake of
 * the urgent message or its Retry, or as a held message. Such a message is
 * `sent` whatever else became of it, and never offered again.
 */
const handoffReadSql = (sql: SqlClient.SqlClient, entry: Statement.Fragment) => sql`(
  EXISTS (
    SELECT 1 FROM wakes r LEFT JOIN dispatches rd ON rd.id = r.dispatch_id
    WHERE r.source_entry_id = ${entry}
      AND (r.status = 'finished' OR rd.status IN ('delivered', 'finished'))
  )
  OR EXISTS (
    SELECT 1 FROM held_messages m JOIN dispatches md ON md.id = m.consumed_dispatch_id
    WHERE m.handoff_entry_id = ${entry} AND md.status IN ('delivered', 'finished')
  )
)`;

/** A dispatch whose recovery gave up: it may have landed, and nothing will tell. */
const mayHaveLandedSql = (sql: SqlClient.SqlClient, dispatch: Statement.Fragment) => sql`
  EXISTS (
    SELECT 1 FROM dispatches u
    WHERE u.id = ${dispatch} AND u.status = 'failed' AND u.failure_reason = 'unresolved'
  )
`;

const sameDelivery = (a: MessageDelivery, b: MessageDelivery): boolean =>
  a._tag === "failed" ? b._tag === "failed" && a.reason === b.reason : a._tag === b._tag;

/**
 * The state of dispatches and their wakes, and the delivery each message shows
 * because of them. Every write runs in the caller's transaction, so a change
 * to a dispatch, its wakes and the entries that show them commit together.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly find: (dispatchId: DispatchRowId) => Effect.Effect<Option.Option<DispatchRow>>;
    readonly wakesOf: (dispatchId: DispatchRowId) => Effect.Effect<ReadonlyArray<WakeRow>>;
    /**
     * The engine took the key: an undecided dispatch, or a failed one the
     * engine turns out to have applied, becomes accepted. A first answer's
     * disposition is kept, and only the first, on a dispatch the engine has.
     */
    readonly accept: (
      dispatchId: DispatchRowId,
      disposition: DispatchDisposition | null,
    ) => Effect.Effect<void>;
    /**
     * Its turn started (or, for a steer, it was taken): also after it failed,
     * which a late delivery undoes, and, when no Stop fenced it, after its
     * wakes were cancelled, since the bot read them all the same.
     */
    readonly deliver: (dispatchId: DispatchRowId, turnId: TurnId) => Effect.Effect<void>;
    /** Its work is over, with the turn's outcome; its wakes finish. */
    readonly finish: (dispatchId: DispatchRowId, outcome: TurnOutcome) => Effect.Effect<void>;
    /**
     * The bot closed the delivery of the turn a delivered dispatch owns (`say`
     * with `done`, or `ask`): its wakes are finished, and no `undelivered`
     * wake follows its turn. The dispatch itself finishes with that turn.
     */
    readonly closeDelivery: (dispatchId: DispatchRowId, by: "done" | "ask") => Effect.Effect<void>;
    /** Delivered, with the turn's work not over: the engine will continue it at `resumesAt`. */
    readonly awaitContinuation: (
      dispatchId: DispatchRowId,
      outcome: TurnOutcome,
      resumesAt: DateTime.Utc,
    ) => Effect.Effect<void>;
    /**
     * The engine resumed the pending continuation of its turn as `turnId`:
     * the dispatch's work goes on in that turn, also one that ends before it
     * starts.
     */
    readonly followContinuation: (dispatchId: DispatchRowId, turnId: TurnId) => Effect.Effect<void>;
    /**
     * A Stop ended it in the engine before delivery: a cancelled waiting turn
     * (`turnId`), a dropped steer (the turn it was to ride). The bot never
     * read its envelope, so its catch-up notes and held messages go to the
     * next one. Also a turn the engine ended before it started for another
     * reason, a provider's failure say, whose `outcome` the dispatch keeps.
     * Whether it was still the engine's to drop.
     */
    readonly drop: (
      dispatchId: DispatchRowId,
      turnId: TurnId,
      wakes: WakesAfter,
      outcome: TurnOutcome | null,
    ) => Effect.Effect<boolean>;
    /**
     * The engine certainly applied nothing: it may be sent again as new
     * dispatches, and the catch-up notes and held messages its envelope
     * carried go to the next one. Whether it was still undecided.
     */
    readonly release: (dispatchId: DispatchRowId, wakes: WakesAfter) => Effect.Effect<boolean>;
    /**
     * It will not be delivered. Terminal, until a late delivery shows
     * otherwise. The catch-up notes and held messages its envelope carried
     * stay consumed: the engine may have them. Whether it was still undecided.
     */
    readonly fail: (
      dispatchId: DispatchRowId,
      reason: "rejected" | "unresolved",
      wakes: WakesAfter,
    ) => Effect.Effect<boolean>;
    /**
     * The engine had it and its session is gone before its turn started: it
     * fails as `unresolved`, as `fail` does. Whether it was still accepted.
     */
    readonly abandon: (dispatchId: DispatchRowId, wakes: WakesAfter) => Effect.Effect<boolean>;
    /**
     * Whether a notice that the dispatch was not delivered may send its answer,
     * or the bot's opening, again: the engine has not got the dispatch and
     * never delivered it (it failed, or the engine dropped it before its turn
     * started), and that wake failed and was not sent again yet. An opening
     * is not sent again once the operator has written.
     */
    readonly undeliveredRetryable: (dispatchId: DispatchRowId) => Effect.Effect<boolean>;
    /**
     * Pending wakes stop waiting: a Stop or an archival ended what they asked
     * for. A teammate's urgent message the recipient's Stop cancelled waits
     * on as a held message (`holdUnread`).
     */
    readonly cancelWakes: (wakeIds: ReadonlyArray<string>) => Effect.Effect<void>;
    /**
     * Shows the delivery of each message the wakes came from, as their wakes
     * now stand: an operator's message, or a teammate's, on both its cards
     * (`handoffStateOf`).
     */
    readonly refreshMessages: (entryIds: ReadonlyArray<EntryId>) => Effect.Effect<void>;
    /**
     * The dispatch's wakes of teammate messages that reached the recipient
     * otherwise, as by another wake that landed late: never sent again.
     */
    readonly readHandoffWakes: (dispatchId: DispatchRowId) => Effect.Effect<ReadonlySet<string>>;
    /**
     * Held teammate messages, by their received cards, that a Stop removed
     * before the recipient read them: both cards of each show it.
     */
    readonly heldStopped: (entryIds: ReadonlyArray<EntryId>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/turns/Ledger") {}

export const layer = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = yield* Entries;
    const ids = yield* Ids;
    const { notify } = notices(sql, entries);

    const findRow = SqlSchema.findOneOption({
      Request: DispatchRowId,
      Result: DispatchRow,
      execute: (id) =>
        sql`SELECT ${sql.literal(DISPATCH_COLUMNS)} FROM dispatches WHERE id = ${id}`,
    });
    const find = (dispatchId: DispatchRowId) => findRow(dispatchId).pipe(Effect.orDie);

    const wakeRows = SqlSchema.findAll({
      Request: DispatchRowId,
      Result: WakeRow,
      execute: (id) => sql`
        SELECT ${sql.literal(WAKE_COLUMNS)} FROM wakes WHERE dispatch_id = ${id}
        ORDER BY priority, rowid
      `,
    });
    const wakesOf = (dispatchId: DispatchRowId) => wakeRows(dispatchId).pipe(Effect.orDie);

    const now = Effect.map(DateTime.now, timeText);

    const sourcesOf = Effect.fn("Ledger.sourcesOf")(function* (dispatchId: DispatchRowId) {
      const rows = yield* sql<{ readonly source_entry_id: string }>`
        SELECT DISTINCT source_entry_id FROM wakes
        WHERE dispatch_id = ${dispatchId} AND source_entry_id IS NOT NULL
      `;
      return rows.map((row) => EntryId.make(row.source_entry_id));
    }, Effect.orDie);

    const DeliveryRow = Schema.Struct({
      status: WakeStatus,
      failure_reason: Schema.NullOr(WakeFailure),
      dispatch_status: Schema.NullOr(DispatchStatus),
    });
    const deliveryRows = SqlSchema.findAll({
      Request: EntryId,
      Result: DeliveryRow,
      execute: (entryId) => sql`
        SELECT w.status, w.failure_reason, d.status AS dispatch_status
        FROM wakes w LEFT JOIN dispatches d ON d.id = w.dispatch_id
        WHERE w.source_entry_id = ${entryId}
          AND NOT EXISTS (SELECT 1 FROM wakes r WHERE r.retry_of = w.id)
      `,
    });

    /** A message's delivery, from the wakes that carry it and nothing has retried. */
    const deliveryOf = (
      rows: ReadonlyArray<typeof DeliveryRow.Type>,
    ): MessageDelivery | undefined => {
      if (rows.length === 0) return undefined;
      let delivered = 0;
      let cancelled = 0;
      for (const row of rows) {
        if (
          row.status === "failed" &&
          row.failure_reason !== null &&
          row.dispatch_status !== null &&
          UNDELIVERED.includes(row.dispatch_status)
        ) {
          return { _tag: "failed", reason: row.failure_reason };
        }
        if (row.status === "cancelled") cancelled++;
        else if (
          row.status === "finished" ||
          (row.status === "dispatched" &&
            (row.dispatch_status === "delivered" || row.dispatch_status === "finished"))
        ) {
          delivered++;
        }
      }
      if (delivered === rows.length) return { _tag: "delivered" };
      if (delivered + cancelled === rows.length) return { _tag: "cancelled" };
      return { _tag: "pending" };
    };

    const sentCardRow = SqlSchema.findOneOption({
      Request: EntryId,
      Result: Schema.Struct({ sent_entry_id: Schema.NullOr(EntryId) }),
      execute: (received) => sql`
        SELECT sent_entry_id FROM handoffs WHERE received_entry_id = ${received}
      `,
    });

    /** The sender's card of the teammate message whose received card this is. */
    const sentCardOf = Effect.fn("Ledger.sentCardOf")(function* (received: EntryId) {
      const row = yield* sentCardRow(received);
      if (Option.isNone(row) || row.value.sent_entry_id === null) return null;
      const found = yield* entries.find(row.value.sent_entry_id);
      return Option.isSome(found) && found.value.entry._tag === "handoff"
        ? found.value.entry
        : null;
    }, Effect.orDie);

    /** Both cards of the teammate message whose received card this is show `state`. */
    const showHandoff = Effect.fn("Ledger.showHandoff")(function* (
      received: HandoffEntry,
      state: HandoffState,
    ) {
      for (const card of [received, yield* sentCardOf(received.id)]) {
        if (card !== null && card.state !== state) yield* entries.update({ ...card, state });
      }
    });

    const HandoffFacts = Schema.Struct({
      read: Schema.BooleanFromBit,
      held: Schema.BooleanFromBit,
      held_unconfirmed: Schema.BooleanFromBit,
      stopped: Schema.BooleanFromBit,
      cancelled_unconfirmed: Schema.BooleanFromBit,
    });
    const handoffFacts = SqlSchema.findAll({
      Request: EntryId,
      Result: HandoffFacts,
      execute: (received) => sql`
        SELECT
          ${handoffReadSql(sql, sql`${received}`)} AS read,
          EXISTS (SELECT 1 FROM held_messages WHERE handoff_entry_id = ${received}) AS held,
          EXISTS (
            SELECT 1 FROM held_messages m
            WHERE m.handoff_entry_id = ${received}
              AND ${mayHaveLandedSql(sql, sql.literal("m.consumed_dispatch_id"))}
          ) AS held_unconfirmed,
          EXISTS (
            SELECT 1 FROM handoffs WHERE received_entry_id = ${received} AND stop_id IS NOT NULL
          ) AS stopped,
          EXISTS (
            SELECT 1 FROM wakes c
            WHERE c.source_entry_id = ${received} AND c.status = 'cancelled'
              AND ${mayHaveLandedSql(sql, sql.literal("c.dispatch_id"))}
          ) AS cancelled_unconfirmed
      `,
    });

    /**
     * Where a teammate message stands, the same on both its cards; `null`
     * when nothing of it is left to tell, as for a held message a Stop
     * removed (`heldStopped`). Read: `sent`. Held, and so not lost: `sent`,
     * or `unconfirmed` once the dispatch that carried it ended with nothing
     * to tell whether the engine took it; it is not carried again. Otherwise
     * from the wakes of the urgent message no Retry replaced: failed
     * undelivered is `not-delivered`; all cancelled is `stopped` when the
     * sender's Stop ended it, `unconfirmed` when one went in such a dispatch.
     */
    const handoffStateOf = Effect.fn("Ledger.handoffStateOf")(function* (received: EntryId) {
      const [facts] = yield* handoffFacts(received);
      if (facts === undefined) return null;
      if (facts.read) return "sent";
      if (facts.held) return facts.held_unconfirmed ? "unconfirmed" : "sent";
      const delivery = deliveryOf(yield* deliveryRows(received));
      if (delivery === undefined) return null;
      switch (delivery._tag) {
        case "pending":
        case "delivered":
          return "sent";
        case "failed":
          return "not-delivered";
        case "cancelled":
          return !facts.stopped && facts.cancelled_unconfirmed ? "unconfirmed" : "stopped";
      }
    }, Effect.orDie);

    const refreshMessages = Effect.fn("Ledger.refreshMessages")(function* (
      entryIds: ReadonlyArray<EntryId>,
    ) {
      for (const entryId of new Set(entryIds)) {
        const found = yield* entries.find(entryId);
        if (Option.isNone(found)) continue;
        const shown = found.value.entry;
        if (shown._tag === "handoff") {
          const state = yield* handoffStateOf(entryId);
          if (state !== null) yield* showHandoff(shown, state);
          continue;
        }
        if (shown._tag !== "message") continue;
        const delivery = deliveryOf(yield* deliveryRows(entryId).pipe(Effect.orDie));
        if (delivery !== undefined && !sameDelivery(delivery, shown.delivery)) {
          yield* entries.update({ ...shown, delivery });
        }
      }
    });

    /** Shows where each held message the dispatch's envelope carried stands. */
    const refreshHeld = Effect.fn("Ledger.refreshHeld")(function* (dispatchId: DispatchRowId) {
      const rows = yield* sql<{ readonly handoff_entry_id: string }>`
        SELECT handoff_entry_id FROM held_messages
        WHERE consumed_dispatch_id = ${dispatchId} AND handoff_entry_id IS NOT NULL
      `;
      yield* refreshMessages(rows.map((row) => EntryId.make(row.handoff_entry_id)));
    }, Effect.orDie);

    /**
     * A teammate's urgent message whose wake was cancelled before the engine
     * had it, by the recipient's Stop and not the sender's, waits on as a
     * held message: the recipient's next envelope carries it, once, and its
     * cards stay `sent`. Not one a turn read already, nor one held already.
     */
    const holdUnread = Effect.fn("Ledger.holdUnread")(function* (wakes: Statement.Fragment) {
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ bot_id: BotId, hops: Schema.Int, received_entry_id: EntryId }),
        execute: () => sql`
          SELECT w.bot_id, MAX(w.hops) AS hops, h.received_entry_id
          FROM wakes w JOIN handoffs h ON h.received_entry_id = w.source_entry_id
          WHERE ${wakes} AND w.status = 'cancelled' AND w.kind = 'bot'
            AND json_extract(w.payload_json, '$._tag') = 'teammate' AND h.stop_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM held_messages m WHERE m.handoff_entry_id = h.received_entry_id)
            AND NOT ${handoffReadSql(sql, sql.literal("h.received_entry_id"))}
          GROUP BY w.bot_id, h.received_entry_id
        `,
      })(undefined);
      for (const row of rows) {
        const found = yield* entries.find(row.received_entry_id);
        if (Option.isNone(found) || found.value.entry._tag !== "handoff") continue;
        const card = found.value.entry;
        yield* sql`
          INSERT INTO held_messages (
            id, recipient_bot_id, sender_bot_id, handoff_entry_id, text, hops, created_at
          ) VALUES (
            ${yield* ids.make("held")}, ${row.bot_id}, ${card.author.botId}, ${card.id},
            ${card.text}, ${row.hops}, ${timeText(card.createdAt)}
          )
        `;
      }
    }, Effect.orDie);

    const heldStopped = Effect.fn("Ledger.heldStopped")(function* (
      entryIds: ReadonlyArray<EntryId>,
    ) {
      for (const entryId of new Set(entryIds)) {
        const found = yield* entries.find(entryId);
        if (Option.isSome(found) && found.value.entry._tag === "handoff") {
          yield* showHandoff(found.value.entry, "stopped");
        }
      }
    });

    const undeliveredRetryable = Effect.fn("Ledger.undeliveredRetryable")(function* (
      dispatchId: DispatchRowId,
    ) {
      const rows = yield* sql<{ readonly n: number }>`
        SELECT 1 AS n FROM dispatches d
        WHERE d.id = ${dispatchId} AND ${sql.in("d.status", UNDELIVERED)}
          AND EXISTS (
            SELECT 1 FROM wakes w
            WHERE w.dispatch_id = d.id AND w.status = 'failed'
              AND (
                json_extract(w.payload_json, '$._tag') = 'answer'
                OR (
                  json_extract(w.payload_json, '$._tag') = 'teammate'
                  AND NOT ${handoffReadSql(sql, sql.literal("w.source_entry_id"))}
                )
                OR (
                  json_extract(w.payload_json, '$._tag') = 'first-run'
                  AND NOT ${operatorWroteSql(sql, sql.literal("w.bot_id"))}
                )
              )
              AND NOT EXISTS (SELECT 1 FROM wakes r WHERE r.retry_of = w.id)
          )
      `;
      return rows.length > 0;
    }, Effect.orDie);

    /** The notices that offer a retry of the dispatch's undelivered wakes. */
    const undeliveredNotices = Effect.fn("Ledger.undeliveredNotices")(function* (
      dispatchId: DispatchRowId,
    ) {
      const rows = yield* sql<{ readonly entry_id: string }>`
        SELECT entry_id FROM notice_retries
        WHERE dispatch_id = ${dispatchId} AND reason = 'undelivered'
      `;
      const shown: Array<Extract<Entry, { readonly _tag: "notice" }>> = [];
      for (const row of rows) {
        const found = yield* entries.find(EntryId.make(row.entry_id));
        if (Option.isSome(found) && found.value.entry._tag === "notice") {
          shown.push(found.value.entry);
        }
      }
      return shown;
    }, Effect.orDie);

    /**
     * A notice that the dispatch was not delivered offers a retry exactly
     * while `undeliveredRetryable` holds, read again after every change to the
     * dispatch or its wakes: never while the engine may still have the
     * answer or once it delivered it, which would send it twice, and again
     * once the engine dropped it undelivered.
     */
    const refreshNotices = Effect.fn("Ledger.refreshNotices")(function* (
      dispatchId: DispatchRowId,
    ) {
      const shown = yield* undeliveredNotices(dispatchId);
      if (shown.length === 0) return;
      const retryable = yield* undeliveredRetryable(dispatchId);
      for (const entry of shown) {
        if (entry.retryable !== retryable) yield* entries.update({ ...entry, retryable });
      }
    }, Effect.orDie);

    const failedWakes = SqlSchema.findAll({
      Request: Schema.Struct({ dispatchId: DispatchRowId, reason: WakeFailure, at: Schema.String }),
      Result: FailedWake,
      execute: ({ dispatchId, reason, at }) => sql`
        UPDATE wakes SET status = 'failed', failure_reason = ${reason}, updated_at = ${at}
        WHERE dispatch_id = ${dispatchId} AND status IN ('dispatched', 'failed')
        RETURNING id, bot_id, audience, audience_room_id, payload_json, source_entry_id
      `,
    });

    /**
     * The failure notice of a teammate's urgent messages, in the recipient's
     * conversation, naming each sender: `null` when the wakes carry none.
     */
    const handoffNotice = Effect.fn("Ledger.handoffNotice")(function* (
      wakes: ReadonlyArray<typeof FailedWake.Type>,
    ) {
      const senders: Array<BotId> = [];
      for (const wake of wakes) {
        if (wake.payload_json._tag !== "teammate") continue;
        const card = yield* entries.find(wake.payload_json.entryId);
        if (Option.isNone(card) || card.value.entry._tag !== "handoff") continue;
        const sender = card.value.entry.author.botId;
        if (!senders.includes(sender)) senders.push(sender);
      }
      const [first, ...rest] = senders;
      return first === undefined
        ? null
        : ({ _tag: "handoff-failed", senders: [first, ...rest] } satisfies Notice);
    });

    /**
     * Wakes of the dispatch that a teammate's Stopped work caused are
     * cancelled instead of waiting again or failing: the Stop that covered
     * the sender's work covers what it sent (`Stops.record`). The operator's
     * Retry of one is the operator's own word, which no Stop of the sender
     * cancels.
     */
    const cancelStoppedHandoffs = (dispatchId: DispatchRowId, at: string) =>
      sql`
        UPDATE wakes SET status = 'cancelled', failure_reason = NULL, updated_at = ${at}
        WHERE dispatch_id = ${dispatchId} AND status IN ('dispatched', 'failed')
          AND retry_of IS NULL AND source_entry_id IN (
            SELECT received_entry_id FROM handoffs WHERE stop_id IS NOT NULL
          )
      `;

    /**
     * Wakes of a dispatch that will not run to its end, as `after` says.
     * `unread`: the engine certainly never applied it, so a teammate's urgent
     * message it cancels waits on as a held one (`holdUnread`).
     */
    const setWakes = Effect.fn("Ledger.setWakes")(function* (
      dispatchId: DispatchRowId,
      after: WakesAfter,
      unread: boolean,
    ) {
      const at = yield* now;
      const sources = yield* sourcesOf(dispatchId);
      if (after._tag !== "cancelled") yield* cancelStoppedHandoffs(dispatchId, at);
      switch (after._tag) {
        case "pending":
          yield* sql`
            UPDATE wakes SET status = 'pending', failure_reason = NULL, dispatch_id = NULL,
              updated_at = ${at}
            WHERE dispatch_id = ${dispatchId} AND status = 'dispatched'
          `;
          break;
        case "cancelled":
          yield* sql`
            UPDATE wakes SET status = 'cancelled', failure_reason = NULL, updated_at = ${at}
            WHERE dispatch_id = ${dispatchId} AND status IN ('dispatched', 'failed')
          `;
          if (unread) yield* holdUnread(sql`w.dispatch_id = ${dispatchId}`);
          break;
        case "failed": {
          // Wakes the dispatch failed with before, when the engine took it
          // late, fail again with this reason.
          const all = yield* failedWakes({ dispatchId, reason: after.reason, at });
          // A teammate's message another wake or its held copy brought to the
          // recipient is not shown as failed, nor offered again.
          const read = yield* readHandoffWakes(dispatchId);
          const failed = all.filter((wake) => !read.has(wake.id));
          // An answer, a new bot's opening, or a teammate's urgent message
          // has no message of the operator's to show its failure on: a
          // retryable notice does, where it was for. One that failed before
          // keeps the notice it has, which now shows this failure.
          const unshown = failed.find(
            (wake) =>
              wake.payload_json._tag === "answer" ||
              wake.payload_json._tag === "first-run" ||
              wake.payload_json._tag === "teammate",
          );
          if (unshown !== undefined) {
            const notice: Notice = (yield* handoffNotice(failed)) ?? {
              _tag: "turn-failed",
              failure: unshownFailure[after.reason],
            };
            const shown = yield* undeliveredNotices(dispatchId);
            if (shown.length === 0) {
              yield* notify(unshown.bot_id, audienceOf(unshown), notice, {
                dispatchId,
                reason: "undelivered",
              });
            }
            for (const entry of shown) yield* entries.update({ ...entry, notice });
          }
          break;
        }
      }
      yield* refreshNotices(dispatchId);
      yield* refreshMessages(sources);
      yield* refreshHeld(dispatchId);
    }, Effect.orDie);

    const readHandoffWakes = Effect.fn("Ledger.readHandoffWakes")(function* (
      dispatchId: DispatchRowId,
    ) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT w.id FROM wakes w
        WHERE w.dispatch_id = ${dispatchId}
          AND json_extract(w.payload_json, '$._tag') = 'teammate'
          AND ${handoffReadSql(sql, sql.literal("w.source_entry_id"))}
      `;
      return new Set(rows.map((row) => row.id));
    }, Effect.orDie);

    /**
     * The catch-up notes and held messages its envelope carried go to the next
     * one: the engine certainly never applied it. A digest is for the session
     * its dispatch was written into: once
     * that session is lost or retired, the rotation that replaces it writes
     * the digest for the next one (or, for a fresh start, none), so the one
     * carried here is dropped, and a bot never has two waiting. A note of what
     * was said before the bot's latest fresh start is dropped too.
     */
    const returnConsumed = Effect.fn("Ledger.returnConsumed")(function* (
      dispatchId: DispatchRowId,
    ) {
      yield* sql`
        DELETE FROM catch_up_notes
        WHERE consumed_dispatch_id = ${dispatchId}
          AND json_extract(note_json, '$._tag') = 'session-rotated'
          AND EXISTS (
            SELECT 1 FROM dispatches d JOIN sessions s ON s.id = d.session_id
            WHERE d.id = ${dispatchId} AND (s.retired_at IS NOT NULL OR s.lost_at IS NOT NULL)
          )
      `;
      yield* sql`
        DELETE FROM catch_up_notes
        WHERE consumed_dispatch_id = ${dispatchId} AND ${fromBeforeFreshStartSql(sql)}
      `;
      yield* sql`UPDATE catch_up_notes SET consumed_dispatch_id = NULL WHERE consumed_dispatch_id = ${dispatchId}`;
      // A message whose sender's work a Stop covered since waits no more.
      const stopped = yield* sql<{ readonly handoff_entry_id: string }>`
        DELETE FROM held_messages
        WHERE consumed_dispatch_id = ${dispatchId} AND handoff_entry_id IN (
          SELECT received_entry_id FROM handoffs WHERE stop_id IS NOT NULL
        )
        RETURNING handoff_entry_id
      `;
      yield* heldStopped(stopped.map((row) => EntryId.make(row.handoff_entry_id)));
      const returned = yield* sql<{ readonly handoff_entry_id: string | null }>`
        UPDATE held_messages SET consumed_dispatch_id = NULL WHERE consumed_dispatch_id = ${dispatchId}
        RETURNING handoff_entry_id
      `;
      yield* refreshMessages(
        returned.flatMap((row) =>
          row.handoff_entry_id === null ? [] : [EntryId.make(row.handoff_entry_id)],
        ),
      );
    }, Effect.orDie);

    const accept = Effect.fn("Ledger.accept")(function* (
      dispatchId: DispatchRowId,
      disposition: DispatchDisposition | null,
    ) {
      const at = yield* now;
      yield* sql`
        UPDATE dispatches SET status = 'accepted', failure_reason = NULL,
          next_attempt_at = NULL, updated_at = ${at}
        WHERE id = ${dispatchId} AND status IN ('intended', 'failed')
      `;
      yield* refreshNotices(dispatchId);
      yield* refreshMessages(yield* sourcesOf(dispatchId));
      yield* refreshHeld(dispatchId);
      if (disposition !== null) {
        // The first answer only, and only on a dispatch the engine has: the
        // events may already have moved the turn on, or a Stop ended it.
        yield* sql`
          UPDATE dispatches SET disposition = ${disposition._tag},
            disposition_turn_id = ${disposition.turnId},
            engine_turn_id = COALESCE(engine_turn_id, ${disposition.turnId})
          WHERE id = ${dispatchId} AND disposition IS NULL
            AND status IN ('accepted', 'delivered', 'finished', 'dropped')
        `;
      }
    }, Effect.orDie);

    const deliver = Effect.fn("Ledger.deliver")(function* (
      dispatchId: DispatchRowId,
      turnId: TurnId,
    ) {
      const at = yield* now;
      yield* sql`
        UPDATE dispatches SET status = 'delivered', failure_reason = NULL, engine_turn_id = ${turnId},
          next_attempt_at = NULL, updated_at = ${at}
        WHERE id = ${dispatchId} AND status IN ('intended', 'accepted', 'failed')
      `;
      // A late delivery: the wakes it failed with were delivered after all.
      // So were those cancelled while it was undecided, when no Stop fenced
      // it: the engine started its turn, so its wakes were read, and nothing
      // ends that turn. A Stop that fenced it ends that turn, and its wakes
      // stay cancelled; a teammate's message among them was read all the
      // same, and shows `sent` (`handoffReadSql`).
      yield* sql`
        UPDATE wakes SET status = 'dispatched', failure_reason = NULL, updated_at = ${at}
        WHERE dispatch_id = ${dispatchId} AND (
          status = 'failed' OR (
            status = 'cancelled' AND EXISTS (
              SELECT 1 FROM dispatches WHERE id = ${dispatchId} AND fenced_by_stop_id IS NULL
            )
          )
        )
      `;
      yield* refreshNotices(dispatchId);
      yield* refreshMessages(yield* sourcesOf(dispatchId));
      yield* refreshHeld(dispatchId);
    }, Effect.orDie);

    const finish = Effect.fn("Ledger.finish")(function* (
      dispatchId: DispatchRowId,
      outcome: TurnOutcome,
    ) {
      const at = yield* now;
      const encoded = yield* encodeOutcome(outcome);
      yield* sql`
        UPDATE dispatches SET status = 'finished', outcome_json = ${encoded},
          continuation_resumes_at = NULL, updated_at = ${at}
        WHERE id = ${dispatchId}
      `;
      yield* sql`
        UPDATE wakes SET status = 'finished', failure_reason = NULL, updated_at = ${at}
        WHERE dispatch_id = ${dispatchId} AND status IN ('dispatched', 'failed')
      `;
      yield* refreshNotices(dispatchId);
      yield* refreshMessages(yield* sourcesOf(dispatchId));
    }, Effect.orDie);

    const closeDelivery = Effect.fn("Ledger.closeDelivery")(function* (
      dispatchId: DispatchRowId,
      by: "done" | "ask",
    ) {
      const at = yield* now;
      // Only a delivered dispatch: a steer still riding undecided may yet be dropped.
      const closed = yield* sql`
        UPDATE dispatches SET closed_by = COALESCE(closed_by, ${by}), updated_at = ${at}
        WHERE id = ${dispatchId} AND status = 'delivered'
        RETURNING id
      `;
      if (closed.length === 0) return;
      yield* sql`
        UPDATE wakes SET status = 'finished', failure_reason = NULL, updated_at = ${at}
        WHERE dispatch_id = ${dispatchId} AND status IN ('dispatched', 'failed')
      `;
      yield* refreshMessages(yield* sourcesOf(dispatchId));
    }, Effect.orDie);

    const awaitContinuation = Effect.fn("Ledger.awaitContinuation")(function* (
      dispatchId: DispatchRowId,
      outcome: TurnOutcome,
      resumesAt: DateTime.Utc,
    ) {
      yield* sql`
        UPDATE dispatches SET outcome_json = ${yield* encodeOutcome(outcome)},
          continuation_resumes_at = ${timeText(resumesAt)}, updated_at = ${yield* now}
        WHERE id = ${dispatchId} AND status = 'delivered'
      `;
    }, Effect.orDie);

    const followContinuation = Effect.fn("Ledger.followContinuation")(function* (
      dispatchId: DispatchRowId,
      turnId: TurnId,
    ) {
      yield* sql`
        UPDATE dispatches SET engine_turn_id = ${turnId}, continuation_resumes_at = NULL,
          updated_at = ${yield* now}
        WHERE id = ${dispatchId} AND status = 'delivered' AND continuation_resumes_at IS NOT NULL
      `;
    }, Effect.orDie);

    const drop = Effect.fn("Ledger.drop")(function* (
      dispatchId: DispatchRowId,
      turnId: TurnId,
      wakes: WakesAfter,
      outcome: TurnOutcome | null,
    ) {
      const encoded = outcome === null ? null : yield* encodeOutcome(outcome);
      const dropped = yield* sql`
        UPDATE dispatches SET status = 'dropped', engine_turn_id = COALESCE(engine_turn_id, ${turnId}),
          outcome_json = ${encoded}, next_attempt_at = NULL, updated_at = ${yield* now}
        WHERE id = ${dispatchId} AND status IN ('accepted', 'delivered')
        RETURNING id
      `;
      if (dropped.length === 0) return false;
      yield* returnConsumed(dispatchId);
      yield* setWakes(dispatchId, wakes, true);
      return true;
    }, Effect.orDie);

    const release = Effect.fn("Ledger.release")(function* (
      dispatchId: DispatchRowId,
      wakes: WakesAfter,
    ) {
      const released = yield* sql`
        UPDATE dispatches SET status = 'released', next_attempt_at = NULL, updated_at = ${yield* now}
        WHERE id = ${dispatchId} AND status = 'intended'
        RETURNING id
      `;
      if (released.length === 0) return false;
      yield* returnConsumed(dispatchId);
      yield* setWakes(dispatchId, wakes, true);
      return true;
    }, Effect.orDie);

    const fail = Effect.fn("Ledger.fail")(function* (
      dispatchId: DispatchRowId,
      reason: "rejected" | "unresolved",
      wakes: WakesAfter,
    ) {
      const failed = yield* sql`
        UPDATE dispatches SET status = 'failed', failure_reason = ${reason}, next_attempt_at = NULL,
          updated_at = ${yield* now}
        WHERE id = ${dispatchId} AND status = 'intended'
        RETURNING id
      `;
      if (failed.length === 0) return false;
      // A rejected dispatch was never applied, so what it carried was never
      // seen; an unresolved one may have been.
      if (reason === "rejected") yield* returnConsumed(dispatchId);
      yield* setWakes(dispatchId, wakes, reason === "rejected");
      return true;
    }, Effect.orDie);

    const abandon = Effect.fn("Ledger.abandon")(function* (
      dispatchId: DispatchRowId,
      wakes: WakesAfter,
    ) {
      const failed = yield* sql`
        UPDATE dispatches SET status = 'failed', failure_reason = 'unresolved',
          next_attempt_at = NULL, updated_at = ${yield* now}
        WHERE id = ${dispatchId} AND status = 'accepted'
        RETURNING id
      `;
      if (failed.length === 0) return false;
      yield* setWakes(dispatchId, wakes, false);
      return true;
    }, Effect.orDie);

    const cancelWakes = Effect.fn("Ledger.cancelWakes")(function* (wakeIds: ReadonlyArray<string>) {
      if (wakeIds.length === 0) return;
      const sources = yield* sql<{ readonly id: string; readonly source_entry_id: string | null }>`
        UPDATE wakes SET status = 'cancelled', updated_at = ${yield* now}
        WHERE ${sql.in("id", wakeIds)} AND status = 'pending'
        RETURNING id, source_entry_id
      `;
      if (sources.length > 0) {
        yield* holdUnread(
          sql.in(
            "w.id",
            sources.map((row) => row.id),
          ),
        );
      }
      yield* refreshMessages(
        sources.flatMap((row) =>
          row.source_entry_id === null ? [] : [EntryId.make(row.source_entry_id)],
        ),
      );
    }, Effect.orDie);

    return Ledger.of({
      find,
      wakesOf,
      accept,
      deliver,
      finish,
      closeDelivery,
      awaitContinuation,
      followContinuation,
      drop,
      release,
      fail,
      abandon,
      undeliveredRetryable,
      cancelWakes,
      refreshMessages,
      readHandoffWakes,
      heldStopped,
    });
  }),
);

/** The engine key of a dispatch: its id, which the adapter derives every engine id from. */
export const keyOf = (dispatchId: DispatchRowId): IdempotencyKey => IdempotencyKey.make(dispatchId);

/**
 * The dispatch a key the engine reports names, if it is one: keys are global,
 * so a key that is not a dispatch id finds no row.
 */
export const dispatchOfKey = (key: IdempotencyKey): DispatchRowId => DispatchRowId.make(key);
