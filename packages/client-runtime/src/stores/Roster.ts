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
import { Conversations } from "./Conversations.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

const keyOf = (item: RosterItem | RosterItemKey) =>
  item._tag === "bot"
    ? `bot:${"bot" in item ? item.bot.id : item.botId}`
    : `room:${"room" in item ? item.room.id : item.roomId}`;

/** A pending question or approval, or something the operator has not read. */
export const needsOperator = (item: RosterItem) =>
  item.unread || (item._tag === "bot" && item.bot.state._tag === "waiting");

/**
 * Whether the bot or room is hidden: out of the roster's rows, among the
 * hidden conversations, still running and notifying.
 */
export const isHidden = (item: RosterItem): boolean =>
  item._tag === "bot" ? item.bot.hidden : item.room.hidden;

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
     * The sections, in the operator's order, or null until a roster snapshot
     * carries them. Only while it is not null does a client offer sections
     * and Mark as unread.
     */
    readonly sections: Readable<ReadonlyArray<Section> | null>;
    /**
     * Whether the server takes mentions of bots and rooms in a bot's
     * conversation, as its latest roster snapshot says. Only then does a
     * client offer `@` there.
     */
    readonly conversationMentions: Readable<boolean>;
    /**
     * Whether the server takes quotes on a message, as its latest roster
     * snapshot says. Only then does a client offer Reply and Quote.
     */
    readonly quotes: Readable<boolean>;
    /**
     * Whether the server takes the operator's comment on a passage they
     * quote (decision 0106), as its latest roster snapshot says. Only then
     * does a client offer one.
     */
    readonly quoteComments: Readable<boolean>;
    /**
     * Whether the server takes screen recordings (decision 0098), uploaded
     * in resumable pieces, as its latest roster snapshot says. Only then does
     * a client offer to record the screen.
     */
    readonly screenRecordings: Readable<boolean>;
    /**
     * Whether the server writes down a screen recording's voice through its
     * speech recognition (`recordingTranscripts`), as its latest roster
     * snapshot says. Only then does the desktop app ask it to.
     */
    readonly recordingTranscripts: Readable<boolean>;
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
    /**
     * Stop, for an AI that ignores it (`Bot.forceStop`): stops the bot as
     * `stop` does, and has its AI's program ended.
     */
    readonly forceStop: (botId: BotId) => Effect.Effect<IntentResult>;
    /** `forceStop`, for the work addressed to the room (`Room.forceStop`). */
    readonly forceStopRoom: (roomId: RoomId) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Roster") {}

/** The conversation or room a roster item is. */
const targetOf = (item: RosterItem): EntryTarget =>
  item._tag === "bot"
    ? { _tag: "conversation", botId: item.bot.id }
    : { _tag: "room", roomId: item.room.id };

export const layer = Layer.effect(
  Roster,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const conversations = yield* Conversations;
    const state = new Cell<Synced<ReadonlyArray<RosterItem>>>(loading);
    const sections = new Cell<ReadonlyArray<Section> | null>(null);
    const conversationMentions = new Cell(false);
    const quotes = new Cell(false);
    const quoteComments = new Cell(false);
    const screenRecordings = new Cell(false);
    const recordingTranscripts = new Cell(false);

    yield* connection
      .eachSession((client) =>
        client["roster.subscribe"]().pipe(
          Stream.runForEach((frame) =>
            // What the server counts unread may be what an open conversation
            // read before and another device marked unread since: its next
            // read goes out again. Before the roster shows it, so a read the
            // operator makes on seeing it is never dropped.
            Effect.forEach(
              (frame._tag === "snapshot" ? frame.items : frame.upsert).filter(
                (item) => item.unread,
              ),
              (item) => conversations.unreadOnServer(targetOf(item)),
              { discard: true },
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (frame._tag === "snapshot") {
                    sections.set(frame.sections ?? null);
                    conversationMentions.set(frame.conversationMentions === true);
                    quotes.set(frame.quotes === true);
                    quoteComments.set(frame.quoteComments === true);
                    screenRecordings.set(frame.screenRecordings === true);
                    recordingTranscripts.set(frame.recordingTranscripts === true);
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
            ),
          ),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    // A Force stop is the same action as the Stop it follows: one of them at a time.
    const stopping = (force: boolean) =>
      Effect.fn("Roster.stop")(function* (botId: BotId) {
        const commandId = yield* actions.commandId;
        return yield* actions.run(
          stopAction(botId),
          null,
          connection.call((client) =>
            client[force ? "bot.forceStop" : "bot.stop"]({ commandId, botId }),
          ),
        );
      });
    const stop = stopping(false);
    const forceStop = stopping(true);

    const roomStopping = (force: boolean) =>
      Effect.fn("Roster.stopRoom")(function* (roomId: RoomId) {
        const commandId = yield* actions.commandId;
        return yield* actions.run(
          roomStopAction(roomId),
          null,
          connection.call((client) =>
            client[force ? "room.forceStop" : "room.stop"]({ commandId, roomId }),
          ),
        );
      });
    const stopRoom = roomStopping(false);
    const forceStopRoom = roomStopping(true);

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
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["entries.markUnread"]({ commandId, target }))
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
      conversationMentions,
      quotes,
      quoteComments,
      screenRecordings,
      recordingTranscripts,
      stop,
      stopRoom,
      forceStop,
      forceStopRoom,
      placeBot,
      markRead,
      markUnread,
      createSection,
      updateSection,
      deleteSection,
    });
  }),
);
