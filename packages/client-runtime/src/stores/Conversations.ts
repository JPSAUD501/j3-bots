// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ApprovalDecision,
  Attachment,
  CommandError,
  CommandId,
  DeviceId,
  type Entry,
  EntryId,
  type EntryOrder,
  EntryTarget,
  Mentions,
  type MessageEntry,
  MessageText,
  NonNegativeInt,
  type QuestionAnswers,
  type Sequence,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { Connection, type J3RpcClient, NotPaired } from "../connection/Connection.ts";
import { InvalidMessage, messageProblem } from "../files/limits.ts";
import {
  Actions,
  cardAction,
  type IntentFailure,
  type IntentResult,
  retryAction,
} from "../intents/Actions.ts";
import { ClientStorage, type LocalRecord, type LocalStorageError, WindowLocks } from "../ports.ts";
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
 * room go one at a time, in the order they were sent, whichever window of the
 * client sent them.
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
   * `accepted` once it has, until its entry arrives, the conversation shows
   * history past it, or the conversation closes; `not-sent` when the server
   * refused it. `unrecorded` when the server answered and the device could
   * not record the answer: this window tries again every `OutboxSweep`,
   * connected or not, and sends nothing again. A message sent again after a
   * reload leaves once accepted: its entry may be older than the history
   * loaded, and shows where it belongs.
   */
  readonly status:
    | { readonly _tag: "sending" }
    | { readonly _tag: "accepted" }
    | { readonly _tag: "not-sent"; readonly failure: IntentFailure }
    | { readonly _tag: "unrecorded" };
}

/** An outgoing message as the device keeps it: one the server has not accepted. */
type KeptMessage = OutgoingMessage & {
  readonly status: { readonly _tag: "sending" } | { readonly _tag: "not-sent" };
};

/**
 * An outgoing message as this window holds it, and the pairing it belongs to.
 * `kept` is the device's record of it as this window last read it, with the
 * stored value a claim on it expects; null for a message the device could
 * not keep, which this window alone holds and sends.
 */
interface Held {
  readonly message: OutgoingMessage;
  readonly pairing: DeviceId;
  readonly kept: { readonly record: StoredMessage; readonly value: string } | null;
}

/**
 * A held message that is due: the server has not answered it, or this
 * window has its answer and the device does not yet.
 */
type Due = Held & {
  readonly message: OutgoingMessage & {
    readonly status: { readonly _tag: "sending" } | { readonly _tag: "unrecorded" };
  };
};

/** A due message the device keeps. */
type KeptDue = Due & { readonly kept: NonNullable<Held["kept"]> };

const isRpcClientError = Schema.is(RpcClientError);

const IntentFailureSchema = Schema.Union([
  Schema.TaggedStruct("refused", { error: CommandError }),
  Schema.TaggedStruct("not-paired", {}),
  Schema.TaggedStruct("unexpected", {}),
]);

/**
 * Why each earlier attempt to deliver a message failed, in order: the attempt
 * under way, or the one that settled it, is the next. Each attempt is sent
 * again only once it failed, so every attempt leaves its own record, and a
 * window waiting on one still finds what became of it after another window
 * sent the message again.
 */
const Failures = Schema.Array(IntentFailureSchema);

const StoredMessage = Schema.TaggedStruct("message", {
  commandId: CommandId,
  /** The pairing that kept it. */
  pairing: DeviceId,
  target: EntryTarget,
  text: MessageText,
  attachments: Schema.Array(Attachment),
  mentions: Schema.NullOr(Mentions),
  createdAt: Schema.DateTimeUtc,
  /** Its place in the device's queue, given in the transaction that kept it. */
  sequence: NonNegativeInt,
  failures: Failures,
  status: Schema.Union([
    Schema.TaggedStruct("sending", {}),
    Schema.TaggedStruct("not-sent", { failure: IntentFailureSchema }),
  ]),
});
type StoredMessage = typeof StoredMessage.Type;

/**
 * What became of a message the device no longer keeps, so a window that
 * still shows it can tell a delivered message from a discarded one. It is
 * removed after `SETTLED_KEPT`.
 */
const StoredSettled = Schema.TaggedStruct("settled", {
  commandId: CommandId,
  pairing: DeviceId,
  /** For a discarded message, every attempt; for an accepted one, those before the one accepted. */
  failures: Failures,
  outcome: Schema.Union([
    Schema.TaggedStruct("accepted", { entryId: EntryId }),
    Schema.TaggedStruct("discarded", {}),
  ]),
  at: Schema.DateTimeUtc,
});

/** One record of the outbox table, under its message's command id. */
const StoredRecord = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Union([StoredMessage, StoredSettled])),
);
type StoredRecord = typeof StoredRecord.Type;
const encodeRecord = Schema.encodeEffect(StoredRecord);
const decodeRecord = Schema.decodeUnknownOption(StoredRecord);

/** The outbox table's counter, under its own key: the sequence the next message takes. */
const COUNTER_KEY = "next-sequence";
const StoredCounter = Schema.fromJsonString(Schema.Struct({ next: NonNegativeInt }));
const encodeCounter = Schema.encodeSync(StoredCounter);
const decodeCounter = Schema.decodeUnknownOption(StoredCounter);

/**
 * How long the outcome of a message stays recorded: far longer than any
 * window takes to read the outbox again while it runs (at once when told, at
 * every reconnection, every `OutboxSweep` while connected).
 */
const SETTLED_KEPT = Duration.minutes(10);

/**
 * How a delivery tries again to record the server's answer when the device
 * fails to: three more times within about a seventh of a second, while it
 * holds the conversation's lock. After that, the window keeps the answer and
 * tries again every `OutboxSweep`, connected or not: recording needs no
 * socket.
 */
const RECORD_RETRY = { schedule: Schedule.exponential("20 millis"), times: 3 };

/**
 * How often a connected window reads the outbox and sends what is due, on
 * top of being told by the window that changed it. A window can close between
 * keeping a message and telling the others, so this bounds how long such a
 * message waits. Five seconds costs one read of a small table, and nothing
 * else when nothing is due. A window holding an answer the device could not
 * record tries again as often, connected or not.
 */
export class OutboxSweep extends Context.Reference<Duration.Duration>(
  "@j3-bots/client-runtime/stores/Conversations/OutboxSweep",
  { defaultValue: () => Duration.seconds(5) },
) {}

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
  /** The server answered, and this device could not record the answer yet. */
  | { readonly _tag: "unrecorded" }
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
 *
 * One rule keeps the outbox whole across windows: the stored outbox records
 * are the only truth about unsent messages. Every window's list of outgoing
 * messages is a projection of storage, read again whenever another window
 * changes the outbox, after each read a delivery makes, and on every
 * connection. Delivery, resend and discard act on the stored record, claimed
 * with the state they expect in one storage transaction, so a window that
 * missed a change does nothing rather than undo it. A window's memory is used
 * only for a message whose own persistence failed. A delivery runs only on a
 * live connection, and holds a conversation's lock only while that
 * connection lives.
 *
 * Every attempt to deliver a message has its own persisted revision, and its
 * record keeps why each earlier attempt failed. A claim (Retry, Discard,
 * recording an answer) names the revision it expects. A caller waiting on an
 * attempt is answered only from storage that reflects that attempt, with what
 * became of that attempt, even after another window sent the message again.
 * The command id stays the same across attempts, so the server applies the
 * message once. Recording the server's answer is part of the attempt: the
 * delivery keeps the conversation's lock until the device holds it, and the
 * list shows the outcome before the delivery ends, even when its socket
 * closed meanwhile. A window that has an answer the device could not record
 * records it rather than send the attempt again, and tries on its own
 * schedule, without a socket.
 *
 * Every record belongs to the pairing that kept it, and a window only ever
 * shows, keeps or sends the messages of the pairing it follows. The outbox
 * holds that pairing of its own, which changes, in turn with keeping a
 * message, only once the window dropped every message it held: each read
 * projects only that pairing's records, each message is kept as that
 * pairing's, and every transaction that writes a record checks that the
 * device's credential is still the record's pairing. A message goes only on
 * a socket opened with its own pairing. A window that learns late that its
 * pairing ended therefore writes and sends nothing of it, and another
 * pairing's record, which no erasing removed, is never shown or sent.
 *
 * When the pairing a window follows changes, the window drops its messages,
 * erases the device's records of the pairing that ended, and only those, and
 * reads those of the pairing it follows now. Nothing of the pairing that
 * ended shows from the moment the pairing changes, though dropping its
 * messages may wait for an answer being recorded under it. Erasing is
 * cleanup: when it fails, nothing of that pairing shows or goes anyway. At launch, the records
 * of every pairing the device no longer holds go: a window can close before
 * it erased them.
 *
 * An accepted message leaves the list once the conversation shows its entry,
 * or once a read of the conversation started after this window knew the
 * server had it holds no such entry: the entry is then older than the loaded
 * history, where scrolling back finds it.
 */
export class Conversations extends Context.Service<
  Conversations,
  {
    /** Opens the conversation for as long as the scope lasts. Users of one target share it. */
    readonly open: (target: EntryTarget) => Effect.Effect<Conversation, never, Scope.Scope>;
    /**
     * Shows the message at once and sends it, through any disconnection,
     * exactly once. Succeeds with the new entry's id when the server has it.
     * Fails with `InvalidMessage`, sending nothing, when it breaks a limit of
     * `message.send`. A message the device cannot keep is sent from memory.
     */
    readonly send: (input: {
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments?: ReadonlyArray<Attachment>;
      readonly mentions?: Mentions;
    }) => Effect.Effect<IntentResult<EntryId>, InvalidMessage>;
    /**
     * Keeps the message on the device, with the `claim`'s `alongside` in the
     * same storage transaction, then shows it and starts sending it as `send`
     * does, without waiting for the server. Succeeds with `false`, keeping,
     * showing and sending nothing, when a record of `expected` no longer
     * holds the value given; fails the same way when the device cannot keep
     * it, with `NotPaired` without a pairing, with another than the claim's,
     * or once the pairing ended, or with `InvalidMessage` when it breaks a
     * limit of `message.send`.
     */
    readonly enqueue: (
      input: {
        readonly target: EntryTarget;
        readonly text: string;
        readonly attachments?: ReadonlyArray<Attachment>;
        readonly mentions?: Mentions;
      },
      claim?: {
        /** The pairing `alongside` belongs to: with another, it fails with `NotPaired`. */
        readonly pairing: DeviceId;
        readonly alongside: ReadonlyArray<LocalRecord>;
        readonly expected: ReadonlyArray<LocalRecord>;
      },
    ) => Effect.Effect<boolean, LocalStorageError | InvalidMessage | NotPaired>;
    /**
     * Sends again, with its own command id, a message that was not sent. Does
     * nothing when the device no longer keeps it as not sent: another window
     * sent it again or discarded it.
     */
    readonly resend: (commandId: CommandId) => Effect.Effect<IntentResult<EntryId>>;
    /**
     * Removes a message that was not sent from the conversation, unless the
     * device no longer keeps it as not sent.
     */
    readonly discard: (commandId: CommandId) => Effect.Effect<void>;
    readonly retryMessage: (entryId: EntryId) => Effect.Effect<IntentResult>;
    readonly retryNotice: (entryId: EntryId) => Effect.Effect<IntentResult>;
    readonly answerCard: (entryId: EntryId, answer: CardAnswer) => Effect.Effect<IntentResult>;
    readonly provideSecret: (entryId: EntryId, answer: SecretAnswer) => Effect.Effect<IntentResult>;
    /**
     * Runs `effect` with every delivery stopped, and starts again what is
     * left to send once it ends. Messages sent meanwhile wait.
     */
    readonly withSendingPaused: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * Stops every delivery and erases every message of `pairing` on the
     * device, and drops every message here while this window still follows
     * it. It happens by itself whenever the pairing ends: a message belongs
     * to the pairing that wrote it.
     */
    readonly discardAll: (pairing: DeviceId | null) => Effect.Effect<void, LocalStorageError>;
  }
>()("@j3-bots/client-runtime/stores/Conversations") {}

export const layer = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const storage = yield* ClientStorage;
    const locks = yield* WindowLocks;
    const sweep = yield* OutboxSweep;
    const scope = yield* Scope.Scope;

    // Outgoing messages of every target, in the order of the device's queue,
    // so a message keeps its place while its conversation is closed and reopened.
    const outbox = new Cell<ReadonlyArray<Held>>([]);
    // The pairing whose messages this window holds, or null for none. It
    // changes, in turn with keeping a message, in the same step as the list
    // is emptied.
    let followed = connection.pairing.get();
    // Sent again after a reload: once accepted, their entries show where the history puts them.
    const replays = new Set<CommandId>();

    const removeOutgoing = (commandIds: ReadonlySet<CommandId>) => {
      if (!outbox.get().some((held) => commandIds.has(held.message.commandId))) return;
      outbox.update((list) => list.filter((held) => !commandIds.has(held.message.commandId)));
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
        // Each subscription this store started is a read of the conversation,
        // numbered; `applied` is the latest whose first frame it holds.
        let reads = 0;
        let applied = 0;
        // Its accepted messages, with the reads it had started when it learned of each.
        const acceptedAt = new Map<CommandId, number>();
        // Open when an accepted message waits for a read started after it.
        const recheck = Latch.makeUnsafe(false);

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
          // From the moment the pairing changes, nothing of the one that ended
          // shows, though dropping its messages may wait for an answer being
          // recorded under it.
          const held = connection.pairing.get() === followed ? outbox.get() : [];
          const outgoing = held
            .map((item) => item.message)
            .filter((message) => targetKey(message.target) === key && !sent.has(message.commandId));
          return { phase, stale, items: [...sorted(), ...outgoing], hasOlder, loadingOlder };
        };
        const state = new Cell<ConversationState>(project());
        const publish = () => state.set(project());

        const take = (entry: Entry) => {
          entries.set(entry.id, entry);
          actions.entryChanged(entry.id);
        };

        /**
         * Takes out every outgoing message whose entry is here, and every
         * accepted one a read started after it was accepted shows no entry
         * for: the server put it before the history loaded.
         */
        const settle = () => {
          const done = confirmed();
          for (const [commandId, at] of acceptedAt) if (at < applied) done.add(commandId);
          removeOutgoing(done);
          publish();
        };

        /** Applies `frame`; `read` is the read it is the first frame of, if it is. */
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
          read: number | null,
        ) => {
          if (frame._tag === "snapshot") {
            // Replaces everything: the server could not tell what changed.
            entries.clear();
            for (const entry of frame.entries) take(entry);
            hasOlder = frame.hasOlder;
            loadingOlder = false;
            epoch += 1;
            phase = "ready";
            sequence = frame.sequence;
          } else if (sequence === null || frame.sequence > sequence) {
            for (const entry of frame.upsert) take(entry);
            sequence = frame.sequence;
          }
          // The first frame of a read says how things stood when it started, even when nothing changed.
          if (read !== null) applied = read;
          stale = false;
          settle();
        };

        /**
         * Follows the conversation on `client`, and subscribes again, resuming
         * from what it holds, whenever an accepted message needs a newer read.
         */
        const follow = (client: J3RpcClient) =>
          Effect.suspend(() => {
            recheck.closeUnsafe();
            const read = ++reads;
            let first = true;
            return client["entries.subscribe"]({ target, after: sequence }).pipe(
              Stream.runForEach((frame) =>
                Effect.sync(() => {
                  onFrame(frame, first ? read : null);
                  first = false;
                }),
              ),
              Effect.as(false),
              Effect.raceFirst(recheck.await.pipe(Effect.as(true))),
            );
          }).pipe(Effect.repeat({ while: (rechecked) => rechecked }));

        const run = connection
          .eachSession((client) =>
            Effect.suspend(() => {
              // A resumed subscription sends only what changed, which may be nothing.
              if (sequence !== null) {
                stale = false;
                publish();
              }
              return follow(client).pipe(
                Effect.asVoid,
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

        /**
         * Notes when this store learns that the server accepted a message to
         * this conversation. One whose entry it does not hold may be on its
         * way, or older than the history loaded: only a read started from
         * then on can tell, so it asks for one.
         */
        const onOutbox = () => {
          const sent = confirmed();
          const accepted = new Set<CommandId>();
          for (const { message } of outbox.get()) {
            if (targetKey(message.target) !== key || message.status._tag !== "accepted") continue;
            accepted.add(message.commandId);
            if (acceptedAt.has(message.commandId)) continue;
            acceptedAt.set(message.commandId, reads);
            if (!sent.has(message.commandId)) recheck.openUnsafe();
          }
          for (const commandId of acceptedAt.keys()) {
            if (!accepted.has(commandId)) acceptedAt.delete(commandId);
          }
          // One whose entry is already here goes now.
          settle();
        };
        const unsubscribe = outbox.subscribe(onOutbox);
        const unsubscribePairing = connection.pairing.subscribe(publish);
        const close = () => {
          unsubscribe();
          unsubscribePairing();
          // The server has these; the next open reads them with the rest.
          removeOutgoing(
            new Set(
              outbox
                .get()
                .map((held) => held.message)
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

    /**
     * A caller of `send` or `resend` waiting for the result of its attempt,
     * the `attempt`th to deliver the message. `after` is the number of outbox
     * reads started when it began to wait, after its attempt was claimed:
     * only a later read reflects that attempt.
     */
    interface Waiter {
      readonly commandId: CommandId;
      readonly attempt: number;
      readonly after: number;
      readonly result: Deferred.Deferred<IntentResult<EntryId>>;
    }
    const waiting = new Set<Waiter>();
    // Outbox reads started, in the order they start.
    let reads = 0;
    const answer = (waiter: Waiter, result: IntentResult<EntryId>) => {
      waiting.delete(waiter);
      return Deferred.succeed(waiter.result, result);
    };
    const settleWaiting = (commandId: CommandId, result: IntentResult<EntryId>) =>
      Effect.forEach(
        [...waiting].filter((waiter) => waiter.commandId === commandId),
        (waiter) => answer(waiter, result),
        { discard: true },
      );
    /** The result of the attempt to deliver `commandId` this caller just claimed, once it has one. */
    const awaitResult = (commandId: CommandId, attempt: number) => {
      const waiter: Waiter = { commandId, attempt, after: reads, result: Deferred.makeUnsafe() };
      waiting.add(waiter);
      return Deferred.await(waiter.result);
    };
    const unexpected: IntentResult<EntryId> = { _tag: "failed", failure: { _tag: "unexpected" } };

    /** What became of the `attempt`th attempt to deliver a message, by its record; null while under way. */
    const outcomeOf = (
      record: StoredRecord | undefined,
      attempt: number,
    ): IntentResult<EntryId> | null => {
      if (record === undefined) return unexpected;
      const failure = record.failures[attempt];
      if (failure !== undefined) return { _tag: "failed", failure };
      if (attempt !== record.failures.length) return unexpected;
      if (record._tag === "message") {
        return record.status._tag === "sending"
          ? null
          : { _tag: "failed", failure: record.status.failure };
      }
      return record.outcome._tag === "accepted"
        ? { _tag: "done", value: record.outcome.entryId }
        : unexpected;
    };

    // Answers the server gave that the device could not record, by command id,
    // with the attempt each answers.
    const unrecorded = new Map<
      CommandId,
      { readonly due: KeptDue; readonly result: IntentResult<EntryId> }
    >();
    // Asks this window to try again what the device failed to do: record what
    // `unrecorded` holds, or read the outbox. One pending ask is enough.
    const tryAgain = yield* Queue.sliding<void>(1);
    // The last read of the outbox failed, so the list may not show what the device keeps.
    let readFailed = false;

    const queueOrder = (a: Held, b: Held) => {
      if (a.kept === null) return b.kept === null ? 0 : 1;
      if (b.kept === null) return -1;
      return a.kept.record.sequence - b.kept.record.sequence;
    };
    const heldOf = (record: StoredMessage, value: string): Held => ({
      pairing: record.pairing,
      message: {
        _tag: "outgoing",
        commandId: record.commandId,
        target: record.target,
        text: record.text,
        attachments: record.attachments,
        mentions: record.mentions,
        createdAt: record.createdAt,
        status:
          record.status._tag === "sending" &&
          unrecorded.get(record.commandId)?.due.kept.value === value
            ? { _tag: "unrecorded" }
            : record.status,
      },
      kept: { record, value },
    });
    const isDue = (held: Held): held is Due =>
      held.message.status._tag === "sending" || held.message.status._tag === "unrecorded";
    /** Changes the status of the held messages `which` picks. */
    const setStatus = (which: (held: Held) => boolean, status: OutgoingMessage["status"]) =>
      outbox.update((list) =>
        list.map((held) =>
          which(held) ? { ...held, message: { ...held.message, status } } : held,
        ),
      );
    /** Changes the status of a message the device does not keep, which only this window holds. */
    const setUnkeptStatus = (commandId: CommandId, status: OutgoingMessage["status"]) =>
      setStatus((held) => held.message.commandId === commandId, status);

    /**
     * Makes this window's list a projection of `stored`, the records of
     * `pairing` as the device keeps them, read as the `read`th read, and
     * settles every caller whose attempt has an outcome there. A message this
     * window alone holds keeps its own state, and so does one accepted, until
     * its entry arrives, history passes it, or its conversation closes. Does
     * nothing once this window follows another pairing: the check and the
     * projection run in one step.
     */
    const reconcile = Effect.fnUntraced(function* (
      stored: ReadonlyMap<string, { record: StoredRecord; value: string }>,
      read: number,
      pairing: DeviceId | null,
    ) {
      if (followed !== pairing) return;
      // An answer the device holds now, or one for an attempt it no longer keeps, is done with.
      for (const [commandId, { due }] of unrecorded) {
        if (stored.get(commandId)?.value !== due.kept.value) unrecorded.delete(commandId);
      }
      const held = outbox.get();
      const next: Array<Held> = [];
      for (const item of held) {
        const { message } = item;
        if (item.kept === null || message.status._tag === "accepted") {
          next.push(item);
          continue;
        }
        const kept = stored.get(message.commandId);
        if (kept?.record._tag === "message") {
          const current = heldOf(kept.record, kept.value);
          next.push(
            kept.value === item.kept.value && current.message.status._tag === message.status._tag
              ? item
              : current,
          );
        } else if (
          kept?.record._tag === "settled" &&
          kept.record.outcome._tag === "accepted" &&
          stores.isOpen(message.target) &&
          !replays.has(message.commandId)
        ) {
          // Its entry replaces it when it arrives. Nothing will show the entry
          // of a closed conversation, and a replayed one may be older than the
          // history loaded: the next read shows it where it belongs.
          next.push({ ...item, message: { ...message, status: { _tag: "accepted" } } });
        }
        // Otherwise it was delivered elsewhere, discarded, or dropped: it goes.
      }
      const shown = new Set(next.map((item) => item.message.commandId));
      for (const { record, value } of stored.values()) {
        if (record._tag === "message" && !shown.has(record.commandId)) {
          next.push(heldOf(record, value));
        }
      }
      const ordered = next.toSorted(queueOrder);
      if (ordered.length !== held.length || ordered.some((item, index) => item !== held[index])) {
        outbox.set(ordered);
      }

      const unkept = new Set(
        ordered.flatMap((item) => (item.kept === null ? [item.message.commandId] : [])),
      );
      const outcomes: Array<readonly [Waiter, IntentResult<EntryId>]> = [];
      for (const waiter of waiting) {
        // A read started before the attempt was claimed knows nothing of it.
        if (read <= waiter.after || unkept.has(waiter.commandId)) continue;
        const outcome = outcomeOf(stored.get(waiter.commandId)?.record, waiter.attempt);
        if (outcome !== null) outcomes.push([waiter, outcome]);
      }
      yield* Effect.forEach(outcomes, ([waiter, result]) => answer(waiter, result), {
        discard: true,
      });
    });

    /**
     * Reads the outbox, makes this window's list follow it, removes outcomes
     * older than `SETTLED_KEPT`, and returns what is due, in queue order:
     * every message the device keeps that the server has not answered, or
     * whose answer only this window has, then those this window alone holds.
     * One read at a time, so each projection is at least as new as the one
     * before. Storage that cannot be read leaves the list as it is, and only
     * this window's own messages due.
     */
    const refreshLock = Semaphore.makeUnsafe(1);
    const refresh: Effect.Effect<ReadonlyArray<Due>> = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        const read = ++reads;
        const pairing = followed;
        const records = yield* storage.readAll("outbox");
        const now = yield* DateTime.now;
        const stored = new Map<string, { record: StoredRecord; value: string }>();
        const expired: Array<LocalRecord> = [];
        for (const [key, value] of records) {
          if (key === COUNTER_KEY) continue;
          const decoded = decodeRecord(value);
          // Another pairing's record is not this window's to show, send or remove.
          if (Option.isNone(decoded) || decoded.value.pairing !== pairing) continue;
          const record = decoded.value;
          if (
            record._tag === "settled" &&
            now.epochMilliseconds - record.at.epochMilliseconds > Duration.toMillis(SETTLED_KEPT)
          ) {
            expired.push({ table: "outbox", key, value });
            continue;
          }
          stored.set(key, { record, value });
        }
        yield* reconcile(stored, read, pairing);
        if (expired.length > 0) {
          yield* storage
            .commit(
              expired.map((record) => ({ ...record, value: null })),
              expired,
            )
            .pipe(
              Effect.catchTag("LocalStorageError", (error) =>
                Effect.logWarning("Outcomes of sent messages stay in local storage", error),
              ),
            );
        }
      }).pipe(
        Effect.as(true),
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("Unsent messages could not be read", error).pipe(Effect.as(false)),
        ),
        // Nothing else may read it again soon: a window offline is told nothing.
        Effect.tap((read) =>
          Effect.sync(() => {
            readFailed = !read;
            if (!read) Queue.offerUnsafe(tryAgain, undefined);
          }),
        ),
        Effect.map((read) =>
          outbox
            .get()
            .filter(isDue)
            .filter((held) => read || held.kept === null),
        ),
      ),
    );

    /**
     * Keeps `message` on the device as the last of its queue, as `pairing`'s,
     * with `alongside`, in one transaction that claims `expected`, the queue's
     * counter, and the device's credential as `pairing`'s. Succeeds with
     * `false`, writing nothing, when a record of `expected` no longer holds or
     * the pairing ended; tries again when only the counter moved, taken by
     * another window's message.
     */
    const keep = Effect.fnUntraced(function* (
      message: KeptMessage,
      pairing: DeviceId,
      alongside: ReadonlyArray<LocalRecord>,
      expected: ReadonlyArray<LocalRecord>,
    ) {
      const counterOf = storage
        .readAll("outbox")
        .pipe(Effect.map((records) => records.get(COUNTER_KEY) ?? null));
      let counter = yield* counterOf;
      while (true) {
        const sequence =
          counter === null
            ? 0
            : Option.match(decodeCounter(counter), { onNone: () => 0, onSome: ({ next }) => next });
        // The message passed `messageProblem`, so nothing in it can fail to encode.
        const value = yield* encodeRecord({
          ...message,
          _tag: "message",
          pairing,
          sequence,
          failures: [],
        }).pipe(Effect.orDie);
        const claimed = yield* storage.commit(
          [
            ...alongside,
            { table: "outbox", key: message.commandId, value },
            { table: "outbox", key: COUNTER_KEY, value: encodeCounter({ next: sequence + 1 }) },
          ],
          [...expected, { table: "outbox", key: COUNTER_KEY, value: counter }],
          pairing,
        );
        if (claimed) return true;
        const now = yield* counterOf;
        if (now === counter) return false;
        counter = now;
      }
    });

    /** The answer to one `message.send`, or `disconnected` when the socket gave none. */
    const answerOf = (
      exit: Exit.Exit<EntryId, CommandError | RpcClientError>,
    ): IntentResult<EntryId> | "disconnected" => {
      if (Exit.isSuccess(exit)) return { _tag: "done", value: exit.value };
      if (Cause.hasInterruptsOnly(exit.cause)) return "disconnected";
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isNone(error)) return unexpected;
      if (isRpcClientError(error.value)) return "disconnected";
      return { _tag: "failed", failure: { _tag: "refused", error: error.value } };
    };

    /** The lock one window holds while it sends a conversation's messages, or records an answer to one. */
    const lockOf = (key: string) => `j3-bots/outbox/${key}`;

    /**
     * Records what the server answered for `due`: on the device, claiming the
     * attempt it answers, or in memory for a message this window alone holds.
     * A device that fails to record it is asked again a few times; after
     * that, this window keeps the answer, shows the message as unrecorded,
     * and tries again every `OutboxSweep`, instead of sending it again. Then
     * it reads the outbox, which shows the outcome and settles its callers,
     * and returns what is due. Runs to its end once started: the answer is
     * part of the attempt, and the list shows it even when the delivery that
     * asked ends with its socket.
     */
    const recordAnswer = (due: Due, result: IntentResult<EntryId>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { message, kept } = due;
          if (kept === null) {
            if (result._tag === "failed") {
              setUnkeptStatus(message.commandId, { _tag: "not-sent", failure: result.failure });
            } else if (stores.isOpen(message.target)) {
              setUnkeptStatus(message.commandId, { _tag: "accepted" });
            } else {
              removeOutgoing(new Set([message.commandId]));
            }
            yield* settleWaiting(message.commandId, result);
            return yield* refresh;
          }
          const { record } = kept;
          const outcome: StoredRecord =
            result._tag === "done"
              ? {
                  _tag: "settled",
                  commandId: message.commandId,
                  pairing: record.pairing,
                  failures: record.failures,
                  outcome: { _tag: "accepted", entryId: result.value },
                  at: yield* DateTime.now,
                }
              : { ...record, status: { _tag: "not-sent", failure: result.failure } };
          // It was read from the device, so it encodes again.
          const value = yield* encodeRecord(outcome).pipe(Effect.orDie);
          // Not holding means another window recorded this attempt, or moved
          // on from it, or the pairing ended, and its records go.
          const recorded = yield* storage
            .commit(
              [{ table: "outbox", key: message.commandId, value }],
              [{ table: "outbox", key: message.commandId, value: kept.value }],
              record.pairing,
            )
            .pipe(
              Effect.retry(RECORD_RETRY),
              Effect.as(true),
              Effect.catchTag("LocalStorageError", (error) =>
                Effect.logWarning(
                  "The server's answer to a message is not recorded yet",
                  error,
                ).pipe(Effect.as(false)),
              ),
            );
          if (recorded) {
            unrecorded.delete(message.commandId);
          } else {
            unrecorded.set(message.commandId, { due: { ...due, kept }, result });
            // Shown at once: the read below may fail as the write did.
            setStatus((held) => held.kept?.value === kept.value, { _tag: "unrecorded" });
            yield* Queue.offer(tryAgain, undefined);
          }
          return yield* refresh;
        }),
      );

    /**
     * Sends `due` on `client`, records the answer, and returns what is due
     * then; null when the socket gave no answer.
     */
    const deliver = (due: Due, client: J3RpcClient) =>
      client["message.send"]({
        commandId: due.message.commandId,
        target: due.message.target,
        text: due.message.text,
        attachments: due.message.attachments.map((attachment) => attachment.id),
        ...(due.message.mentions === null ? {} : { mentions: due.message.mentions }),
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          const answer = answerOf(exit);
          return answer === "disconnected" ? Effect.succeed(null) : recordAnswer(due, answer);
        }),
      );

    /**
     * A socket deliveries run on, with them, while it is open, and the
     * targets it is sending, and those given more to send meanwhile. They end
     * with the socket.
     */
    interface Session {
      readonly client: J3RpcClient;
      /** The pairing the socket was opened with: only that pairing's messages go on it. */
      readonly pairing: DeviceId;
      readonly deliveries: FiberSet.FiberSet<void>;
      readonly draining: Set<string>;
      readonly again: Set<string>;
    }

    /**
     * Sends what `key` has left on `session`, one message at a time, while
     * this window holds the conversation's lock: one window sends a
     * conversation's messages at a time, so the server records them in the
     * order they were kept. It reads them after taking the lock, once the
     * window before it recorded what it delivered, so a kept message goes
     * once. An answer this window has and the device does not, it records
     * instead of sending again. Succeeds with `false` when the socket gave no
     * answer: the attempt stays due, under the same command id, for the next
     * socket or another window.
     */
    const drain = (key: string, session: Session) =>
      locks.withLock(
        lockOf(key),
        Effect.gen(function* () {
          const tried = new Set<CommandId>();
          session.again.delete(key);
          let due = yield* refresh;
          while (true) {
            const next = due.find(
              (item) =>
                item.pairing === session.pairing &&
                targetKey(item.message.target) === key &&
                !tried.has(item.message.commandId),
            );
            if (next === undefined) return true;
            tried.add(next.message.commandId);
            // What is due is read again once the answer is recorded.
            session.again.delete(key);
            const known = unrecorded.get(next.message.commandId);
            const after =
              known !== undefined && known.due.kept.value === next.kept?.value
                ? yield* recordAnswer(next, known.result)
                : yield* deliver(next, session.client);
            if (after === null) return false;
            due = after;
          }
        }),
      );

    // A `sweep` after the device failed, records the answers it could not
    // record, and reads the outbox again if the last read failed. Each answer
    // waits for its conversation's lock, so it never runs beside a delivery,
    // and on its own: a lock another window holds keeps no other answer waiting.
    const recording = new Set<CommandId>();
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(tryAgain);
        yield* Effect.sleep(sweep);
        for (const [commandId, { due, result }] of unrecorded) {
          if (recording.has(commandId)) continue;
          recording.add(commandId);
          yield* locks
            .withLock(
              lockOf(targetKey(due.message.target)),
              Effect.suspend(() =>
                unrecorded.get(commandId)?.due === due ? recordAnswer(due, result) : Effect.void,
              ),
            )
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  recording.delete(commandId);
                  // A newer answer to it waited for this one.
                  if (unrecorded.has(commandId)) Queue.offerUnsafe(tryAgain, undefined);
                }),
              ),
              Effect.forkIn(scope),
            );
        }
        if (readFailed) yield* refresh;
      }
    }).pipe(Effect.forkIn(scope));

    /**
     * Erases the device's records of the pairings `ended` names, each claimed
     * as read, so a record another window wrote meanwhile stays. `ended` is
     * asked after each read of the outbox. The counter goes with the last of
     * them: with no message left to order, the next one may start again from
     * the first sequence.
     */
    const eraseWhere = Effect.fn("Conversations.eraseWhere")(function* <E>(
      ended: Effect.Effect<(pairing: DeviceId) => boolean, E>,
    ) {
      while (true) {
        const records = yield* storage.readAll("outbox");
        const isEnded = yield* ended;
        const owned = [...records].flatMap(([key, value]): ReadonlyArray<LocalRecord> =>
          Option.exists(decodeRecord(value), (record) => isEnded(record.pairing))
            ? [{ table: "outbox", key, value }]
            : [],
        );
        const counter = records.get(COUNTER_KEY);
        if (counter !== undefined && owned.length === records.size - 1) {
          owned.push({ table: "outbox", key: COUNTER_KEY, value: counter });
        }
        if (owned.length === 0) return;
        const erased = yield* storage.commit(
          owned.map((record) => ({ ...record, value: null })),
          owned,
        );
        if (erased) return;
      }
    });
    const erase = (pairing: DeviceId) =>
      eraseWhere(Effect.succeed((owner: DeviceId) => owner === pairing));

    // A window can close after its pairing ended and before it erased that
    // pairing's records. They go before anything shows or sends them. The
    // credential is read after the records: a record was kept after its
    // pairing was saved, so one whose pairing the device no longer holds
    // belongs to a pairing that ended.
    yield* eraseWhere(
      Effect.map(connection.storedPairing, (stored) => (owner: DeviceId) => owner !== stored),
    ).pipe(
      Effect.catchTags({
        LocalStorageError: (error) =>
          Effect.logWarning("Unsent messages of a pairing that ended stay in local storage", error),
        CredentialStorageError: (error) =>
          Effect.logWarning(
            "Unsent messages are kept: the device's pairing could not be read",
            error,
          ),
      }),
    );

    // Keeping a message and erasing a pairing's records take turns, so no
    // message is kept for a pairing whose records were already erased.
    const pairingLock = Semaphore.makeUnsafe(1);
    const withPairing = pairingLock.withPermits(1);

    // What an earlier launch left unsent, for the pairing this window starts
    // with. Each goes once accepted: its entry may be older than the history
    // a conversation loads.
    yield* refresh;
    for (const held of outbox.get()) replays.add(held.message.commandId);

    // Asks this window to read the outbox and send what is due. One pending wake is enough.
    const wakes = yield* Queue.sliding<void>(1);
    const wake = Effect.asVoid(Queue.offer(wakes, undefined));
    let live: Session | null = null;
    let pauses = 0;

    /**
     * Has this window send what is due, on the open socket, unless sending is
     * paused or the socket is another pairing's than the one this window follows.
     */
    const startDeliveries = (due: ReadonlyArray<Due>) =>
      Effect.suspend(() => {
        const session = live;
        if (session === null || pauses > 0 || session.pairing !== followed) return Effect.void;
        const keys = new Set(due.map((item) => targetKey(item.message.target)));
        return Effect.forEach(
          keys,
          (key) => {
            if (session.draining.has(key)) {
              session.again.add(key);
              return Effect.void;
            }
            session.draining.add(key);
            return drain(key, session).pipe(
              Effect.ensuring(Effect.sync(() => session.draining.delete(key))),
              Effect.tap((finished) => (finished && session.again.has(key) ? wake : Effect.void)),
              Effect.asVoid,
              FiberSet.run(session.deliveries),
            );
          },
          { discard: true },
        );
      });

    // Reads the outbox and sends what is due whenever this window is woken.
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(wakes);
        yield* startDeliveries(yield* refresh);
      }
    }).pipe(Effect.forkIn(scope));
    // Another window changed the outbox.
    yield* storage.changes.pipe(
      Stream.filter((table) => table === "outbox"),
      Stream.runForEach(() => wake),
      Effect.forkIn(scope),
    );
    // Each socket, while it is open: deliveries run on it and end with it,
    // letting go of their locks, and the outbox is read at once and every
    // `sweep`. An offline window holds no lock.
    yield* connection
      .eachSession((client, pairing) =>
        Effect.gen(function* () {
          const session: Session = {
            client,
            pairing,
            deliveries: yield* FiberSet.make<void>(),
            draining: new Set(),
            again: new Set(),
          };
          live = session;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (live === session) live = null;
            }),
          );
          yield* wake;
          return yield* Effect.forever(Effect.sleep(sweep).pipe(Effect.andThen(wake)));
        }).pipe(Effect.scoped),
      )
      .pipe(Effect.forkIn(scope));

    const withSendingPaused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          pauses += 1;
          if (live === null) return Effect.void;
          live.again.clear();
          return FiberSet.clear(live.deliveries);
        }),
        () => effect,
        () =>
          Effect.suspend(() => {
            pauses -= 1;
            return wake;
          }),
      );

    const outgoing = Effect.fn("Conversations.outgoing")(function* (input: {
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments?: ReadonlyArray<Attachment>;
      readonly mentions?: Mentions;
    }) {
      const attachments = input.attachments ?? [];
      const problem = messageProblem(input.text, attachments);
      if (problem !== null) return yield* new InvalidMessage({ problem });
      return {
        _tag: "outgoing",
        commandId: yield* actions.commandId,
        target: input.target,
        text: input.text,
        attachments,
        mentions: input.mentions ?? null,
        createdAt: yield* DateTime.now,
        status: { _tag: "sending" },
      } satisfies KeptMessage;
    });

    const notPaired: IntentResult<EntryId> = { _tag: "failed", failure: { _tag: "not-paired" } };

    const send = Effect.fn("Conversations.send")(function* (input: Parameters<typeof outgoing>[0]) {
      const message = yield* outgoing(input);
      // With nothing expected, only the pairing's end refuses it, and only a
      // storage failure leaves it in memory, as the pairing's it was sent under.
      const keeping = yield* withPairing(
        Effect.suspend(() => {
          const pairing = followed;
          if (pairing === null) return Effect.succeed(null);
          return keep(message, pairing, [], []).pipe(
            Effect.map((kept) => ({ pairing, kept })),
            Effect.catchTag("LocalStorageError", (error) =>
              Effect.logWarning("An unsent message is kept in memory only", error).pipe(
                Effect.as({ pairing, kept: null }),
              ),
            ),
          );
        }),
      );
      if (keeping === null || keeping.kept === false) return notPaired;
      const result = awaitResult(message.commandId, 0);
      if (keeping.kept) yield* refresh;
      else {
        outbox.update((list) => [...list, { message, pairing: keeping.pairing, kept: null }]);
      }
      yield* wake;
      return yield* result;
    });

    const enqueue = Effect.fn("Conversations.enqueue")(function* (
      input: Parameters<typeof outgoing>[0],
      claim?: {
        readonly pairing: DeviceId;
        readonly alongside: ReadonlyArray<LocalRecord>;
        readonly expected: ReadonlyArray<LocalRecord>;
      },
    ) {
      const message = yield* outgoing(input);
      const kept = yield* withPairing(
        Effect.gen(function* () {
          const pairing = followed;
          // A claim of another pairing comes from drafts this window is
          // dropping as it follows the next pairing: they are no longer sent.
          if (pairing === null || (claim !== undefined && claim.pairing !== pairing)) {
            return yield* new NotPaired();
          }
          const claimed = yield* keep(
            message,
            pairing,
            claim?.alongside ?? [],
            claim?.expected ?? [],
          );
          if (claimed) return true;
          // Refused for another window's change, or for the pairing's end.
          if (!(yield* connection.stillPaired(pairing))) return yield* new NotPaired();
          return false;
        }),
      );
      if (kept) yield* refresh.pipe(Effect.andThen(wake));
      return kept;
    });

    const resend = Effect.fn("Conversations.resend")(function* (commandId: CommandId) {
      const held = outbox.get().find((candidate) => candidate.message.commandId === commandId);
      if (held === undefined) return unexpected;
      const { message, kept } = held;
      if (message.status._tag !== "not-sent") return unexpected;
      const status = { _tag: "sending" } as const;
      let attempt = 0;
      if (kept === null) {
        setUnkeptStatus(commandId, status);
      } else {
        const { record } = kept;
        if (record.status._tag !== "not-sent") return unexpected;
        // A new attempt, claiming the one it follows. It was read from the device, so it encodes again.
        const failures = [...record.failures, record.status.failure];
        attempt = failures.length;
        const sending = yield* encodeRecord({ ...record, failures, status }).pipe(Effect.orDie);
        const claimed = yield* storage
          .commit(
            [{ table: "outbox", key: commandId, value: sending }],
            [{ table: "outbox", key: commandId, value: kept.value }],
            record.pairing,
          )
          .pipe(
            Effect.catchTag("LocalStorageError", (error) =>
              Effect.logWarning("A message could not be sent again", error).pipe(Effect.as(false)),
            ),
          );
        if (!claimed) {
          yield* refresh;
          return unexpected;
        }
      }
      const result = awaitResult(commandId, attempt);
      yield* refresh;
      yield* wake;
      return yield* result;
    });

    const discard = Effect.fn("Conversations.discard")(function* (commandId: CommandId) {
      const held = outbox.get().find((candidate) => candidate.message.commandId === commandId);
      if (held?.message.status._tag !== "not-sent") return;
      if (held.kept === null) return removeOutgoing(new Set([commandId]));
      const { record } = held.kept;
      if (record.status._tag !== "not-sent") return;
      const settled = yield* encodeRecord({
        _tag: "settled",
        commandId,
        pairing: record.pairing,
        failures: [...record.failures, record.status.failure],
        outcome: { _tag: "discarded" },
        at: yield* DateTime.now,
      }).pipe(Effect.orDie);
      // Claims the attempt this window shows as not sent, and no later one.
      yield* storage
        .commit(
          [{ table: "outbox", key: commandId, value: settled }],
          [{ table: "outbox", key: commandId, value: held.kept.value }],
          record.pairing,
        )
        .pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("A message could not be discarded", error),
          ),
        );
      yield* refresh;
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

    /**
     * Drops every message this window holds, and answers whoever waits on
     * one, then follows `next`. The list is emptied and the pairing changed in
     * one step, so no read of the pairing before projects into the list after.
     */
    const dropAll = (next: DeviceId | null) =>
      Effect.suspend(() => {
        followed = next;
        outbox.set([]);
        unrecorded.clear();
        return Effect.forEach([...waiting], (waiter) => answer(waiter, notPaired), {
          discard: true,
        });
      });

    const discardAll = (pairing: DeviceId | null) =>
      withSendingPaused(
        withPairing(
          Effect.gen(function* () {
            // A window that follows a pairing made since already dropped these.
            if (followed === pairing) yield* dropAll(pairing);
            if (pairing !== null) yield* erase(pairing);
          }),
        ),
      );

    // Whenever the pairing this window follows changes, from none, to none or
    // to another, its messages go, here and on the device, and those the
    // device keeps for the pairing it follows now are read before sending
    // resumes. Each goes once accepted: its entry may be older than the
    // history a conversation loads.
    yield* Effect.gen(function* () {
      while (true) {
        yield* waitFor(connection.pairing, (current) => current !== followed);
        yield* withSendingPaused(
          Effect.gen(function* () {
            const next = yield* withPairing(
              Effect.gen(function* () {
                const ended = followed;
                const current = connection.pairing.get();
                yield* dropAll(current);
                if (ended !== null) {
                  yield* erase(ended).pipe(
                    Effect.catchTag("LocalStorageError", (error) =>
                      Effect.logWarning(
                        "Unsent messages of a pairing that ended stay in local storage",
                        error,
                      ),
                    ),
                  );
                }
                return current;
              }),
            );
            if (next === null) return;
            yield* refresh;
            for (const held of outbox.get()) replays.add(held.message.commandId);
          }),
        );
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
      withSendingPaused,
      discardAll,
    });
  }),
);
