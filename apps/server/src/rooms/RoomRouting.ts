// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type MessageEntry,
  type Room,
  ROOM_QUIET_ROUND,
  RoomId,
} from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import type { DispatchSeq, RoomReason, SessionRowId } from "../turns/model.ts";
import { hopCounts } from "../turns/hopCounts.ts";
import { notices } from "../turns/notices.ts";
import { type NewWake, Wakes } from "../turns/Wakes.ts";
import type { LiveRoom } from "./liveRoom.ts";

/** A room that takes messages. */
export type ActiveRoom = Extract<Room, { readonly status: "active" }>;

/** What became of a bot's room message's wakes. */
export type BotMessageRouted =
  /** The members it wakes have their wakes, unless the work that spoke was stopped. */
  | { readonly _tag: "routed" }
  /**
   * It is of a round past `ROOM_QUIET_ROUND`, so none was written.
   */
  | { readonly _tag: "quiet" };

/**
 * Whose word a bot's room message carries, which decides its round
 * (`docs/architecture/server.md`, The room's rounds):
 *
 * - `kickoff`: the first message of a room the bot started, which a bot does
 *   only in a turn the operator spoke in. It is round 0, as their own message
 *   there would be.
 * - `relayed`: the first `message_bot` to the room from a turn the operator
 *   spoke in, outside the room's own turns: their request, brought to the
 *   room. It is round 0 too; the turn's later posts there are `bot`.
 * - `bot`: any other, the bot's own, which answers the rounds before it.
 */
export type BotWord = "kickoff" | "relayed" | "bot";

/** The speaking turn: what it was shown of the room decides its messages' round. */
export interface SpeakingTurn {
  readonly sessionId: SessionRowId;
  readonly turnId: TurnId;
}

/**
 * Who a room message wakes (`docs/architecture/server.md`, Rooms), the
 * operator's message and a bot's alike: the members it mentions, or every
 * member but its author when it mentions nobody or everyone. Every member
 * reads it in its next envelope either way.
 *
 * Each message takes a round, kept with its entry (`entries.room_round`). The
 * operator's word is round 0: their message, a bot's kickoff, or a request of
 * theirs a bot relayed (`BotWord`), and the room's newest round-0 message is
 * their latest word there. A bot's message is one round past the newest round
 * its turn was shown since that word: the highest `dispatches.room_round` of
 * the room dispatches written since for the turn and the turns whose work it
 * goes on with, or round 1 when they were shown none of it. A turn shown
 * nothing of the room, one from outside it or one the engine started on its
 * own for no room turn's work, answers the whole room: one round past its
 * highest since that word. Past `ROOM_QUIET_ROUND` a bot's message wakes
 * nobody, and the first such message shows one `chain-stopped` notice; from
 * then on no bot's message there wakes anyone, whatever its round, until
 * their word reaches the room again. Each wake is a `room` wake for the
 * room, written in the caller's transaction, the one that writes the message.
 */
export class RoomRouting extends Context.Service<
  RoomRouting,
  {
    readonly operatorMessage: (input: {
      readonly room: ActiveRoom;
      readonly message: MessageEntry;
    }) => Effect.Effect<void>;
    /**
     * A bot spoke in a room: in a `say` or a `message_bot` to it, in the
     * `kickoff` of a room it started, or in the engine's own speech of a room
     * turn; `word` says whether it carries the operator's word. Its mentions
     * are already checked to be other members. `seq` is the dispatch that
     * began the speaking turn's work, `null` for a turn no dispatch began. A
     * message of work the operator `stopped` is in the room, so it takes its
     * round, but wakes nobody.
     */
    readonly botMessage: (input: {
      readonly room: LiveRoom;
      readonly botId: BotId;
      readonly turn: SpeakingTurn;
      readonly message: MessageEntry;
      readonly word: BotWord;
      readonly seq: DispatchSeq | null;
      readonly stopped: boolean;
    }) => Effect.Effect<BotMessageRouted>;
  }
>()("@j3-bots/server/rooms/RoomRouting") {}

/**
 * The members a message wakes, in member order, and why: those it mentions,
 * or, mentioning nobody or everyone, every member but its author.
 */
const woken = (
  members: ReadonlyArray<BotId>,
  message: MessageEntry,
  unaddressed: "user" | "member" | "kickoff",
): ReadonlyArray<readonly [BotId, RoomReason]> => {
  const author = message.author._tag === "bot" ? message.author.botId : null;
  const others = members.filter((id) => id !== author);
  const { mentions } = message;
  if (mentions._tag === "everyone") {
    return others.map((id) => [id, unaddressed === "kickoff" ? "kickoff" : "everyone"] as const);
  }
  if (mentions.ids.length === 0) return others.map((id) => [id, unaddressed] as const);
  return others
    .filter((id) => mentions.ids.includes(id))
    .map((id) => [id, unaddressed === "kickoff" ? "kickoff" : "addressed"] as const);
};

export const layer = Layer.effect(
  RoomRouting,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wakes = yield* Wakes;
    const { notify } = notices(sql, yield* Entries);

    /** Gives a room message its round, in the transaction that wrote it. */
    const setRound = (message: MessageEntry, round: number) =>
      sql`UPDATE entries SET room_round = ${round} WHERE id = ${message.id}`.pipe(Effect.orDie);

    /** The place of the operator's latest word in the room, `null` before any. */
    const latestWord = SqlSchema.findOne({
      Request: RoomId,
      Result: Schema.Struct({ word: Schema.NullOr(Schema.Int) }),
      execute: (roomId) => sql`
        SELECT MAX(position) AS word FROM entries WHERE room_id = ${roomId} AND room_round = 0
      `,
    });

    /** The room's highest round from a place on, `null` when nothing there has one. */
    const highestFrom = SqlSchema.findOne({
      Request: Schema.Struct({ roomId: RoomId, from: Schema.Int }),
      Result: Schema.Struct({ round: Schema.NullOr(Schema.Int) }),
      execute: ({ roomId, from }) => sql`
        SELECT MAX(room_round) AS round FROM entries
        WHERE room_id = ${roomId} AND position >= ${from} AND room_round IS NOT NULL
      `,
    });

    const { chainSql: chain } = hopCounts(sql);

    /**
     * What the speaking turn was shown of the room: how many room dispatches
     * the engine took for it and the turns whose work it goes on with (the
     * turn a continuation resumes, the one whose background work woke the
     * session: `hopCounts.chainSql`), a steer riding any of them included, and
     * the highest round their replies take among those written since the place
     * given, `null` when none was. A dispatch is the turn's it was first
     * answered for (`disposition_turn_id`) as well as the one it is now:
     * a continuation takes over its turn's dispatch, and the speech of the
     * turn it resumes may be read after that. A steer counts once the engine
     * has it: whether the agent read it is told only when the turn ends, so
     * it is taken as shown.
     */
    const shownTo = (roomId: RoomId, turn: SpeakingTurn, from: number) =>
      SqlSchema.findOne({
        Request: Schema.Void,
        Result: Schema.Struct({ dispatches: Schema.Int, round: Schema.NullOr(Schema.Int) }),
        execute: () => sql`
          SELECT COUNT(*) AS dispatches,
            MAX(CASE WHEN room_through >= ${from} THEN room_round END) AS round
          FROM dispatches
          WHERE audience_room_id = ${roomId} AND session_id = ${turn.sessionId}
            AND status IN ('accepted', 'delivered', 'finished')
            AND (
              engine_turn_id IN (${chain(turn.sessionId, turn.turnId)})
              OR disposition_turn_id IN (${chain(turn.sessionId, turn.turnId)})
              OR (
                engine_turn_id IS NULL
                AND steer_turn_id IN (${chain(turn.sessionId, turn.turnId)})
              )
            )
        `,
      })(undefined);

    /** Whether a message of the room other than this one went past the quiet round since a place. */
    const quietBefore = (roomId: RoomId, from: number, message: MessageEntry) =>
      sql<{ readonly id: string }>`
        SELECT id FROM entries
        WHERE room_id = ${roomId} AND position >= ${from} AND room_round > ${ROOM_QUIET_ROUND}
          AND id <> ${message.id}
        LIMIT 1
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /** The round of a bot's own message (`BotWord` `bot`), and from where its room counts. */
    const roundOf = Effect.fn("RoomRouting.roundOf")(function* (
      room: LiveRoom,
      turn: SpeakingTurn,
    ) {
      const { word } = yield* latestWord(room.id);
      const from = word ?? 0;
      const shown = yield* shownTo(room.id, turn, from);
      if (shown.dispatches > 0) return { round: shown.round ?? 1, from };
      const { round } = yield* highestFrom({ roomId: room.id, from });
      return { round: (round ?? 0) + 1, from };
    }, Effect.orDie);

    const operatorMessage = Effect.fn("RoomRouting.operatorMessage")(function* (input: {
      readonly room: ActiveRoom;
      readonly message: MessageEntry;
    }) {
      yield* setRound(input.message, 0);
      const audience = { _tag: "room", roomId: input.room.id } as const;
      yield* wakes.record(
        woken(input.room.members, input.message, "user").map(([botId, reason]): NewWake => ({
          botId,
          kind: "room",
          audience,
          payload: { _tag: "room", entryId: input.message.id, reason },
          sourceEntryId: input.message.id,
          hops: 0,
          retryOf: null,
          cause: { _tag: "operator" },
        })),
      );
    });

    const botMessage = Effect.fn("RoomRouting.botMessage")(function* (input: {
      readonly room: LiveRoom;
      readonly botId: BotId;
      readonly turn: SpeakingTurn;
      readonly message: MessageEntry;
      readonly word: BotWord;
      readonly seq: DispatchSeq | null;
      readonly stopped: boolean;
    }) {
      const audience = { _tag: "room", roomId: input.room.id } as const;
      if (input.word !== "bot") yield* setRound(input.message, 0);
      else {
        const { round, from } = yield* roundOf(input.room, input.turn);
        yield* setRound(input.message, round);
        // Once a message went past the quiet round, the room waits for the
        // operator's word: a late answer to an earlier round wakes nobody either.
        const quiet = yield* quietBefore(input.room.id, from, input.message);
        if (quiet || round > ROOM_QUIET_ROUND) {
          if (!quiet) {
            yield* notify(input.botId, audience, { _tag: "chain-stopped", limit: "room" }, null);
          }
          return { _tag: "quiet" } as const;
        }
      }
      if (input.stopped) return { _tag: "routed" } as const;
      // The speaking turn's work: a Stop that covers it, or the room's
      // archival, leaves these wakes unwritten (`Wakes.record`). A room
      // counts its own rounds, so its wakes carry no hops: a teammate
      // message a member sends from them starts a chain of its own.
      yield* wakes.record(
        woken(
          input.room.members,
          input.message,
          input.word === "kickoff" ? "kickoff" : "member",
        ).map(([botId, reason]): NewWake => ({
          botId,
          kind: "room",
          audience,
          payload: { _tag: "room", entryId: input.message.id, reason },
          sourceEntryId: input.message.id,
          hops: 0,
          retryOf: null,
          cause: { _tag: "teammate", senderId: input.botId, audience, seq: input.seq },
        })),
      );
      return { _tag: "routed" } as const;
    });

    return RoomRouting.of({ operatorMessage, botMessage });
  }),
);
