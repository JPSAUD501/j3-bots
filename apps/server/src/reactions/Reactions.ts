// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  Conflict,
  EntryId,
  type EntryTarget,
  Invalid,
  type MessageEntry,
  NotFound,
  type ReactionEmoji,
  type Reactor,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { liveRoom } from "../rooms/liveRoom.ts";
import { TurnToolRefused } from "../tools/TurnTools.ts";
import { type Audience, conversation } from "../turns/model.ts";
import { onePassAtATime, passOutcome, reconcileWithoutEngine } from "../turns/reconciler.ts";
import { isIdle, sessionWork } from "../turns/sessionWork.ts";
import { Signals } from "../turns/Signals.ts";
import { Wakes } from "../turns/Wakes.ts";
import { reactionNotes } from "./notes.ts";

/**
 * How long the operator's reaction on a bot's message waits for more changes
 * before it reaches the bot: a change of mind within it is told once, as it
 * ended, and a reaction taken off within it tells nothing.
 */
export const REACTION_SETTLE = Duration.seconds(4);

/** Exactly one emoji, as Unicode's emoji sequences define one: a flag, a keycap, a ZWJ family. */
const ONE_EMOJI = /^\p{RGI_Emoji}$/v;

/** Whether `text` is exactly one emoji. */
export const isOneEmoji = (text: string): boolean => ONE_EMOJI.test(text);

/** A message and where it is, or why there is none to react to. */
type Found =
  | { readonly _tag: "message"; readonly target: EntryTarget; readonly message: MessageEntry }
  | { readonly _tag: "missing" }
  | { readonly _tag: "not-a-message" };

const sameTarget = (a: EntryTarget, b: EntryTarget): boolean =>
  a._tag === "conversation"
    ? b._tag === "conversation" && a.botId === b.botId
    : b._tag === "room" && a.roomId === b.roomId;

const Signal = Schema.Struct({ bot_id: Schema.String, entry_id: EntryId });

/**
 * Reactions on messages (`docs/architecture/server.md`, Reactions; decision
 * 0084). Each person and each bot has one reaction at most on a message. A
 * change is told to the bots of the conversation or room the message is in:
 * the operator's reaction on a bot's message wakes that bot in a quiet turn,
 * once its changes have settled for `REACTION_SETTLE` and only when the bot is
 * not busy; every other change waits for the next turn of each bot there, as
 * a catch-up note. A bot's reaction notifies nobody.
 */
export class Reactions extends Context.Service<
  Reactions,
  {
    /** `message.react`: the operator's reaction, set or taken off. */
    readonly react: (input: {
      readonly entryId: EntryId;
      readonly emoji: ReactionEmoji | null;
    }) => Effect.Effect<void, NotFound | Invalid | Conflict>;
    /**
     * A bot's reaction from its `react` call, in the caller's transaction:
     * on a message of `target`, the audience its turn is for, never one of
     * its own. Answers whether it changed anything.
     */
    readonly byBot: (input: {
      readonly botId: BotId;
      readonly target: EntryTarget;
      readonly entryId: string;
      readonly emoji: string;
    }) => Effect.Effect<boolean, TurnToolRefused>;
    /** One pass of the worker that turns settled reactions into wakes or notes. */
    readonly settleDue: Effect.Effect<void>;
  }
>()("@j3-bots/server/reactions/Reactions") {}

export const layer = Layer.effect(
  Reactions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const entries = yield* Entries;
    const wakes = yield* Wakes;
    const signals = yield* Signals;
    const ids = yield* Ids;
    const notes = reactionNotes(sql, ids);
    const roomOf = liveRoom(sql);
    const workOf = sessionWork(sql);

    const find = Effect.fn("Reactions.find")(function* (entryId: string) {
      const decoded = Schema.decodeOption(EntryId)(entryId);
      if (Option.isNone(decoded)) return { _tag: "missing" } satisfies Found;
      const found = yield* entries.find(decoded.value);
      if (Option.isNone(found)) return { _tag: "missing" } satisfies Found;
      const { target, entry } = found.value;
      // J3 Bots' own messages are notices in all but name: no one answers them.
      if (entry._tag !== "message" || entry.author._tag === "system") {
        return { _tag: "not-a-message" } satisfies Found;
      }
      return { _tag: "message", target, message: entry } satisfies Found;
    });

    /** The bots of a conversation or an active room; none for a room no longer active. */
    const botsOf = Effect.fn("Reactions.botsOf")(function* (target: EntryTarget) {
      if (target._tag === "conversation") return [target.botId];
      const room = yield* roomOf(target.roomId);
      return Option.isNone(room) ? [] : room.value.members;
    });

    /**
     * Tells a change of `by`'s reaction to the other bots there: a wake, once
     * the change settles, for the author of a message the operator reacted
     * to, and a note for every other bot.
     */
    const tell = Effect.fn("Reactions.tell")(function* (
      target: EntryTarget,
      message: MessageEntry,
      by: Reactor,
    ) {
      const author = message.author._tag === "bot" ? message.author.botId : null;
      const due = DateTime.addDuration(yield* DateTime.now, REACTION_SETTLE);
      for (const botId of yield* botsOf(target)) {
        if (by._tag === "bot" && by.botId === botId) continue;
        if (by._tag === "operator" && botId === author) {
          yield* sql`
            INSERT INTO reaction_signals (bot_id, entry_id, due_at)
            VALUES (${botId}, ${message.id}, ${timeText(due)})
            ON CONFLICT (bot_id, entry_id) DO UPDATE SET due_at = excluded.due_at
          `;
          yield* sql.afterCommit(signals.reactions.fire);
        } else {
          yield* notes.leave(botId, message.id);
        }
      }
    }, Effect.orDie);

    const react = Effect.fn("Reactions.react")(function* (input: {
      readonly entryId: EntryId;
      readonly emoji: ReactionEmoji | null;
    }) {
      if (input.emoji !== null && !isOneEmoji(input.emoji)) {
        return yield* new Invalid({ reason: "reaction" });
      }
      const emoji = input.emoji;
      yield* transaction(
        Effect.gen(function* () {
          const found = yield* find(input.entryId);
          if (found._tag === "missing") return yield* new NotFound({ resource: "entry" });
          if (found._tag === "not-a-message") return yield* new Invalid({ reason: "reaction" });
          const { target, message } = found;
          if (target._tag === "room" && Option.isNone(yield* roomOf(target.roomId))) {
            return yield* new Conflict({ reason: "room-archived" });
          }
          const by: Reactor = { _tag: "operator" };
          const changed = yield* entries.react({ target, entryId: message.id, by, emoji });
          if (changed) yield* tell(target, message, by);
        }),
      );
    });

    const byBot = Effect.fn("Reactions.byBot")(function* (input: {
      readonly botId: BotId;
      readonly target: EntryTarget;
      readonly entryId: string;
      readonly emoji: string;
    }) {
      if (!isOneEmoji(input.emoji)) {
        return yield* new TurnToolRefused({
          reason: "Nothing was recorded: `emoji` takes exactly one emoji, such as 👍.",
        });
      }
      const found = yield* find(input.entryId);
      if (found._tag !== "message" || !sameTarget(found.target, input.target)) {
        return yield* new TurnToolRefused({
          reason:
            "Nothing was recorded: no message has that id where this turn speaks. Use the `id` your envelope gives a message.",
        });
      }
      const { message } = found;
      if (message.author._tag === "bot" && message.author.botId === input.botId) {
        return yield* new TurnToolRefused({
          reason: "Nothing was recorded: you do not react to your own messages.",
        });
      }
      const by: Reactor = { _tag: "bot", botId: input.botId };
      // Checked as one emoji above: the contract's looser bounds hold too.
      const emoji = input.emoji as ReactionEmoji;
      const changed = yield* entries.react({
        target: input.target,
        entryId: message.id,
        by,
        emoji,
      });
      if (changed) yield* tell(input.target, message, by);
      return changed;
    });

    /** The bot's main session, if it has one now. */
    const mainSession = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (botId) => sql`
        SELECT id FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL AND lost_at IS NULL
      `,
    });

    /**
     * Whether the bot is busy: its main session runs or is sent work, or it
     * has wakes waiting that will start its next turn there. A reaction then
     * rides that turn, as a note.
     */
    const busy = Effect.fn("Reactions.busy")(function* (botId: BotId) {
      const session = yield* mainSession(botId).pipe(Effect.orDie);
      if (Option.isSome(session) && !isIdle(yield* workOf(session.value.id))) return true;
      const waiting = yield* sql`
        SELECT 1 FROM wakes
        WHERE bot_id = ${botId} AND status = 'pending' AND kind <> 'routine'
          AND json_extract(payload_json, '$._tag') <> 'reaction'
        LIMIT 1
      `;
      return waiting.length > 0;
    });

    /**
     * A settled reaction of the operator's on a bot's message: a wake for a
     * quiet turn of the bot's, where the message is, or a note for its next
     * turn while it is busy; nothing once the operator's reaction is gone.
     */
    const settle = Effect.fn("Reactions.settle")(function* (
      signal: typeof Signal.Type,
      at: DateTime.Utc,
    ) {
      yield* transaction(
        Effect.gen(function* () {
          const taken = yield* sql`
            DELETE FROM reaction_signals
            WHERE bot_id = ${signal.bot_id} AND entry_id = ${signal.entry_id}
              AND due_at <= ${timeText(at)}
            RETURNING bot_id
          `;
          if (taken.length === 0) return;
          const found = yield* find(signal.entry_id);
          if (found._tag !== "message") return;
          const { target, message } = found;
          if (message.author._tag !== "bot") return;
          const botId = message.author.botId;
          const stands = (message.reactions ?? []).some(
            (reaction) => reaction.by._tag === "operator",
          );
          if (!stands) return;
          if (yield* busy(botId)) return yield* notes.leave(botId, message.id);
          const waiting = yield* sql`
            SELECT 1 FROM wakes
            WHERE bot_id = ${botId} AND status = 'pending'
              AND json_extract(payload_json, '$._tag') = 'reaction'
              AND json_extract(payload_json, '$.entryId') = ${message.id}
            LIMIT 1
          `;
          if (waiting.length > 0) return;
          // The wake tells it: a note left while the bot was busy would tell it twice.
          yield* notes.takeBack(botId, message.id);
          const audience: Audience =
            target._tag === "conversation" ? conversation : { _tag: "room", roomId: target.roomId };
          yield* wakes.record([
            {
              botId,
              kind: "system",
              audience,
              payload: { _tag: "reaction", entryId: message.id },
              sourceEntryId: null,
              hops: 0,
              retryOf: null,
              cause: { _tag: "operator" },
            },
          ]);
        }),
      );
    });

    const dueSignals = SqlSchema.findAll({
      Request: Schema.String,
      Result: Signal,
      execute: (at) => sql`
        SELECT bot_id, entry_id FROM reaction_signals WHERE due_at <= ${at} ORDER BY due_at
      `,
    });

    const nextDue = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ due: Schema.NullOr(Time) }),
      execute: () => sql`SELECT MIN(due_at) AS due FROM reaction_signals`,
    });

    const pass = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const at = yield* DateTime.now;
        for (const signal of yield* dueSignals(timeText(at)).pipe(Effect.orDie)) {
          // One signal's defect is logged, and the others go on; it waits for a later pass.
          yield* settle(signal, at).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.andThen(
                  Effect.logError("A reaction could not reach its bot", cause),
                  Effect.sync(outcome.defer),
                ),
            ),
          );
        }
        outcome.until((yield* nextDue(undefined).pipe(Effect.orDie)).due);
        return outcome.done();
      }).pipe(Effect.withSpan("Reactions.settleDue")),
    );

    yield* Effect.forkScoped(
      reconcileWithoutEngine({ name: "The reaction worker", pass, signal: signals.reactions }),
    );

    return Reactions.of({ react, byBot, settleDue: Effect.asVoid(pass) });
  }),
);
