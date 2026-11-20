// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ApprovalDecision,
  Attachment,
  CommandError,
  CommandId,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { Connection, type J3RpcClient } from "../connection/Connection.ts";
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
   * `accepted` once it has, until its entry arrives or the conversation
   * closes; `not-sent` when the server refused it. A message sent again after
   * a reload leaves once accepted: its entry may be older than the history
   * loaded, and shows where it belongs.
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

/**
 * An outgoing message as this window holds it. `sequence` is its place in
 * the device's queue and `value` the stored record it was read from; both
 * are null for a message the device could not keep, which this window alone
 * holds and sends.
 */
interface Held {
  readonly message: OutgoingMessage;
  readonly sequence: number | null;
  readonly value: string | null;
}

/** A held message that is due: the server has not answered it yet. */
type Due = Held & { readonly message: KeptMessage & { readonly status: { _tag: "sending" } } };

const isRpcClientError = Schema.is(RpcClientError);

const IntentFailureSchema = Schema.Union([
  Schema.TaggedStruct("refused", { error: CommandError }),
  Schema.TaggedStruct("not-paired", {}),
  Schema.TaggedStruct("unexpected", {}),
]);

const StoredMessage = Schema.TaggedStruct("message", {
  commandId: CommandId,
  target: EntryTarget,
  text: MessageText,
  attachments: Schema.Array(Attachment),
  mentions: Schema.NullOr(Mentions),
  createdAt: Schema.DateTimeUtc,
  /** Its place in the device's queue, given in the transaction that kept it. */
  sequence: NonNegativeInt,
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
 * How often a connected window reads the outbox and sends what is due, on
 * top of being told by the window that changed it. A window can close between
 * keeping a message and telling the others, so this bounds how long such a
 * message waits. Five seconds costs one read of a small table, and nothing
 * else when nothing is due.
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
     * Keeps the message on the device, with `alongside` in the same storage
     * transaction, then shows it and starts sending it as `send` does, without
     * waiting for the server. Succeeds with `false`, keeping, showing and
     * sending nothing, when a record of `expected` no longer holds the value
     * given; fails the same way when the device cannot keep it, or with
     * `InvalidMessage` when it breaks a limit of `message.send`.
     */
    readonly enqueue: (
      input: {
        readonly target: EntryTarget;
        readonly text: string;
        readonly attachments?: ReadonlyArray<Attachment>;
        readonly mentions?: Mentions;
      },
      alongside?: ReadonlyArray<LocalRecord>,
      expected?: ReadonlyArray<LocalRecord>,
    ) => Effect.Effect<boolean, LocalStorageError | InvalidMessage>;
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
    const locks = yield* WindowLocks;
    const sweep = yield* OutboxSweep;
    const scope = yield* Scope.Scope;

    // Outgoing messages of every target, in the order of the device's queue,
    // so a message keeps its place while its conversation is closed and reopened.
    const outbox = new Cell<ReadonlyArray<Held>>([]);
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
            .map((held) => held.message)
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

    // Callers of `send` and `resend` waiting for their message's result.
    const waiting = new Map<CommandId, Deferred.Deferred<IntentResult<EntryId>>>();
    const settleWaiting = (commandId: CommandId, result: IntentResult<EntryId>) => {
      const caller = waiting.get(commandId);
      waiting.delete(commandId);
      return caller === undefined ? Effect.void : Deferred.succeed(caller, result);
    };
    /** The result of delivering the message `commandId`, once it has one. */
    const awaitResult = (commandId: CommandId) => {
      const result = Deferred.makeUnsafe<IntentResult<EntryId>>();
      waiting.set(commandId, result);
      return Deferred.await(result);
    };
    const unexpected: IntentResult<EntryId> = { _tag: "failed", failure: { _tag: "unexpected" } };

    const queueOrder = (a: Held, b: Held) => {
      if (a.sequence === null) return b.sequence === null ? 0 : 1;
      if (b.sequence === null) return -1;
      return a.sequence - b.sequence;
    };
    const heldOf = (record: StoredMessage, value: string): Held => ({
      message: {
        _tag: "outgoing",
        commandId: record.commandId,
        target: record.target,
        text: record.text,
        attachments: record.attachments,
        mentions: record.mentions,
        createdAt: record.createdAt,
        status: record.status,
      },
      sequence: record.sequence,
      value,
    });
    const isDue = (held: Held): held is Due => held.message.status._tag === "sending";
    /** Changes the status of a message the device does not keep, which only this window holds. */
    const setUnkeptStatus = (commandId: CommandId, status: OutgoingMessage["status"]) =>
      outbox.update((list) =>
        list.map((held) =>
          held.message.commandId === commandId
            ? { ...held, message: { ...held.message, status } }
            : held,
        ),
      );

    /**
     * Makes this window's list a projection of `stored`, the outbox as the
     * device keeps it, and settles every caller whose message has an outcome
     * there. A message this window alone holds keeps its own state, and so
     * does one accepted, until its entry arrives or its conversation closes.
     */
    const reconcile = Effect.fnUntraced(function* (
      stored: ReadonlyMap<string, { record: StoredRecord; value: string }>,
    ) {
      const held = outbox.get();
      const next: Array<Held> = [];
      for (const item of held) {
        const { message } = item;
        if (item.sequence === null || message.status._tag === "accepted") {
          next.push(item);
          continue;
        }
        const kept = stored.get(message.commandId);
        if (kept?.record._tag === "message") {
          next.push(kept.value === item.value ? item : heldOf(kept.record, kept.value));
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
        ordered.flatMap((item) => (item.sequence === null ? [item.message.commandId] : [])),
      );
      const outcomes: Array<readonly [CommandId, IntentResult<EntryId>]> = [];
      for (const commandId of waiting.keys()) {
        if (unkept.has(commandId)) continue;
        const kept = stored.get(commandId)?.record;
        if (kept === undefined) outcomes.push([commandId, unexpected]);
        else if (kept._tag === "settled") {
          outcomes.push([
            commandId,
            kept.outcome._tag === "accepted"
              ? { _tag: "done", value: kept.outcome.entryId }
              : unexpected,
          ]);
        } else if (kept.status._tag === "not-sent") {
          outcomes.push([commandId, { _tag: "failed", failure: kept.status.failure }]);
        }
      }
      yield* Effect.forEach(outcomes, ([commandId, result]) => settleWaiting(commandId, result), {
        discard: true,
      });
    });

    /**
     * Reads the outbox, makes this window's list follow it, removes outcomes
     * older than `SETTLED_KEPT`, and returns what is due, in queue order:
     * every message the device keeps that the server has not answered, then
     * those this window alone holds. One read at a time, so each projection
     * is at least as new as the one before. Storage that cannot be read
     * leaves the list as it is, and only this window's own messages due.
     */
    const refreshLock = Semaphore.makeUnsafe(1);
    const refresh: Effect.Effect<ReadonlyArray<Due>> = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* storage.readAll("outbox");
        const now = yield* DateTime.now;
        const stored = new Map<string, { record: StoredRecord; value: string }>();
        const expired: Array<LocalRecord> = [];
        for (const [key, value] of records) {
          if (key === COUNTER_KEY) continue;
          const decoded = decodeRecord(value);
          if (Option.isNone(decoded)) continue;
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
        yield* reconcile(stored);
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
        Effect.map((read) =>
          outbox
            .get()
            .filter(isDue)
            .filter((held) => read || held.sequence === null),
        ),
      ),
    );

    /**
     * Keeps `message` on the device as the last of its queue, with `alongside`,
     * in one transaction that claims `expected` and the queue's counter.
     * Succeeds with `false`, writing nothing, when a record of `expected` no
     * longer holds; tries again when only the counter moved, taken by another
     * window's message.
     */
    const keep = Effect.fnUntraced(function* (
      message: KeptMessage,
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
        const value = yield* encodeRecord({ ...message, _tag: "message", sequence }).pipe(
          Effect.orDie,
        );
        const claimed = yield* storage.commit(
          [
            ...alongside,
            { table: "outbox", key: message.commandId, value },
            { table: "outbox", key: COUNTER_KEY, value: encodeCounter({ next: sequence + 1 }) },
          ],
          [...expected, { table: "outbox", key: COUNTER_KEY, value: counter }],
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

    /**
     * Records what the server answered for `due`: on the device, claiming the
     * record as it was sent, or in memory for a message this window alone
     * holds. The drain's next read shows it and settles its caller.
     */
    const recordAnswer = Effect.fnUntraced(function* (due: Due, result: IntentResult<EntryId>) {
      const { message } = due;
      if (due.value === null || due.sequence === null) {
        if (result._tag === "failed") {
          setUnkeptStatus(message.commandId, { _tag: "not-sent", failure: result.failure });
        } else if (stores.isOpen(message.target)) {
          setUnkeptStatus(message.commandId, { _tag: "accepted" });
        } else {
          removeOutgoing(new Set([message.commandId]));
        }
        return yield* settleWaiting(message.commandId, result);
      }
      const outcome: StoredRecord =
        result._tag === "done"
          ? {
              _tag: "settled",
              commandId: message.commandId,
              outcome: { _tag: "accepted", entryId: result.value },
              at: yield* DateTime.now,
            }
          : {
              ...message,
              _tag: "message",
              sequence: due.sequence,
              status: { _tag: "not-sent", failure: result.failure },
            };
      // It was read from the device, so it encodes again.
      const value = yield* encodeRecord(outcome).pipe(Effect.orDie);
      yield* storage
        .commit(
          [{ table: "outbox", key: message.commandId, value }],
          [{ table: "outbox", key: message.commandId, value: due.value }],
        )
        .pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("The outcome of a sent message is not kept", error).pipe(
              Effect.andThen(settleWaiting(message.commandId, result)),
            ),
          ),
        );
    });

    /** Sends `due` on `client`, and records the answer. Succeeds with `false` when the socket gave none. */
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
          return answer === "disconnected"
            ? Effect.succeed(false)
            : recordAnswer(due, answer).pipe(Effect.as(true));
        }),
      );

    /**
     * Sends what `key` has left on `client`, one message at a time, while
     * this window holds the conversation's lock: one window sends a
     * conversation's messages at a time, so the server records them in the
     * order they were kept. It reads them after taking the lock, once the
     * window before it recorded what it delivered, so a kept message goes
     * once. Succeeds with `false` when the socket gave no answer: the message
     * stays due, under the same command id, for the next socket or another
     * window.
     */
    const drain = (key: string, client: J3RpcClient) =>
      locks.withLock(
        `j3-bots/outbox/${key}`,
        Effect.gen(function* () {
          const tried = new Set<CommandId>();
          while (true) {
            again.delete(key);
            const next = (yield* refresh).find(
              (due) => targetKey(due.message.target) === key && !tried.has(due.message.commandId),
            );
            if (next === undefined) return true;
            tried.add(next.message.commandId);
            if (!(yield* deliver(next, client))) return false;
          }
        }),
      );

    // What an earlier launch left unsent. Each goes once accepted: its entry
    // may be older than the history a conversation loads.
    yield* refresh;
    for (const held of outbox.get()) replays.add(held.message.commandId);

    // Asks this window to read the outbox and send what is due. One pending wake is enough.
    const wakes = yield* Queue.sliding<void>(1);
    const wake = Effect.asVoid(Queue.offer(wakes, undefined));
    // The socket deliveries run on, with them, while it is open.
    let live: {
      readonly client: J3RpcClient;
      readonly deliveries: FiberSet.FiberSet<void>;
    } | null = null;
    // Targets this window is sending, and those given more to send meanwhile.
    const draining = new Set<string>();
    const again = new Set<string>();
    let pauses = 0;

    /** Has this window send what is due, on the open socket, unless sending is paused. */
    const startDeliveries = (due: ReadonlyArray<Due>) =>
      Effect.suspend(() => {
        const session = live;
        if (session === null || pauses > 0) return Effect.void;
        const keys = new Set(due.map((item) => targetKey(item.message.target)));
        return Effect.forEach(
          keys,
          (key) => {
            if (draining.has(key)) {
              again.add(key);
              return Effect.void;
            }
            draining.add(key);
            return drain(key, session.client).pipe(
              Effect.ensuring(Effect.sync(() => draining.delete(key))),
              Effect.tap((finished) => (finished && again.has(key) ? wake : Effect.void)),
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
      .eachSession((client) =>
        Effect.gen(function* () {
          const session = { client, deliveries: yield* FiberSet.make<void>() };
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
          again.clear();
          return live === null ? Effect.void : FiberSet.clear(live.deliveries);
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

    const send = Effect.fn("Conversations.send")(function* (input: Parameters<typeof outgoing>[0]) {
      const message = yield* outgoing(input);
      // With nothing expected, only a storage failure leaves it unkept.
      const kept = yield* keep(message, [], []).pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("An unsent message is kept in memory only", error).pipe(
            Effect.as(false),
          ),
        ),
      );
      const result = awaitResult(message.commandId);
      if (kept) yield* refresh;
      else outbox.update((list) => [...list, { message, sequence: null, value: null }]);
      yield* wake;
      return yield* result;
    });

    const enqueue = Effect.fn("Conversations.enqueue")(function* (
      input: Parameters<typeof outgoing>[0],
      alongside: ReadonlyArray<LocalRecord> = [],
      expected: ReadonlyArray<LocalRecord> = [],
    ) {
      const message = yield* outgoing(input);
      const kept = yield* keep(message, alongside, expected);
      if (kept) yield* refresh.pipe(Effect.andThen(wake));
      return kept;
    });

    const resend = Effect.fn("Conversations.resend")(function* (commandId: CommandId) {
      const held = outbox.get().find((candidate) => candidate.message.commandId === commandId);
      if (held === undefined) return unexpected;
      const { message, sequence, value } = held;
      if (message.status._tag !== "not-sent") return unexpected;
      const status = { _tag: "sending" } as const;
      if (sequence === null || value === null) {
        setUnkeptStatus(commandId, status);
      } else {
        // It was read from the device, so it encodes again.
        const sending = yield* encodeRecord({ ...message, _tag: "message", sequence, status }).pipe(
          Effect.orDie,
        );
        const claimed = yield* storage
          .commit(
            [{ table: "outbox", key: commandId, value: sending }],
            [{ table: "outbox", key: commandId, value }],
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
      const result = awaitResult(commandId);
      yield* refresh;
      yield* wake;
      return yield* result;
    });

    const discard = Effect.fn("Conversations.discard")(function* (commandId: CommandId) {
      const held = outbox.get().find((candidate) => candidate.message.commandId === commandId);
      if (held?.message.status._tag !== "not-sent") return;
      if (held.value === null) return removeOutgoing(new Set([commandId]));
      const settled = yield* encodeRecord({
        _tag: "settled",
        commandId,
        outcome: { _tag: "discarded" },
        at: yield* DateTime.now,
      }).pipe(Effect.orDie);
      yield* storage
        .commit(
          [{ table: "outbox", key: commandId, value: settled }],
          [{ table: "outbox", key: commandId, value: held.value }],
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

    const discardAll = withSendingPaused(
      Effect.gen(function* () {
        outbox.set([]);
        const given = [...waiting.keys()];
        yield* Effect.forEach(
          given,
          (commandId) =>
            settleWaiting(commandId, { _tag: "failed", failure: { _tag: "not-paired" } }),
          { discard: true },
        );
        yield* storage.clear("outbox");
      }),
    );

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
      withSendingPaused,
      discardAll,
    });
  }),
);
