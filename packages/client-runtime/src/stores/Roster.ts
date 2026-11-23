// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotId,
  EntryOrder,
  EntryTarget,
  RoomId,
  RosterItem,
  RosterItemKey,
  Section,
  SectionId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import {
  Actions,
  type IntentResult,
  intentResult,
  roomStopAction,
  stopAction,
} from "../intents/Actions.ts";
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

/** Where a bot sits in the roster. Fields left out keep their value. */
export interface BotPlacement {
  readonly pinned?: boolean;
  readonly hidden?: boolean;
  /** True makes this bot the primary one, and the one before it not. */
  readonly primary?: true;
  /** A section, or null for none. Only for a server that has sections. */
  readonly sectionId?: SectionId | null;
}

/** What `updateSection` changes. Fields left out keep their value. */
export interface SectionChanges {
  readonly name?: string;
  /** Moves the section before this one, or after every other with null. */
  readonly before?: SectionId | null;
}

/** Who the operator has and what each is doing, live. Items are in the server's order. */
export class Roster extends Context.Service<
  Roster,
  {
    readonly state: Readable<Synced<ReadonlyArray<RosterItem>>>;
    /**
     * The sections, in the operator's order, or null while the server has not
     * said it has them: a server that predates them sends none. Only while it
     * is not null does a client offer sections and Mark as unread.
     */
    readonly sections: Readable<ReadonlyArray<Section> | null>;
    /** Pins, hides, makes primary or moves the bot between sections. */
    readonly placeBot: (botId: BotId, placement: BotPlacement) => Effect.Effect<IntentResult<Bot>>;
    /**
     * Marks the conversation or room read through `through`, its latest entry
     * as the roster previews it (`EntryPreview.order`), without opening it.
     */
    readonly markRead: (target: EntryTarget, through: EntryOrder) => Effect.Effect<IntentResult>;
    /** Makes the conversation or room unread again, from the last thing a bot said there. */
    readonly markUnread: (target: EntryTarget) => Effect.Effect<IntentResult>;
    /** Adds a section after the others, with `botId` in it when given. */
    readonly createSection: (
      name: string,
      botId: BotId | null,
    ) => Effect.Effect<IntentResult<Section>>;
    readonly updateSection: (
      sectionId: SectionId,
      changes: SectionChanges,
    ) => Effect.Effect<IntentResult<Section>>;
    /** Deletes the section; its bots stay, in no section. */
    readonly deleteSection: (sectionId: SectionId) => Effect.Effect<IntentResult>;
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
    const sections = new Cell<ReadonlyArray<Section> | null>(null);

    yield* connection
      .eachSession((client) =>
        client["roster.subscribe"]().pipe(
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              if (frame._tag === "snapshot") {
                // A server that predates sections sends none: this one has them.
                sections.set(frame.sections ?? null);
                return state.set(ready(frame.items));
              }
              if (frame.sections !== undefined) sections.set(frame.sections);
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

    const placeBot = Effect.fn("Roster.placeBot")(function* (
      botId: BotId,
      placement: BotPlacement,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["bot.update"]({ commandId, botId, ...placement }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const markRead = Effect.fn("Roster.markRead")(function* (
      target: EntryTarget,
      through: EntryOrder,
    ) {
      return yield* connection
        .call((client) => client["entries.markRead"]({ target, through }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const markUnread = Effect.fn("Roster.markUnread")(function* (target: EntryTarget) {
      return yield* connection
        .call((client) => client["entries.markUnread"]({ target }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const createSection = Effect.fn("Roster.createSection")(function* (
      name: string,
      botId: BotId | null,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) =>
          client["section.create"](
            botId === null ? { commandId, name } : { commandId, name, botId },
          ),
        )
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const updateSection = Effect.fn("Roster.updateSection")(function* (
      sectionId: SectionId,
      changes: SectionChanges,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["section.update"]({ commandId, sectionId, ...changes }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const deleteSection = Effect.fn("Roster.deleteSection")(function* (sectionId: SectionId) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["section.delete"]({ commandId, sectionId }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    return Roster.of({
      state,
      sections,
      stop,
      stopRoom,
      placeBot,
      markRead,
      markUnread,
      createSection,
      updateSection,
      deleteSection,
    });
  }),
);
