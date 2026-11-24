// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EntryId,
  PairBotIds,
  PairSeq,
  TeammateMessage,
  TeammatePair,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { pairKeyText } from "../presentation/pairs.ts";
import { Cell, type Readable, waitFor } from "../Store.ts";
import { makeKeyed } from "./keyed.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** How many older messages one scroll back reads. */
const HISTORY_PAGE = 50;

/** How many older messages each read takes when a snapshot reads back what was held: as many as one may. */
const REFILL_PAGE = 200;

/** A frame of `pairs.subscribe`. */
type PairsFrame =
  | { readonly _tag: "snapshot"; readonly pairs: ReadonlyArray<TeammatePair> }
  | {
      readonly _tag: "changed";
      readonly upsert: ReadonlyArray<TeammatePair>;
      readonly remove: ReadonlyArray<PairBotIds>;
    };

/** Latest message first: `seq` is the order messages were sent in, across every pair. */
const latestFirst = (pairs: Iterable<TeammatePair>): ReadonlyArray<TeammatePair> =>
  [...pairs].toSorted((a, b) => b.lastMessage.seq - a.lastMessage.seq);

/**
 * The pairs held after `frame`: a snapshot replaces them, a change upserts
 * and removes by `botIds`. Latest message first either way.
 */
export const applyPairsFrame = (
  current: ReadonlyArray<TeammatePair> | null,
  frame: PairsFrame,
): ReadonlyArray<TeammatePair> => {
  if (frame._tag === "snapshot") return latestFirst(frame.pairs);
  const byKey = new Map((current ?? []).map((pair) => [pairKeyText(pair.botIds), pair]));
  for (const botIds of frame.remove) byKey.delete(pairKeyText(botIds));
  for (const pair of frame.upsert) byKey.set(pairKeyText(pair.botIds), pair);
  return latestFirst(byKey.values());
};

export interface PairConversationState {
  readonly phase: "loading" | "ready";
  /** What is shown may be out of date: the socket is closed, or reopened and not yet resynced. */
  readonly stale: boolean;
  /** Oldest first, by `seq`. */
  readonly messages: ReadonlyArray<TeammateMessage>;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

/** One open teammate conversation. */
export interface PairConversation {
  readonly botIds: PairBotIds;
  readonly state: Readable<PairConversationState>;
  /** Reads the page before the oldest message held. Does nothing while a read runs or at the start. */
  readonly loadOlder: Effect.Effect<void>;
  /**
   * Reads older pages until the message one of whose cards is `entryId` is
   * held, as when the operator opens the conversation at a line of their
   * bot's conversation. Its `seq`, or null when the conversation holds no
   * such message.
   */
  readonly reveal: (entryId: EntryId) => Effect.Effect<PairSeq | null>;
}

/** A pair's messages before a point (`pairs.history`), or null when they could not be read. */
type ReadPage = (
  before: PairSeq,
  limit: number,
) => Effect.Effect<{
  readonly messages: ReadonlyArray<TeammateMessage>;
  readonly hasOlder: boolean;
} | null>;

const oldestOf = (messages: ReadonlyMap<PairSeq, TeammateMessage>): PairSeq | undefined => {
  let oldest: PairSeq | undefined;
  for (const seq of messages.keys()) if (oldest === undefined || seq < oldest) oldest = seq;
  return oldest;
};

/**
 * The messages an open conversation holds after a snapshot, which only ever
 * carries the latest ones: the snapshot's, then the pages before them read
 * again down to `keep`, the oldest message held before it, so a reconnection
 * keeps what the operator scrolled back to, with each message as it stands
 * now. Null `keep` takes the snapshot as it is. A page that cannot be read
 * ends the reading: what is older stays to scroll back to.
 */
export const refilled = (
  snapshot: { readonly messages: ReadonlyArray<TeammateMessage>; readonly hasOlder: boolean },
  keep: PairSeq | null,
  readPage: ReadPage,
): Effect.Effect<{
  readonly messages: Map<PairSeq, TeammateMessage>;
  readonly hasOlder: boolean;
}> =>
  Effect.gen(function* () {
    const messages = new Map(snapshot.messages.map((message) => [message.seq, message]));
    let hasOlder = snapshot.hasOlder;
    while (keep !== null && hasOlder) {
      const oldest = oldestOf(messages);
      if (oldest === undefined || oldest <= keep) break;
      const page = yield* readPage(oldest, REFILL_PAGE);
      if (page === null || page.messages.length === 0) break;
      for (const message of page.messages) {
        if (!messages.has(message.seq)) messages.set(message.seq, message);
      }
      hasOlder = page.hasOlder;
    }
    return { messages, hasOlder };
  });

/** The message one of whose cards, in either bot's conversation, is `entryId`. */
export const messageWithCard = (
  messages: ReadonlyArray<TeammateMessage>,
  entryId: EntryId,
): TeammateMessage | undefined =>
  messages.find(
    (message) => message.sentEntryId === entryId || message.receivedEntryId === entryId,
  );

/**
 * The teammate conversations: every pair of bots that wrote each other, for
 * the roster and each bot's details, and the messages of the ones open.
 * Read-only: the operator writes in neither.
 */
export class TeammatePairs extends Context.Service<
  TeammatePairs,
  {
    /**
     * Every pair with messages, latest first, with a hidden or deleted bot's
     * among them: `betweenBots` and `teammatesOf` say where each shows.
     */
    readonly state: Readable<Synced<ReadonlyArray<TeammatePair>>>;
    /** Opens the pair's conversation for as long as the scope lasts. Users of one pair share it. */
    readonly open: (botIds: PairBotIds) => Effect.Effect<PairConversation, never, Scope.Scope>;
  }
>()("@j3-bots/client-runtime/stores/TeammatePairs") {}

export const layer = Layer.effect(
  TeammatePairs,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const scope = yield* Scope.Scope;
    const state = new Cell<Synced<ReadonlyArray<TeammatePair>>>(loading);

    yield* connection
      .eachSession((client) =>
        client["pairs.subscribe"]().pipe(
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              const current = state.get();
              if (frame._tag === "changed" && current._tag === "loading") return;
              state.set(
                ready(applyPairsFrame(current._tag === "ready" ? current.value : null, frame)),
              );
            }),
          ),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const openStore = (botIds: PairBotIds) =>
      Effect.sync(() => {
        let messages = new Map<PairSeq, TeammateMessage>();
        let phase: PairConversationState["phase"] = "loading";
        let stale = true;
        let hasOlder = false;
        let loadingOlder = false;
        // Each snapshot starts a new epoch: an older page read before it is dropped.
        let epoch = 0;

        const sorted = () => [...messages.values()].toSorted((a, b) => a.seq - b.seq);
        const project = (): PairConversationState => ({
          phase,
          stale,
          messages: sorted(),
          hasOlder,
          loadingOlder,
        });
        const pairState = new Cell<PairConversationState>(project());
        const publish = () => pairState.set(project());

        const readPage: ReadPage = (before, limit) =>
          connection
            .call((client) => client["pairs.history"]({ botIds, before, limit }))
            .pipe(Effect.catchTag("NotPaired", () => Effect.succeed(null)));

        const run = connection.eachSession((client) =>
          client["pairs.messages.subscribe"]({ botIds }).pipe(
            Stream.runForEach((frame) =>
              frame._tag === "snapshot"
                ? // Replaces everything: what the operator reads stays until the pages it reached are read again.
                  refilled(
                    frame,
                    phase === "ready" ? (oldestOf(messages) ?? null) : null,
                    readPage,
                  ).pipe(
                    Effect.map((next) => {
                      messages = next.messages;
                      hasOlder = next.hasOlder;
                      loadingOlder = false;
                      epoch += 1;
                      phase = "ready";
                      stale = false;
                      publish();
                    }),
                  )
                : Effect.sync(() => {
                    for (const message of frame.upsert) messages.set(message.seq, message);
                    stale = false;
                    publish();
                  }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                stale = true;
                publish();
              }),
            ),
          ),
        );

        /**
         * Reads the page before the oldest message held. `changed` when what
         * is held changed meanwhile: the page was taken, or a snapshot
         * replaced everything before it came. `busy` while another read
         * runs; `none` when there is nothing older, or it could not be read.
         */
        const readOlder: Effect.Effect<"changed" | "busy" | "none"> = Effect.suspend(() => {
          if (loadingOlder) return Effect.succeed("busy" as const);
          const oldest = oldestOf(messages);
          if (!hasOlder || oldest === undefined) return Effect.succeed("none" as const);
          const at = epoch;
          loadingOlder = true;
          publish();
          return readPage(oldest, HISTORY_PAGE).pipe(
            Effect.map((page) => {
              if (epoch !== at) return "changed" as const;
              if (page === null) return "none" as const;
              // A copy already held came from the live tail and is at least as new.
              for (const message of page.messages) {
                if (!messages.has(message.seq)) messages.set(message.seq, message);
              }
              hasOlder = page.hasOlder;
              return "changed" as const;
            }),
            Effect.ensuring(
              Effect.sync(() => {
                if (epoch === at) loadingOlder = false;
                publish();
              }),
            ),
          );
        });

        const reveal = Effect.fn("TeammatePairs.reveal")(function* (entryId: EntryId) {
          while (true) {
            const current = yield* waitFor(
              pairState,
              (value) => value.phase === "ready" && !value.loadingOlder,
            );
            const found = messageWithCard(current.messages, entryId);
            if (found !== undefined) return found.seq;
            // Busy: a scroll back started meanwhile; its page is looked through once it ends.
            if ((yield* readOlder) === "none") return null;
          }
        });

        const conversation: PairConversation = {
          botIds,
          state: pairState,
          loadOlder: Effect.asVoid(readOlder),
          reveal,
        };
        return { value: conversation, run, close: () => {} };
      });

    const stores = makeKeyed(scope, pairKeyText, openStore);
    return TeammatePairs.of({ state, open: stores.acquire });
  }),
);
