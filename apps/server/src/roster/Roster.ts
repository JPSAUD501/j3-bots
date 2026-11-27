// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  Entry,
  Room,
  RoomId,
  RosterItem,
  RosterItemKey,
  Section,
} from "@j3-bots/contracts";
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
import { Sections } from "../sections/Sections.ts";
import { type RoomActivity, RoomStates } from "../turns/RoomStates.ts";
import { sameWork } from "../turns/turnWork.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";

export type RosterFrame =
  | {
      readonly _tag: "snapshot";
      readonly items: ReadonlyArray<RosterItem>;
      readonly sections: ReadonlyArray<Section>;
      /** `message.send` takes `conversationMentions`, so clients offer `@` in a bot's conversation. */
      readonly conversationMentions: true;
      /** `message.send` takes `quotes`, so clients offer Reply and Quote. */
      readonly quotes: true;
      /** `message.send` takes a comment on a quoted passage, so clients offer one. */
      readonly quoteComments: true;
      /** The server takes screen recordings (`HTTP_PATHS.recordingUploads`), so clients offer one. */
      readonly screenRecordings: true;
    }
  | {
      readonly _tag: "changed";
      readonly upsert: ReadonlyArray<RosterItem>;
      readonly remove: ReadonlyArray<RosterItemKey>;
      /** Every section, when the sections changed. */
      readonly sections?: ReadonlyArray<Section>;
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

/**
 * Every bot and room, with a preview of its last entry and whether it is
 * unread, and the sections that group the bots.
 */
export class Roster extends Context.Service<
  Roster,
  {
    /** The current roster, in its order. */
    readonly items: Effect.Effect<ReadonlyArray<RosterItem>>;
    /** A snapshot, then each item as it changes or goes away. */
    readonly subscribe: Stream.Stream<RosterFrame>;
  }
>()("@j3-bots/server/roster/Roster") {}

/** Whether a room's work, who answers there, their plans and little ones, and its Force stop read the same. */
const sameActivity = (a: RoomActivity, b: RoomActivity) =>
  a.work === b.work &&
  a.forceStop === b.forceStop &&
  a.answering.length === b.answering.length &&
  a.answering.every((id, index) => id === b.answering[index]) &&
  a.memberWork.length === b.memberWork.length &&
  a.memberWork.every(
    (member, index) =>
      member.botId === b.memberWork[index]?.botId &&
      sameWork(member.work, b.memberWork[index]?.work ?? null),
  );

export const layer = Layer.effect(
  Roster,
  Effect.gen(function* () {
    const bots = yield* BotStore;
    const rooms = yield* Rooms;
    const sections = yield* Sections;
    const entries = yield* Entries;
    const changes = yield* ChangeLog;
    const roomStates = yield* RoomStates;
    const workSteps = yield* WorkSteps;

    /** The last entry as the roster shows it; a work fold with the step that says what it did. */
    const preview = Effect.fn("Roster.preview")(function* (last: Entry | null) {
      if (last === null) return null;
      const step = last._tag === "work-fold" ? yield* workSteps.shown(last.id) : Option.none();
      return previewOf(last, Option.getOrNull(step));
    });

    const botItem = Effect.fn("Roster.botItem")(function* (bot: Bot) {
      const summary = yield* entries.summary({ _tag: "conversation", botId: bot.id });
      const last = Option.getOrNull(summary.last);
      return {
        _tag: "bot",
        bot,
        lastEntry: yield* preview(last),
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
        lastEntry: yield* preview(last),
        lastActivityAt: last?.createdAt ?? null,
        unread: summary.unread,
      } satisfies RosterItem;
    });

    const items = Effect.gen(function* () {
      const botItems = yield* Effect.forEach(yield* bots.list, ({ bot }) => botItem(bot));
      const roomItems = yield* Effect.forEach(yield* rooms.list, roomItem);
      return [...botItems, ...roomItems].toSorted(compare);
    });

    const subscribe = Stream.unwrap(
      Effect.gen(function* () {
        // Joined before the snapshot is read, so no change falls between.
        const signals = yield* changes.subscribe;
        const snapshot = yield* items;
        const sectionsNow = yield* sections.list;
        // The activity each active room was last sent with, to this subscriber.
        const sentActivity = new Map<RoomId, RoomActivity>();
        const sent = (item: RosterItem) => {
          if (item._tag !== "room") return item;
          if (item.room.status === "active") {
            const { work, answering, memberWork, forceStop } = item.room;
            sentActivity.set(item.room.id, { work, answering, memberWork, forceStop });
          } else sentActivity.delete(item.room.id);
          return item;
        };

        /**
         * The rooms whose activity changed for this subscriber, among the
         * bot's. The turns, wakes and Stops that make a room's work, and who
         * answers there, are its members' work, so a change of a member is
         * when the room's may change too.
         */
        const roomsOfBot = Effect.fn("Roster.roomsOfBot")(function* (bot: Bot) {
          const activities = yield* roomStates.activityOfBot(bot.id);
          const changed: Array<RosterItem> = [];
          for (const [roomId, activity] of activities) {
            const before = sentActivity.get(roomId);
            if (before !== undefined && sameActivity(before, activity)) continue;
            const room = yield* rooms.find(roomId);
            if (Option.isSome(room)) changed.push(sent(yield* roomItem(room.value)));
          }
          return changed;
        });

        /** The frame for one changed scope: the item as it is now, or its removal. */
        const changedOf = Effect.fn("Roster.changedOf")(function* (
          scope: Exclude<ChangeScope, { readonly _tag: "routines" }>,
        ) {
          if (scope._tag === "sections") {
            return {
              _tag: "changed",
              upsert: [],
              remove: [],
              sections: yield* sections.list,
            } satisfies RosterFrame;
          }
          if (scope._tag === "room") {
            const room = yield* rooms.find(scope.roomId);
            if (Option.isSome(room)) {
              return {
                _tag: "changed",
                upsert: [sent(yield* roomItem(room.value))],
                remove: [],
              } satisfies RosterFrame;
            }
            sentActivity.delete(scope.roomId);
            return {
              _tag: "changed",
              upsert: [],
              remove: [{ _tag: "room", roomId: scope.roomId }],
            } satisfies RosterFrame;
          }
          const bot = yield* bots.find(scope.botId);
          if (Option.isNone(bot)) {
            return {
              _tag: "changed",
              upsert: [],
              remove: [{ _tag: "bot", botId: scope.botId }],
            } satisfies RosterFrame;
          }
          return {
            _tag: "changed",
            upsert: [yield* botItem(bot.value.bot), ...(yield* roomsOfBot(bot.value.bot))],
            remove: [],
          } satisfies RosterFrame;
        });

        return Stream.concat(
          Stream.succeed<RosterFrame>({
            _tag: "snapshot",
            items: snapshot.map(sent),
            sections: sectionsNow,
            conversationMentions: true,
            quotes: true,
            quoteComments: true,
            screenRecordings: true,
          }),
          Stream.fromSubscription(signals).pipe(
            Stream.filter(
              (scope): scope is Exclude<ChangeScope, { readonly _tag: "routines" }> =>
                scope._tag !== "routines",
            ),
            Stream.mapEffect(changedOf),
          ),
        );
      }),
    );

    return Roster.of({ items, subscribe });
  }),
);
