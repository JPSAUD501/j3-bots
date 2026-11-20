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
import { Observer } from "./Observer.ts";
import { SessionGate } from "./SessionGate.ts";
import { Sender } from "./Sender.ts";
import { Signals } from "./Signals.ts";
import { stopKey, stopTargets } from "./stopTargets.ts";

/** What a Stop ends: all of a bot's work, or only the work addressed to one room. */
export type StopScope =
  | { readonly _tag: "bot" }
  | { readonly _tag: "room"; readonly roomId: RoomId };

const Round = Schema.Struct({
  stop_id: Schema.String,
  session_id: Schema.String,
  round: Schema.Int,
  engine_key: IdempotencyKey,
  engine_session_id: Schema.NullOr(SessionId),
});

const Fenced = Schema.Struct({
  id: Schema.String,
  attempts: Schema.Int,
  in_scope: Schema.BooleanFromBit,
});

/**
 * The operator's Stop (`docs/architecture/server.md`, Stop): recorded in one
 * transaction with its targets, fences and cancelled wakes; then, per target
 * session and through its gate, the fenced dispatches are settled and the
 * round is sent. Stop only acknowledges: the observer confirms each target
 * from the session's events.
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
    /** Sends again every round not confirmed: after either process restarted. */
    readonly resendUnconfirmed: Effect.Effect<void>;
    /** One pass of the runner over every unsettled target. */
    readonly runPending: Effect.Effect<void>;
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
    const sender = yield* Sender;
    const signals = yield* Signals;
    const observer = yield* Observer;
    const receipts = yield* CommandReceipts;
    const bots = yield* BotStore;
    const targets = stopTargets(sql);

    /** Whether an audience column pair is in a Stop's scope. */
    const inScope = (scope: StopScope) =>
      scope._tag === "bot"
        ? sql`1`
        : sql`(audience = 'room' AND audience_room_id = ${scope.roomId})`;

    const record = Effect.fn("Stops.record")(function* (botId: BotId, scope: StopScope) {
      const at = timeText(yield* DateTime.now);
      // Every session of the bot with work in scope. A bot Stop reaches every
      // live session too, for background work the server does not see.
      const sessions = yield* sql<{ readonly id: string }>`
        SELECT s.id FROM sessions s WHERE s.bot_id = ${botId} AND (
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
      const stopId = yield* ids.make("stop");
      if (sessions.length > 0) {
        yield* sql`
          INSERT INTO stops (id, bot_id, scope, room_id, created_at)
          VALUES (${stopId}, ${botId}, ${scope._tag}, ${scope._tag === "room" ? scope.roomId : null}, ${at})
        `;
        for (const session of sessions) {
          yield* sql`
            INSERT INTO stop_targets (stop_id, session_id, round, engine_key)
            VALUES (${stopId}, ${session.id}, 0, ${stopKey(stopId, session.id, 0)})
          `;
        }
        // Every dispatch not yet accepted in a target session, or in scope, is
        // never sent for delivery again. The engine's Stop ends a whole session,
        // so it fences private work there too.
        const fenced = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Fenced,
          execute: () => sql`
            UPDATE dispatches SET fenced_by_stop_id = ${stopId}, updated_at = ${at}
            WHERE bot_id = ${botId} AND status = 'intended' AND fenced_by_stop_id IS NULL
              AND (${inScope(scope)} OR ${sql.in(
                "session_id",
                sessions.map((s) => s.id),
              )})
            RETURNING id, attempts, ${inScope(scope)} AS in_scope
          `,
        })(undefined);
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

    const unsentRounds = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Round,
      execute: () => sql`
        SELECT t.stop_id, t.session_id, t.round, t.engine_key, s.engine_session_id
        FROM stop_targets t JOIN sessions s ON s.id = t.session_id
        WHERE t.stopped_at IS NULL AND t.sent_at IS NULL
          AND t.round = (
            SELECT MAX(u.round) FROM stop_targets u
            WHERE u.stop_id = t.stop_id AND u.session_id = t.session_id
          )
        ORDER BY t.session_id, t.stop_id
      `,
    });

    const fencedInFlight = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (sessionId) => sql`
        SELECT id FROM dispatches
        WHERE session_id = ${sessionId} AND status = 'intended' AND attempts > 0
          AND fenced_by_stop_id IS NOT NULL
      `,
    });

    const markSent = Effect.fn("Stops.markSent")(function* (round: typeof Round.Type) {
      yield* sql`
        UPDATE stop_targets SET sent_at = ${timeText(yield* DateTime.now)}
        WHERE stop_id = ${round.stop_id} AND session_id = ${round.session_id}
          AND round = ${round.round}
      `;
    }, Effect.orDie);

    /**
     * Sends one round, once the session's fenced dispatches are settled, and
     * confirms the target at once when nothing runs in the session.
     */
    const sendRound = Effect.fn("Stops.sendRound")(function* (round: typeof Round.Type) {
      // Step 2: a fenced dispatch whose answer was lost is recovered first, so
      // nothing the bot was sent lands behind the Stop.
      for (const { id } of yield* fencedInFlight(round.session_id).pipe(Effect.orDie)) {
        const result = yield* sender.send(id, "settle");
        if (result !== "settled") return;
      }
      const sessionId = round.engine_session_id;
      const sent = yield* gate.run(round.session_id)(
        sessionId === null
          ? Effect.succeed(true)
          : engine.stop({ key: round.engine_key, sessionId }).pipe(
              Effect.as(true),
              // The engine has no such session: nothing runs there.
              Effect.catchTag("SessionNotFound", () => Effect.succeed(true)),
              // Sent again on the engine's next ready edge.
              Effect.catchTags({
                EngineUnavailable: () => Effect.succeed(false),
                EngineIndeterminate: () => Effect.succeed(false),
                EngineIncompatible: () => Effect.succeed(false),
              }),
              Effect.tap((ok) => (ok ? markSent(round) : Effect.void)),
            ),
      );
      if (!sent) return;
      if (sessionId === null) yield* markSent(round);
      const confirmed = yield* transaction(targets.confirm(round.session_id)).pipe(Effect.orDie);
      if (confirmed) {
        yield* observer.resumeHeld(round.session_id);
        yield* signals.dispatch.fire;
      }
    });

    const runPending = Effect.gen(function* () {
      for (const round of yield* unsentRounds(undefined).pipe(Effect.orDie)) {
        if (round.engine_session_id !== null) yield* observer.watch(round.session_id);
        yield* sendRound(round);
      }
    }).pipe(Effect.withSpan("Stops.runPending"));

    const resendUnconfirmed = Effect.gen(function* () {
      yield* sql`UPDATE stop_targets SET sent_at = NULL WHERE stopped_at IS NULL`.pipe(
        Effect.orDie,
      );
      for (const round of yield* unsentRounds(undefined).pipe(Effect.orDie))
        yield* sendRound(round);
    }).pipe(Effect.withSpan("Stops.resendUnconfirmed"));

    const run = Effect.gen(function* () {
      yield* signals.stops.next;
      yield* runPending;
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
