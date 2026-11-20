// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  AttachmentId,
  CommandId,
  Entry,
  EntryId,
  EntryOrder,
  EntryTarget,
  Mentions,
  MessageEntry,
  QuestionAnswers,
  Sequence,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import {
  Actions,
  cardAction,
  type IntentFailure,
  intentResult,
  type IntentResult,
  retryAction,
} from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { makeKeyed } from "./keyed.ts";

/** How many older entries one scroll back reads. */
const HISTORY_PAGE = 50;

export const targetKey = (target: EntryTarget) =>
  target._tag === "conversation" ? `conversation:${target.botId}` : `room:${target.roomId}`;

/**
 * A message the operator sent from this client that the conversation does not
 * show yet. It disappears when the server's entry for it arrives, matched by
 * its command id, so the message never shows twice.
 */
export interface OutgoingMessage {
  readonly _tag: "outgoing";
  readonly commandId: CommandId;
  readonly target: EntryTarget;
  readonly text: string;
  readonly attachments: ReadonlyArray<AttachmentId>;
  readonly mentions: Mentions | null;
  readonly createdAt: DateTime.Utc;
  /**
   * `sending` until the server accepts it, waiting through disconnections;
   * `not-sent` when the server refused it or the device is not paired.
   */
  readonly status:
    | { readonly _tag: "sending" }
    | { readonly _tag: "not-sent"; readonly failure: IntentFailure };
}

export type ConversationItem = Entry | OutgoingMessage;

export interface ConversationState {
  readonly phase: "loading" | "ready" | "not-found";
  /** What is shown may be out of date: the socket is closed, or reopened and not yet resynced. */
  readonly stale: boolean;
  /** Entries by `order`, then this client's outgoing messages in the order they were sent. */
  readonly items: ReadonlyArray<ConversationItem>;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

/** Where a message the operator wrote stands, from this client's send to every recipient. */
export type MessageStatus =
  | { readonly _tag: "sending" }
  | { readonly _tag: "not-sent"; readonly failure: IntentFailure }
  /** Recorded; not every recipient has it yet. */
  | { readonly _tag: "queued" }
  | { readonly _tag: "delivered" }
  | { readonly _tag: "cancelled" }
  /** Retryable with `retryMessage`. */
  | { readonly _tag: "failed"; readonly reason: "rejected" | "unresolved" | "stopped" };

export const messageStatus = (message: MessageEntry | OutgoingMessage): MessageStatus => {
  if (message._tag === "outgoing") return message.status;
  switch (message.delivery._tag) {
    case "pending":
      return { _tag: "queued" };
    case "delivered":
      return { _tag: "delivered" };
    case "cancelled":
      return { _tag: "cancelled" };
    case "failed":
      return { _tag: "failed", reason: message.delivery.reason };
  }
};

export type CardAnswer =
  | { readonly _tag: "question"; readonly answers: QuestionAnswers }
  | { readonly _tag: "dismiss" }
  | { readonly _tag: "approval"; readonly decision: ApprovalDecision };

/** The value travels redacted from the input to the socket and is kept nowhere. */
export type SecretAnswer =
  | { readonly _tag: "provide"; readonly value: Redacted.Redacted<string> }
  | { readonly _tag: "decline" };

/** One open conversation or room. */
export interface Conversation {
  readonly target: EntryTarget;
  readonly state: Readable<ConversationState>;
  /** Reads the page before the oldest entry held. Does nothing while a read runs or at the start. */
  readonly loadOlder: Effect.Effect<void>;
  /** Moves the operator's read mark to the newest entry held. */
  readonly markRead: Effect.Effect<void>;
}

/**
 * Conversations and rooms, and everything the operator does in them. Each
 * intent runs in the client's scope: closing a conversation does not cancel a
 * message on its way.
 */
export class Conversations extends Context.Service<
  Conversations,
  {
    /** Opens the conversation for as long as the scope lasts. Users of one target share it. */
    readonly open: (target: EntryTarget) => Effect.Effect<Conversation, never, Scope.Scope>;
    /**
     * Shows the message at once and sends it, through any disconnection,
     * exactly once. Succeeds with the new entry's id when the server has it.
     */
    readonly send: (input: {
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments?: ReadonlyArray<AttachmentId>;
      readonly mentions?: Mentions;
    }) => Effect.Effect<IntentResult<EntryId>>;
    /** Removes a message the server refused from the conversation. */
    readonly discard: (commandId: CommandId) => Effect.Effect<void>;
    readonly retryMessage: (entryId: EntryId) => Effect.Effect<IntentResult>;
    readonly retryNotice: (entryId: EntryId) => Effect.Effect<IntentResult>;
    readonly answerCard: (entryId: EntryId, answer: CardAnswer) => Effect.Effect<IntentResult>;
    readonly provideSecret: (entryId: EntryId, answer: SecretAnswer) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Conversations") {}

export const layer = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const scope = yield* Scope.Scope;
    // Outgoing messages of every target, so a message keeps its place while
    // its conversation is closed and reopened.
    const outbox = new Cell<ReadonlyArray<OutgoingMessage>>([]);
    const removeOutgoing = (commandIds: ReadonlySet<CommandId>) => {
      if (!outbox.get().some((message) => commandIds.has(message.commandId))) return;
      outbox.update((list) => list.filter((message) => !commandIds.has(message.commandId)));
    };

    const openStore = (target: EntryTarget) =>
      Effect.sync(() => {
        const key = targetKey(target);
        const entries = new Map<EntryId, Entry>();
        let phase: ConversationState["phase"] = "loading";
        let stale = true;
        let sequence: Sequence | null = null;
        let hasOlder = false;
        let loadingOlder = false;
        // Grows with every snapshot; a history page read before one is dropped.
        let epoch = 0;
        let readThrough: EntryOrder | null = null;

        const sorted = () => [...entries.values()].toSorted((a, b) => a.order - b.order);

        const confirmed = () => {
          const ids = new Set<CommandId>();
          for (const entry of entries.values()) {
            if (entry._tag === "message" && entry.commandId !== null) ids.add(entry.commandId);
          }
          return ids;
        };

        const project = (): ConversationState => {
          const sent = confirmed();
          const outgoing = outbox
            .get()
            .filter((message) => targetKey(message.target) === key && !sent.has(message.commandId));
          return { phase, stale, items: [...sorted(), ...outgoing], hasOlder, loadingOlder };
        };
        const state = new Cell<ConversationState>(project());
        const publish = () => state.set(project());

        const take = (entry: Entry) => {
          entries.set(entry.id, entry);
          actions.entryChanged(entry.id);
        };

        const settle = () => {
          removeOutgoing(confirmed());
          publish();
        };

        const onFrame = (
          frame:
            | {
                readonly _tag: "snapshot";
                readonly sequence: Sequence;
                readonly entries: ReadonlyArray<Entry>;
                readonly hasOlder: boolean;
              }
            | {
                readonly _tag: "changed";
                readonly sequence: Sequence;
                readonly upsert: ReadonlyArray<Entry>;
              },
        ) => {
          if (frame._tag === "snapshot") {
            // Replaces everything: the server could not tell what changed.
            entries.clear();
            for (const entry of frame.entries) take(entry);
            hasOlder = frame.hasOlder;
            loadingOlder = false;
            epoch += 1;
            phase = "ready";
          } else {
            if (sequence !== null && frame.sequence <= sequence) return;
            for (const entry of frame.upsert) take(entry);
          }
          sequence = frame.sequence;
          stale = false;
          settle();
        };

        const run = connection
          .eachSession((client) =>
            Effect.suspend(() => {
              // A resumed subscription sends only what changed, which may be nothing.
              if (sequence !== null) {
                stale = false;
                publish();
              }
              return client["entries.subscribe"]({ target, after: sequence }).pipe(
                Stream.runForEach((frame) => Effect.sync(() => onFrame(frame))),
                Effect.ensuring(
                  Effect.sync(() => {
                    stale = true;
                    publish();
                  }),
                ),
              );
            }),
          )
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.sync(() => {
                phase = "not-found";
                publish();
              }),
            ),
          );

        const loadOlder = Effect.suspend(() => {
          const oldest = sorted()[0];
          if (loadingOlder || !hasOlder || oldest === undefined) return Effect.void;
          const at = epoch;
          loadingOlder = true;
          publish();
          return connection
            .call((client) =>
              client["entries.history"]({ target, before: oldest.order, limit: HISTORY_PAGE }),
            )
            .pipe(
              Effect.flatMap((page) =>
                Effect.sync(() => {
                  if (epoch !== at) return;
                  // A copy already held came from the live tail and is at least as new.
                  for (const entry of page.entries) {
                    if (!entries.has(entry.id)) entries.set(entry.id, entry);
                  }
                  hasOlder = page.hasOlder;
                }),
              ),
              Effect.catchTags({
                NotFound: () =>
                  Effect.sync(() => {
                    phase = "not-found";
                  }),
                NotPaired: () => Effect.void,
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  if (epoch === at) loadingOlder = false;
                  publish();
                }),
              ),
            );
        });

        const markRead = Effect.suspend(() => {
          const newest = sorted().at(-1);
          if (newest === undefined || (readThrough !== null && newest.order <= readThrough)) {
            return Effect.void;
          }
          readThrough = newest.order;
          return connection
            .call((client) => client["entries.markRead"]({ target, through: newest.order }))
            .pipe(Effect.ignore);
        });

        const unsubscribe = outbox.subscribe(publish);
        const conversation: Conversation = { target, state, loadOlder, markRead };
        return { value: conversation, run, close: unsubscribe };
      });

    const stores = makeKeyed(scope, targetKey, openStore);

    const setStatus = (commandId: CommandId, status: OutgoingMessage["status"]) =>
      outbox.update((list) =>
        list.map((message) => (message.commandId === commandId ? { ...message, status } : message)),
      );

    const send = Effect.fn("Conversations.send")(function* (input: {
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments?: ReadonlyArray<AttachmentId>;
      readonly mentions?: Mentions;
    }) {
      const commandId = yield* actions.commandId;
      const attachments = input.attachments ?? [];
      const createdAt = yield* DateTime.now;
      outbox.update((list) => [
        ...list,
        {
          _tag: "outgoing",
          commandId,
          target: input.target,
          text: input.text,
          attachments,
          mentions: input.mentions ?? null,
          createdAt,
          status: { _tag: "sending" },
        },
      ]);
      const delivery = connection
        .call((client) =>
          client["message.send"]({
            commandId,
            target: input.target,
            text: input.text,
            attachments,
            ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
          }),
        )
        .pipe(
          Effect.exit,
          Effect.map((exit) => {
            const result = intentResult(exit);
            if (result._tag === "failed") {
              setStatus(commandId, { _tag: "not-sent", failure: result.failure });
            } else if (!stores.isOpen(input.target)) {
              // Nothing will show the entry; the next open reads it with the rest.
              removeOutgoing(new Set([commandId]));
            }
            return result;
          }),
        );
      return yield* Fiber.join(yield* Effect.forkIn(delivery, scope));
    });

    const discard = (commandId: CommandId) =>
      Effect.sync(() => {
        const message = outbox.get().find((candidate) => candidate.commandId === commandId);
        if (message?.status._tag === "not-sent") removeOutgoing(new Set([commandId]));
      });

    const retryMessage = Effect.fn("Conversations.retryMessage")(function* (entryId: EntryId) {
      const commandId = yield* actions.commandId;
      return yield* actions.run(
        retryAction(entryId),
        entryId,
        connection.call((client) => client["message.retry"]({ commandId, entryId })),
      );
    });

    const retryNotice = Effect.fn("Conversations.retryNotice")(function* (entryId: EntryId) {
      const commandId = yield* actions.commandId;
      return yield* actions.run(
        retryAction(entryId),
        entryId,
        connection.call((client) => client["notice.retry"]({ commandId, entryId })),
      );
    });

    const answerCard = Effect.fn("Conversations.answerCard")(function* (
      entryId: EntryId,
      answer: CardAnswer,
    ) {
      const commandId = yield* actions.commandId;
      return yield* actions.run(
        cardAction(entryId),
        entryId,
        connection.call((client) => client["card.answer"]({ commandId, entryId, answer })),
      );
    });

    // No command id: the value must not be kept in a receipt. A retry after a
    // lost reply finds the card closed and fails with `Conflict("card-closed")`.
    const provideSecret = (entryId: EntryId, answer: SecretAnswer) =>
      actions.run(
        cardAction(entryId),
        entryId,
        connection.call((client) => client["secret.provide"]({ entryId, answer })),
      );

    return Conversations.of({
      open: stores.acquire,
      send,
      discard,
      retryMessage,
      retryNotice,
      answerCard,
      provideSecret,
    });
  }),
);
