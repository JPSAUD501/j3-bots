// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  MAX_SUGGESTED_REPLY_LENGTH,
  type SuggestedReply,
} from "@j3-bots/contracts";
import { Engine, type SessionId, type SessionSuggestedReply, TurnId } from "@j3-bots/engine-t3";
import { defuseTags } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { SuggestReplies } from "../settings/SuggestReplies.ts";
import { SessionRowId } from "./model.ts";

/**
 * Suggested replies (`docs/architecture/server.md`, Suggested replies;
 * decision 0073). The harness guesses the operator's next message after each
 * turn it completes in a session (`Engine.suggestedReplies`), from the whole
 * session: the wake envelopes, the bot's working text and every audience the
 * session serves. So the server offers a guess only where it follows what the
 * operator saw: after a turn of the bot's main session that only the operator
 * woke, in its conversation (every wake it took, its steers' too, is theirs), that completed, and whose last message there is still
 * the conversation's newest entry, the turn's own work fold aside. A guess
 * after a room turn, a teammate's message, a routine or anything the server
 * or the engine started is never offered, nor one that reads as an envelope's
 * markup or is longer than a reply the composer offers.
 *
 * What is offered lives in memory, as the engine keeps its guesses: it is
 * read again from the engine and the database after a restart of either.
 */
export class SuggestedReplies extends Context.Service<
  SuggestedReplies,
  {
    /**
     * Follows the engine's guesses in a bot's main session for as long as the
     * scope lasts: the observer opens it with the session's events, and
     * closes it when it stops following the session.
     */
    readonly follow: (session: {
      readonly id: SessionRowId;
      readonly botId: BotId;
      readonly engineSessionId: SessionId;
    }) => Effect.Effect<void, never, Scope.Scope>;
    /** What the bot's conversation offers the operator now, or null. */
    readonly of: (botId: BotId) => Effect.Effect<SuggestedReply | null>;
  }
>()("@j3-bots/server/turns/SuggestedReplies") {}

/** The guess's text as the composer would take it, or null when it cannot be offered. */
export const offerableText = (text: string): string | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SUGGESTED_REPLY_LENGTH) return null;
  // Something the operator would type never reads as the envelope the bot
  // was woken with: such a guess imitates the server, not the operator.
  return defuseTags(trimmed) === trimmed ? trimmed : null;
};

const sameOffer = (a: SuggestedReply | undefined, b: SuggestedReply | null) =>
  (a === undefined && b === null) ||
  (a !== undefined && b !== null && a.text === b.text && a.after === b.after);

export const layer = Layer.effect(
  SuggestedReplies,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* Engine;
    const changes = yield* ChangeLog;
    const suggestReplies = yield* SuggestReplies;

    /** The engine's latest guess in each bot's main session that is followed. */
    const latest = new Map<
      BotId,
      { readonly sessionId: SessionRowId; readonly reply: SessionSuggestedReply | null }
    >();
    /** What each bot's conversation offers now. */
    const offered = new Map<BotId, SuggestedReply>();
    let enabled = true;
    /** One evaluation at a time, so an older read never replaces a newer one. */
    const evaluating = yield* Semaphore.make(1);

    /**
     * The message the guess follows, when it can be offered: the turn's last
     * message in its bot's conversation, while that is the newest entry
     * there but for the turn's own work fold.
     */
    const followedMessage = SqlSchema.findOneOption({
      Request: Schema.Struct({ sessionId: SessionRowId, turnId: TurnId, botId: BotId }),
      Result: Schema.Struct({ said: EntryId }),
      execute: ({ sessionId, turnId, botId }) => sql`
        SELECT t.said_entry_id AS said FROM turns t
        WHERE t.session_id = ${sessionId} AND t.engine_turn_id = ${turnId}
          AND t.audience = 'conversation'
          AND json_extract(t.outcome_json, '$._tag') = 'completed'
          AND t.said_entry_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
            WHERE d.session_id = t.session_id AND d.engine_turn_id = t.engine_turn_id
              AND w.kind = 'user'
          )
          AND NOT EXISTS (
            SELECT 1 FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
            WHERE d.session_id = t.session_id AND d.engine_turn_id = t.engine_turn_id
              AND w.kind <> 'user'
          )
          AND t.said_entry_id = (
            SELECT e.id FROM entries e
            WHERE e.conversation_bot_id = ${botId} AND e.id IS NOT t.work_fold_entry_id
            ORDER BY e.position DESC LIMIT 1
          )
      `,
    });

    const evaluate = Effect.fn("SuggestedReplies.evaluate")(function* (botId: BotId) {
      const followed = latest.get(botId);
      let next: SuggestedReply | null = null;
      const text = followed?.reply == null ? null : offerableText(followed.reply.text);
      if (enabled && followed?.reply != null && text !== null) {
        const message = yield* followedMessage({
          sessionId: followed.sessionId,
          turnId: followed.reply.turnId,
          botId,
        }).pipe(Effect.orDie);
        if (Option.isSome(message)) next = { text, after: message.value.said };
      }
      if (sameOffer(offered.get(botId), next)) return;
      if (next === null) offered.delete(botId);
      else offered.set(botId, next);
      yield* changes.touch({ _tag: "bot", botId });
    }, evaluating.withPermits(1));

    // A turn's end and a new entry in a conversation each touch it, and so may
    // make a guess offerable or take it away; so does the operator's switch.
    yield* changes.subscribe.pipe(
      Effect.flatMap((signals) =>
        Stream.fromSubscription(signals).pipe(
          Stream.runForEach((scope) =>
            (scope._tag === "bot" || scope._tag === "conversation") && latest.has(scope.botId)
              ? evaluate(scope.botId)
              : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* suggestReplies.enabled.pipe(
      Stream.runForEach((on) =>
        Effect.gen(function* () {
          enabled = on;
          for (const botId of latest.keys()) yield* evaluate(botId);
        }),
      ),
      Effect.forkScoped,
    );

    const follow = Effect.fn("SuggestedReplies.follow")(function* (session: {
      readonly id: SessionRowId;
      readonly botId: BotId;
      readonly engineSessionId: SessionId;
    }) {
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          if (latest.get(session.botId)?.sessionId !== session.id) return Effect.void;
          latest.delete(session.botId);
          return evaluate(session.botId);
        }),
      );
      yield* engine.suggestedReplies(session.engineSessionId).pipe(
        Stream.runForEach((reply) =>
          Effect.suspend(() => {
            latest.set(session.botId, { sessionId: session.id, reply });
            return evaluate(session.botId);
          }),
        ),
        Effect.forkScoped,
      );
    });

    return SuggestedReplies.of({
      follow,
      of: Effect.fn("SuggestedReplies.of")((botId: BotId) =>
        Effect.sync(() => offered.get(botId) ?? null),
      ),
    });
  }),
);
