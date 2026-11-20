// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ApprovalDecision,
  Attachment,
  CommandError,
  CommandId,
  type Entry,
  type EntryId,
  type EntryOrder,
  EntryTarget,
  Mentions,
  type MessageEntry,
  MessageText,
  type QuestionAnswers,
  type Sequence,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
import { ClientStorage, type LocalChange, type LocalStorageError } from "../ports.ts";
import { Cell, type Readable, waitFor } from "../Store.ts";
import { makeKeyed } from "./keyed.ts";

/** How many older entries one scroll back reads. */
const HISTORY_PAGE = 50;

export const targetKey = (target: EntryTarget) =>
  target._tag === "conversation" ? `conversation:${target.botId}` : `room:${target.roomId}`;

/**
 * A message the operator sent from this client that the conversation does not
 * show yet. It disappears when the server's entry for it arrives, matched by
 * its command id, so the message never shows twice. It is kept on the device
 * until the server has it, so a reload or a crash sends it once it can, with
 * the same command id, and never twice. The messages of one conversation or
 * room go one at a time, in the order they were sent.
 */
export interface OutgoingMessage {
  readonly _tag: "outgoing";
  readonly commandId: CommandId;
  readonly target: EntryTarget;
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly mentions: Mentions | null;
  readonly createdAt: DateTime.Utc;
  /**
   * `sending` until the server accepts it, waiting through disconnections;
   * `accepted` once it has, until its entry arrives or the conversation
   * closes: a message sent again after a reload may already be older than
   * the history loaded; `not-sent` when the server refused it or the device
   * is not paired.
   */
  readonly status:
    | { readonly _tag: "sending" }
    | { readonly _tag: "accepted" }
    | { readonly _tag: "not-sent"; readonly failure: IntentFailure };
}

/** An outgoing message the device keeps: one the server has not accepted. */
type KeptMessage = OutgoingMessage & {
  readonly status: Exclude<OutgoingMessage["status"], { readonly _tag: "accepted" }>;
};

const IntentFailureSchema = Schema.Union([
  Schema.TaggedStruct("refused", { error: CommandError }),
  Schema.TaggedStruct("not-paired", {}),
  Schema.TaggedStruct("unexpected", {}),
]);

/** An outgoing message as the device keeps it. */
const StoredOutgoing = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      commandId: CommandId,
      target: EntryTarget,
      text: MessageText,
      attachments: Schema.Array(Attachment),
      mentions: Schema.NullOr(Mentions),
      createdAt: Schema.DateTimeUtc,
      status: Schema.Union([
        Schema.TaggedStruct("sending", {}),
        Schema.TaggedStruct("not-sent", { failure: IntentFailureSchema }),
      ]),
    }),
  ),
);
const encodeStored = Schema.encodeEffect(StoredOutgoing);
const decodeStored = Schema.decodeUnknownOption(StoredOutgoing);

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
  if (message._tag === "outgoing") {
    return message.status._tag === "accepted" ? { _tag: "queued" } : message.status;
  }
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
  /** Moves the operator's read mark forward to `through`, the newest entry they have seen. */
  readonly markRead: (through: EntryOrder) => Effect.Effect<void>;
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
      readonly attachments?: ReadonlyArray<Attachment>;
      readonly mentions?: Mentions;
    }) => Effect.Effect<IntentResult<EntryId>>;
    /**
     * Keeps the message on the device, with `alongside` in the same storage
     * transaction, then shows it and starts sending it as `send` does, without
     * waiting for the server. Fails, showing and sending nothing, when the
     * device cannot keep it. `text` must fit `MAX_MESSAGE_LENGTH`.
     */
    readonly enqueue: (
      input: {
        readonly target: EntryTarget;
        readonly text: string;
        readonly attachments?: ReadonlyArray<Attachment>;
        readonly mentions?: Mentions;
      },
      alongside?: ReadonlyArray<LocalChange>,
    ) => Effect.Effect<void, LocalStorageError>;
    /** Sends again, with its own command id, a message that was not sent. */
    readonly resend: (commandId: CommandId) => Effect.Effect<IntentResult<EntryId>>;
    /** Removes a message that was not sent from the conversation. */
    readonly discard: (commandId: CommandId) => Effect.Effect<void>;
    readonly retryMessage: (entryId: EntryId) => Effect.Effect<IntentResult>;
    readonly retryNotice: (entryId: EntryId) => Effect.Effect<IntentResult>;
    readonly answerCard: (entryId: EntryId, answer: CardAnswer) => Effect.Effect<IntentResult>;
    readonly provideSecret: (entryId: EntryId, answer: SecretAnswer) => Effect.Effect<IntentResult>;
    /**
     * Stops every delivery and drops the outbox, here and on the device. It
     * happens by itself whenever the device has no credential: a message
     * belongs to the pairing that wrote it.
     */
    readonly discardAll: Effect.Effect<void, LocalStorageError>;
  }
>()("@j3-bots/client-runtime/stores/Conversations") {}

export const layer = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const storage = yield* ClientStorage;
    const scope = yield* Scope.Scope;

    // What an earlier launch left unsent, oldest first. Storage that cannot be
    // read leaves the outbox empty, as a fresh device's is.
    const stored = yield* storage
      .readAll("outbox")
      .pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("Unsent messages could not be read", error).pipe(
            Effect.as(new Map<string, string>()),
          ),
        ),
      );
    const restored = [...stored.values()]
      .flatMap((value) => Option.toArray(decodeStored(value)))
      .map((record): KeptMessage => ({ _tag: "outgoing", ...record }))
      .toSorted((a, b) => a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds);

    // Outgoing messages of every target, so a message keeps its place while
    // its conversation is closed and reopened.
    const outbox = new Cell<ReadonlyArray<OutgoingMessage>>(restored);

    const keep = (message: KeptMessage) =>
      encodeStored(message).pipe(
        Effect.flatMap((value) => storage.write("outbox", message.commandId, value)),
        Effect.catchTags({
          LocalStorageError: (error) =>
            Effect.logWarning("An unsent message is kept in memory only", error),
          SchemaError: (error) => Effect.logError("An unsent message could not be encoded", error),
        }),
      );
    const forgetStored = (commandId: CommandId) =>
      storage
        .remove("outbox", commandId)
        .pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("A sent message stays in local storage", error),
          ),
        );

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

        const markRead = (through: EntryOrder) =>
          Effect.suspend(() => {
            if (readThrough !== null && through <= readThrough) return Effect.void;
            readThrough = through;
            return connection
              .call((client) => client["entries.markRead"]({ target, through }))
              .pipe(Effect.ignore);
          });

        const unsubscribe = outbox.subscribe(publish);
        const close = () => {
          unsubscribe();
          // The server has these; the next open reads them with the rest.
          removeOutgoing(
            new Set(
              outbox
                .get()
                .filter(
                  (message) =>
                    message.status._tag === "accepted" && targetKey(message.target) === key,
                )
                .map((message) => message.commandId),
            ),
          );
        };
        const conversation: Conversation = { target, state, loadOlder, markRead };
        return { value: conversation, run, close };
      });

    const stores = makeKeyed(scope, targetKey, openStore);

    const setStatus = (commandId: CommandId, status: OutgoingMessage["status"]) =>
      outbox.update((list) =>
        list.map((message) => (message.commandId === commandId ? { ...message, status } : message)),
      );

    /** Sends `message` until the server answers, through any disconnection, and settles it. */
    const deliverNow = (message: KeptMessage) =>
      connection
        .call((client) =>
          client["message.send"]({
            commandId: message.commandId,
            target: message.target,
            text: message.text,
            attachments: message.attachments.map((attachment) => attachment.id),
            ...(message.mentions === null ? {} : { mentions: message.mentions }),
          }),
        )
        .pipe(
          Effect.exit,
          Effect.flatMap((exit): Effect.Effect<IntentResult<EntryId>> => {
            const result = intentResult(exit);
            if (result._tag === "failed") {
              const status = { _tag: "not-sent", failure: result.failure } as const;
              setStatus(message.commandId, status);
              return keep({ ...message, status }).pipe(Effect.as(result));
            }
            // Its entry replaces it when it arrives. Nothing will show the entry
            // of a closed conversation; the next open reads it with the rest.
            if (stores.isOpen(message.target)) setStatus(message.commandId, { _tag: "accepted" });
            else removeOutgoing(new Set([message.commandId]));
            return forgetStored(message.commandId).pipe(Effect.as(result));
          }),
        );

    // Completes, per target, when its last message given to `deliver` is settled.
    const tails = new Map<string, Deferred.Deferred<void>>();
    const deliveries = yield* FiberSet.make<IntentResult<EntryId>>();

    /**
     * Delivers `message` in a fiber of the client's scope once every earlier
     * message of its target is answered or not sent, so the server records a
     * conversation's messages in the order they were sent. The server applies
     * a command id once, so sending it again after a reload is safe.
     */
    const deliver = (message: KeptMessage) =>
      Effect.suspend(() => {
        const key = targetKey(message.target);
        const previous = tails.get(key);
        const settled = Deferred.makeUnsafe<void>();
        tails.set(key, settled);
        return (previous === undefined ? Effect.void : Deferred.await(previous)).pipe(
          Effect.andThen(deliverNow(message)),
          Effect.ensuring(
            Effect.suspend(() => {
              if (tails.get(key) === settled) tails.delete(key);
              return Deferred.succeed(settled, undefined);
            }),
          ),
          FiberSet.run(deliveries),
        );
      });

    /** The result of a delivery, or `not-paired` if the outbox gave it up. */
    const resultOf = (fiber: Fiber.Fiber<IntentResult<EntryId>>) =>
      Fiber.await(fiber).pipe(
        Effect.map((exit): IntentResult<EntryId> =>
          Exit.isSuccess(exit) ? exit.value : { _tag: "failed", failure: { _tag: "not-paired" } },
        ),
      );

    for (const message of restored) {
      if (message.status._tag === "sending") yield* deliver(message);
    }

    const outgoing = Effect.fn("Conversations.outgoing")(function* (input: {
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments?: ReadonlyArray<Attachment>;
      readonly mentions?: Mentions;
    }) {
      return {
        _tag: "outgoing",
        commandId: yield* actions.commandId,
        target: input.target,
        text: input.text,
        attachments: input.attachments ?? [],
        mentions: input.mentions ?? null,
        createdAt: yield* DateTime.now,
        status: { _tag: "sending" },
      } satisfies KeptMessage;
    });

    /** Shows `message` and starts its delivery. */
    const begin = (message: KeptMessage) =>
      Effect.sync(() => outbox.update((list) => [...list, message])).pipe(
        Effect.andThen(deliver(message)),
      );

    const send = Effect.fn("Conversations.send")(function* (input: Parameters<typeof outgoing>[0]) {
      const message = yield* outgoing(input);
      yield* keep(message);
      return yield* resultOf(yield* begin(message));
    });

    const enqueue = Effect.fn("Conversations.enqueue")(function* (
      input: Parameters<typeof outgoing>[0],
      alongside: ReadonlyArray<LocalChange> = [],
    ) {
      const message = yield* outgoing(input);
      // The caller checked the text's length; nothing else can fail to encode.
      const value = yield* encodeStored(message).pipe(Effect.orDie);
      yield* storage.commit([...alongside, { table: "outbox", key: message.commandId, value }]);
      yield* begin(message);
    });

    const resend = Effect.fn("Conversations.resend")(function* (commandId: CommandId) {
      const message = outbox.get().find((candidate) => candidate.commandId === commandId);
      if (message?.status._tag !== "not-sent") {
        return { _tag: "failed", failure: { _tag: "unexpected" } } as const;
      }
      const sending = { ...message, status: { _tag: "sending" } } as const;
      setStatus(commandId, sending.status);
      yield* keep(sending);
      return yield* resultOf(yield* deliver(sending));
    });

    const discard = (commandId: CommandId) =>
      Effect.suspend(() => {
        const message = outbox.get().find((candidate) => candidate.commandId === commandId);
        if (message?.status._tag !== "not-sent") return Effect.void;
        removeOutgoing(new Set([commandId]));
        return forgetStored(commandId);
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

    const discardAll = Effect.gen(function* () {
      yield* FiberSet.clear(deliveries);
      tails.clear();
      outbox.set([]);
      yield* storage.clear("outbox");
    });

    yield* Effect.gen(function* () {
      while (true) {
        yield* waitFor(connection.state, (state) => state._tag === "unpaired");
        yield* discardAll.pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("Unsent messages stay in local storage", error),
          ),
        );
        yield* waitFor(connection.state, (state) => state._tag !== "unpaired");
      }
    }).pipe(Effect.forkIn(scope));

    return Conversations.of({
      open: stores.acquire,
      send,
      enqueue,
      resend,
      discard,
      retryMessage,
      retryNotice,
      answerCard,
      provideSecret,
      discardAll,
    });
  }),
);
