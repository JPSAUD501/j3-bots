// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, Room, RosterItem, RosterItemKey } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { BotStore } from "../bots/BotStore.ts";
import { Entries } from "../entries/Entries.ts";
import { previewOf } from "../entries/preview.ts";
import { ChangeLog, type ChangeScope } from "../persistence/ChangeLog.ts";
import { Rooms } from "../rooms/Rooms.ts";

export type RosterFrame =
  | { readonly _tag: "snapshot"; readonly items: ReadonlyArray<RosterItem> }
  | {
      readonly _tag: "changed";
      readonly upsert: ReadonlyArray<RosterItem>;
      readonly remove: ReadonlyArray<RosterItemKey>;
    };

const createdAtOf = (item: RosterItem) =>
  item._tag === "bot" ? item.bot.createdAt : item.room.createdAt;

const pinnedOf = (item: RosterItem) => (item._tag === "bot" ? item.bot.pinned : item.room.pinned);

/** Whether the item asks for the operator: something unread, or a bot waiting on them. */
const callsOf = (item: RosterItem) =>
  item.unread || (item._tag === "bot" && item.bot.state._tag === "waiting");

/**
 * The roster's order: pinned first, then what calls for the operator, then the
 * most recent activity, then the oldest created. Hidden bots are in the list:
 * clients keep them out of view, and search still finds them.
 */
const compare = (a: RosterItem, b: RosterItem): number => {
  if (pinnedOf(a) !== pinnedOf(b)) return pinnedOf(a) ? -1 : 1;
  if (callsOf(a) !== callsOf(b)) return callsOf(a) ? -1 : 1;
  // Newest activity first; an item with none yet after every item with some.
  if (a.lastActivityAt === null || b.lastActivityAt === null) {
    if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt === null ? 1 : -1;
  } else {
    const activity = DateTime.Order(b.lastActivityAt, a.lastActivityAt);
    if (activity !== 0) return activity;
  }
  return DateTime.Order(createdAtOf(a), createdAtOf(b));
};

/** Every bot and room, with a preview of its last entry and whether it is unread. */
export class Roster extends Context.Service<
  Roster,
  {
    /** The current roster, in its order. */
    readonly items: Effect.Effect<ReadonlyArray<RosterItem>>;
    /** A snapshot, then each item as it changes or goes away. */
    readonly subscribe: Stream.Stream<RosterFrame>;
  }
>()("@j3-bots/server/roster/Roster") {}

export const layer = Layer.effect(
  Roster,
  Effect.gen(function* () {
    const bots = yield* BotStore;
    const rooms = yield* Rooms;
    const entries = yield* Entries;
    const changes = yield* ChangeLog;

    const botItem = Effect.fn("Roster.botItem")(function* (bot: Bot) {
      const summary = yield* entries.summary({ _tag: "conversation", botId: bot.id });
      const last = Option.getOrNull(summary.last);
      return {
        _tag: "bot",
        bot,
        lastEntry: last === null ? null : previewOf(last),
        lastActivityAt: last?.createdAt ?? null,
        unread: summary.unread,
      } satisfies RosterItem;
    });

    const roomItem = Effect.fn("Roster.roomItem")(function* (room: Room) {
      const summary = yield* entries.summary({ _tag: "room", roomId: room.id });
      const last = Option.getOrNull(summary.last);
      return {
        _tag: "room",
        room,
        lastEntry: last === null ? null : previewOf(last),
        lastActivityAt: last?.createdAt ?? null,
        unread: summary.unread,
      } satisfies RosterItem;
    });

    const items = Effect.gen(function* () {
      const botItems = yield* Effect.forEach(yield* bots.list, ({ bot }) => botItem(bot));
      const roomItems = yield* Effect.forEach(yield* rooms.list, roomItem);
      return [...botItems, ...roomItems].toSorted(compare);
    });

    /** The frame for one changed scope: the item as it is now, or its removal. */
    const changedOf = Effect.fn("Roster.changedOf")(function* (scope: ChangeScope) {
      if (scope._tag === "room") {
        const room = yield* rooms.find(scope.roomId);
        return Option.isSome(room)
          ? ({ _tag: "changed", upsert: [yield* roomItem(room.value)], remove: [] } as const)
          : ({
              _tag: "changed",
              upsert: [],
              remove: [{ _tag: "room", roomId: scope.roomId }],
            } as const);
      }
      const bot = yield* bots.find(scope.botId);
      return Option.isSome(bot)
        ? ({ _tag: "changed", upsert: [yield* botItem(bot.value.bot)], remove: [] } as const)
        : ({ _tag: "changed", upsert: [], remove: [{ _tag: "bot", botId: scope.botId }] } as const);
    });

    const subscribe = Stream.unwrap(
      Effect.gen(function* () {
        // Joined before the snapshot is read, so no change falls between.
        const signals = yield* changes.subscribe;
        const snapshot: RosterFrame = { _tag: "snapshot", items: yield* items };
        return Stream.concat(
          Stream.succeed(snapshot),
          Stream.fromSubscription(signals).pipe(
            Stream.filter((scope) => scope._tag !== "routines"),
            Stream.mapEffect(changedOf),
          ),
        );
      }),
    );

    return Roster.of({ items, subscribe });
  }),
);
