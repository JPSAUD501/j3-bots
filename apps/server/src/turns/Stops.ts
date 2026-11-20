// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandId,
  type Conflict,
  EntryId,
  NotFound,
  type RoomId,
} from "@j3-bots/contracts";
import { Engine, IdempotencyKey, SessionId } from "@j3-bots/engine-t3";
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
import { timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { RoomWork } from "../rooms/RoomWork.ts";
import { Ledger } from "./Ledger.ts";
import { DispatchRowId, SessionRowId } from "./model.ts";
import { notices } from "./notices.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { SessionGate } from "./SessionGate.ts";
import { Signals } from "./Signals.ts";
import { stopKey, stopTargets } from "./stopTargets.ts";

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
});
type Round = typeof Round.Type;

const Fenced = Schema.Struct({
  id: DispatchRowId,
  attempts: Schema.Int,
  in_scope: Schema.BooleanFromBit,
});

/** How one session's Stop work went in a pass of the runner. */
type Progress = "done" | "waiting" | "unavailable";

/**
 * The operator's Stop (`docs/architecture/server.md`, Stop): recorded in one
 * transaction with its targets, fences and cancelled wakes. Then, per target
 * session: once recovery has settled its fenced dispatches, each latest round
 * is sent through the session's gate, which only acknowledges it; the
 * session's events are then synchronized past that acknowledgment, which
 * marks the round observed. A target is confirmed only from events applied
 * once all its latest rounds are observed, never from what the server knew
 * before.
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
    /**
     * Sends again the latest round of every unconfirmed target, with its key,
     * before the sessions' events are opened: after either process restarted
     * or the engine came back. Each is observed anew. Whether the engine took
     * them all.
     */
    readonly resendUnconfirmed: Effect.Effect<boolean>;
    /** One pass of the runner over every unsettled target. Whether the engine took it all. */
    readonly runPending: Effect.Effect<boolean>;
    /** The runner, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/Stops") {}

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
    const { sessionLost } = notices(sql, yield* Entries);

    /** Whether an audience column pair is in a Stop's scope. */
    const inScope = (scope: StopScope) =>
      scope._tag === "bot"
        ? sql`1`
        : sql`(audience = 'room' AND audience_room_id = ${scope.roomId})`;

    const record = Effect.fn("Stops.record")(function* (botId: BotId, scope: StopScope) {
      const at = timeText(yield* DateTime.now);
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
            )
          )
        )
      `;
      const sessionIds = sessions.map((s) => s.id);
      // A dispatch in scope never sent is fenced even when no session needs
      // the engine's Stop, so it is never sent; in a target session, every
      // undecided dispatch is, since the engine's Stop ends the whole session.
      const fenceable = sql`
        bot_id = ${botId} AND status = 'intended' AND fenced_by_stop_id IS NULL
          AND (${inScope(scope)}${sessionIds.length > 0 ? sql` OR ${sql.in("session_id", sessionIds)}` : sql``})
      `;
      const [anyFenceable] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM dispatches WHERE ${fenceable}
      `;
      if (sessionIds.length > 0 || (anyFenceable?.n ?? 0) > 0) {
        const stopId = yield* ids.make("stop");
        yield* sql`
          INSERT INTO stops (id, bot_id, scope, room_id, created_at)
          VALUES (${stopId}, ${botId}, ${scope._tag}, ${scope._tag === "room" ? scope.roomId : null}, ${at})
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
              next_attempt_at = CASE WHEN attempts > 0 THEN NULL ELSE next_attempt_at END
            WHERE ${fenceable}
            RETURNING id, attempts, ${inScope(scope)} AS in_scope
          `,
        })(undefined);
        // One the engine may have is settled by the recovery, which owns it from
        // here: once now, since the Stop waits on it, then with its backoff.
        if (fenced.some((dispatch) => dispatch.attempts > 0)) {
          yield* sql.afterCommit(signals.recovery.fire);
        }
        for (const dispatch of fenced) {
          // Never sent: released. Its wakes are cancelled when the operator
          // stopped them, and wait again when they were private work.
          if (dispatch.attempts === 0) {
            yield* ledger.release(
              dispatch.id,
              dispatch.in_scope ? { _tag: "cancelled" } : { _tag: "pending" },
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

    /** The latest round of each unconfirmed target, sent or not. */
    const latestRounds = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Round,
      execute: () => sql`
        SELECT t.stop_id, t.session_id, t.round, t.engine_key, t.sent_at IS NOT NULL AS sent,
          s.engine_session_id
        FROM stop_targets t JOIN sessions s ON s.id = t.session_id
        WHERE t.stopped_at IS NULL AND s.lost_at IS NULL
          AND t.round = (
            SELECT MAX(u.round) FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id
          )
        ORDER BY t.session_id, t.stop_id
      `,
    });

    /** Fenced dispatches whose answer is not known yet: recovery settles them first. */
    const fencedInFlight = (sessionId: SessionRowId) =>
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM dispatches
        WHERE session_id = ${sessionId} AND status = 'intended' AND attempts > 0
          AND fenced_by_stop_id IS NOT NULL
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      );

    const markSent = Effect.fn("Stops.markSent")(function* (round: Round) {
      const at = timeText(yield* DateTime.now);
      yield* sql`
        UPDATE stop_targets SET sent_at = ${at},
          observed_at = ${round.engine_session_id === null ? at : null}
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
    }, Effect.orDie);

    /**
     * Sends one round's commands through the gate, which only acknowledges
     * them. A session the engine never had runs nothing, so its round counts
     * as observed at once.
     */
    const sendRound = Effect.fn("Stops.sendRound")(function* (round: Round) {
      const sessionId = round.engine_session_id;
      if (sessionId === null) {
        yield* markSent(round);
        return "done" satisfies Progress;
      }
      return yield* gate.run(round.session_id)(
        engine.stop({ key: round.engine_key, sessionId }).pipe(
          Effect.andThen(markSent(round)),
          Effect.as("done" satisfies Progress as Progress),
          // The engine has no such session: nothing runs there.
          Effect.catchTag("SessionNotFound", () =>
            transaction(sessionLost(round.session_id)).pipe(Effect.as("done" satisfies Progress)),
          ),
          // Sent again once the engine is ready.
          Effect.catchTags({
            EngineUnavailable: () => Effect.succeed("unavailable" satisfies Progress),
            EngineIndeterminate: () => Effect.succeed("unavailable" satisfies Progress),
            EngineIncompatible: () => Effect.succeed("unavailable" satisfies Progress),
          }),
        ),
      );
    });

    /**
     * The session's events are brought past every round sent so far: those
     * rounds are observed, and the target is confirmed if the events now show
     * nothing left running. Confirmation comes only from here, after a
     * `synchronize`, never from one event as it is applied: the event after it
     * may start a turn the engine had waiting.
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
        Effect.as(true),
        Effect.catchTag("SessionNotFound", () =>
          transaction(sessionLost(sessionId)).pipe(Effect.as(false)),
        ),
        Effect.catchTags({
          EngineUnavailable: () => Effect.succeed(false),
          EngineIndeterminate: () => Effect.succeed(false),
          EngineIncompatible: () => Effect.succeed(false),
        }),
      );
      if (!synced) return "unavailable" satisfies Progress;
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
      if (confirmed) {
        yield* observer.resumeHeld(sessionId);
        yield* signals.dispatch.fire;
      }
      return "done" satisfies Progress;
    });

    /** Step 2 to 4 for one session: settle, send, observe. */
    const advance = Effect.fn("Stops.advance")(function* (rounds: ReadonlyArray<Round>) {
      const [first] = rounds;
      if (first === undefined) return "done" satisfies Progress;
      // Recovery settles a fenced dispatch whose answer was lost, on its own
      // backoff, so nothing the bot was sent lands behind the Stop.
      if (yield* fencedInFlight(first.session_id)) return "waiting" satisfies Progress;
      if (first.engine_session_id !== null) yield* observer.watch(first.session_id);
      for (const round of rounds) {
        if (round.sent) continue;
        const progress = yield* sendRound(round);
        if (progress !== "done") return progress;
      }
      if (first.engine_session_id === null) {
        const confirmed = yield* transaction(targets.confirm(first.session_id)).pipe(Effect.orDie);
        if (confirmed) yield* signals.dispatch.fire;
        return "done" satisfies Progress;
      }
      return yield* observe(first.session_id, first.engine_session_id);
    });

    const bySession = (rounds: ReadonlyArray<Round>) => {
      const grouped = new Map<SessionRowId, Array<Round>>();
      for (const round of rounds) {
        const list = grouped.get(round.session_id) ?? [];
        list.push(round);
        grouped.set(round.session_id, list);
      }
      return [...grouped.values()];
    };

    /**
     * Runs one session's Stop work, logging a failure and carrying on with the
     * others, as T3 Code's effect worker does with each item.
     */
    const supervised = (rounds: ReadonlyArray<Round>) =>
      advance(rounds).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("A Stop round failed; it is tried again", cause).pipe(
            Effect.as("unavailable" satisfies Progress as Progress),
          ),
        ),
      );

    const runPending = Effect.gen(function* () {
      let available = true;
      const rounds = yield* latestRounds(undefined).pipe(Effect.orDie);
      for (const session of bySession(rounds)) {
        if ((yield* supervised(session)) === "unavailable") available = false;
      }
      return available;
    }).pipe(Effect.withSpan("Stops.runPending"));

    const resendUnconfirmed = Effect.gen(function* () {
      let available = true;
      const rounds = yield* latestRounds(undefined).pipe(Effect.orDie);
      for (const session of bySession(rounds)) {
        const [first] = session;
        if (first === undefined || (yield* fencedInFlight(first.session_id))) continue;
        for (const round of session) {
          // Replayed with its own key: the engine applies it once. Earlier
          // rounds keep what they recorded; this one is observed anew.
          const progress = yield* sendRound(round).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Sending a Stop round again failed", cause).pipe(
                Effect.as("unavailable" satisfies Progress as Progress),
              ),
            ),
          );
          if (progress === "unavailable") available = false;
        }
      }
      return available;
    }).pipe(Effect.withSpan("Stops.resendUnconfirmed"));

    const run = Effect.gen(function* () {
      yield* signals.stops.next;
      yield* readiness.released;
      // An engine that took nothing is not asked again until it is ready again.
      if (!(yield* runPending)) yield* readiness.changeOrRetry;
    }).pipe(Effect.forever);

    return Stops.of({ record, stopBot, resendUnconfirmed, runPending, run });
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
              AND d.status IN ('intended', 'accepted', 'delivered')
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
