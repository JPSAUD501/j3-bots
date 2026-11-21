// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, RoomId, RosterItem, RosterItemKey } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { Actions, type IntentResult, roomStopAction, stopAction } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

const keyOf = (item: RosterItem | RosterItemKey) =>
  item._tag === "bot"
    ? `bot:${"bot" in item ? item.bot.id : item.botId}`
    : `room:${"room" in item ? item.room.id : item.roomId}`;

/** A pending question or approval, or something the operator has not read. */
export const needsOperator = (item: RosterItem) =>
  item.unread || (item._tag === "bot" && item.bot.state._tag === "waiting");

const pinned = (item: RosterItem) => (item._tag === "bot" ? item.bot.pinned : item.room.pinned);

const nameOf = (item: RosterItem) => (item._tag === "bot" ? item.bot.profile.name : item.room.name);

/**
 * The roster as every client lists it: hidden bots left out, pinned rows on
 * top, then the rows that need the operator, then the most recently active.
 */
export const rosterRows = (items: ReadonlyArray<RosterItem>): ReadonlyArray<RosterItem> =>
  items
    .filter((item) => item._tag === "room" || !item.bot.hidden)
    .toSorted(
      (a, b) =>
        Number(pinned(b)) - Number(pinned(a)) ||
        Number(needsOperator(b)) - Number(needsOperator(a)) ||
        (b.lastActivityAt?.epochMilliseconds ?? 0) - (a.lastActivityAt?.epochMilliseconds ?? 0) ||
        nameOf(a).localeCompare(nameOf(b)),
    );

/** Who the operator has and what each is doing, live. Items are in the server's order. */
export class Roster extends Context.Service<
  Roster,
  {
    readonly state: Readable<Synced<ReadonlyArray<RosterItem>>>;
    /** Ends the bot's running work and cancels what it has not received yet. */
    readonly stop: (botId: BotId) => Effect.Effect<IntentResult>;
    /**
     * Ends the work addressed to the room, and what it has not received yet.
     * Its bots' work for anyone else goes on.
     */
    readonly stopRoom: (roomId: RoomId) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Roster") {}

export const layer = Layer.effect(
  Roster,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const state = new Cell<Synced<ReadonlyArray<RosterItem>>>(loading);

    yield* connection
      .eachSession((client) =>
        client["roster.subscribe"]().pipe(
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              if (frame._tag === "snapshot") return state.set(ready(frame.items));
              const current = state.get();
              if (current._tag === "loading") return;
              const byKey = new Map(current.value.map((item) => [keyOf(item), item]));
              for (const key of frame.remove) byKey.delete(keyOf(key));
              for (const item of frame.upsert) byKey.set(keyOf(item), item);
              state.set({ ...current, value: [...byKey.values()] });
            }),
          ),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const stop = Effect.fn("Roster.stop")(function* (botId: BotId) {
      const commandId = yield* actions.commandId;
      return yield* actions.run(
        stopAction(botId),
        null,
        connection.call((client) => client["bot.stop"]({ commandId, botId })),
      );
    });

    const stopRoom = Effect.fn("Roster.stopRoom")(function* (roomId: RoomId) {
      const commandId = yield* actions.commandId;
      return yield* actions.run(
        roomStopAction(roomId),
        null,
        connection.call((client) => client["room.stop"]({ commandId, roomId })),
      );
    });

    return Roster.of({ state, stop, stopRoom });
  }),
);
