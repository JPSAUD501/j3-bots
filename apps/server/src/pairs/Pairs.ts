// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  EntryId,
  HandoffState,
  MessageText,
  type PairBotIds,
  PairSeq,
  PositiveInt,
  PREVIEW_LENGTH,
  Sequence,
  type TeammateMessage,
  type TeammatePair,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { FRAME_BUDGET, SNAPSHOT_SIZE } from "../entries/Entries.ts";
import { cut } from "../entries/preview.ts";
import { ChangeLog, type ChangeScope } from "../persistence/ChangeLog.ts";
import { Flag, Time } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";

export type PairsFrame =
  | { readonly _tag: "snapshot"; readonly pairs: ReadonlyArray<TeammatePair> }
  | {
      readonly _tag: "changed";
      readonly upsert: ReadonlyArray<TeammatePair>;
      readonly remove: ReadonlyArray<PairBotIds>;
    };

export type PairMessagesFrame =
  | {
      readonly _tag: "snapshot";
      readonly messages: ReadonlyArray<TeammateMessage>;
      readonly hasOlder: boolean;
    }
  | { readonly _tag: "changed"; readonly upsert: ReadonlyArray<TeammateMessage> };

/** A message as `pair_messages` and the card it is read from give it. */
const MessageRow = Schema.Struct({
  seq: PairSeq,
  pair_low: BotId,
  pair_high: BotId,
  sender_bot_id: BotId,
  recipient_bot_id: BotId,
  sent_entry_id: Schema.NullOr(EntryId),
  received_entry_id: Schema.NullOr(EntryId),
  text: Schema.String,
  urgent: Flag,
  state: HandoffState,
  created_at: Time,
});
type MessageRow = typeof MessageRow.Type;

const PairRow = Schema.Struct({ ...MessageRow.fields, count: PositiveInt });
const SizeRows = Schema.Array(Schema.Struct({ size: Schema.Number }));

const toMessage = (row: MessageRow, text: string) => ({
  seq: row.seq,
  from: row.sender_bot_id,
  to: row.recipient_bot_id,
  sentEntryId: row.sent_entry_id,
  receivedEntryId: row.received_entry_id,
  text,
  urgent: row.urgent,
  state: row.state,
  createdAt: row.created_at,
});

const decodeText = Schema.decodeUnknownEffect(MessageText);

const keyOf = (botIds: PairBotIds): string => `${botIds[0]} ${botIds[1]}`;

/** What a pair's row shows: a change to any of it is sent again. */
const shownOf = (pair: TeammatePair): string =>
  [
    pair.count,
    pair.lastMessage.seq,
    pair.lastMessage.state,
    pair.lastMessage.sentEntryId,
    pair.lastMessage.receivedEntryId,
  ].join(" ");

/**
 * Teammate conversations (`docs/architecture/server.md`, Teammate
 * conversations): the messages each pair of bots sent each other, read from
 * their `handoff` cards in the order they were sent. Only a read of what
 * `Speech`'s `message_bot` writes: nothing here changes a message.
 */
export class Pairs extends Context.Service<
  Pairs,
  {
    /** A pair's messages before `before`, or its latest, oldest first. */
    readonly history: (input: {
      readonly botIds: PairBotIds;
      readonly before: PairSeq | null;
      readonly limit: number;
    }) => Effect.Effect<{
      readonly messages: ReadonlyArray<TeammateMessage>;
      readonly hasOlder: boolean;
    }>;
    /** Every pair, then each pair whose row changes or that is gone. */
    readonly subscribe: Stream.Stream<PairsFrame>;
    /** A pair's latest messages, then each message sent or changed. */
    readonly messages: (botIds: PairBotIds) => Stream.Stream<PairMessagesFrame>;
  }
>()("@j3-bots/server/pairs/Pairs") {}

export const layer = Layer.effect(
  Pairs,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* ChangeLog;
    const transaction = transactional(sql);

    // A message is read from its received card, or from its sent card once
    // the recipient is deleted: the two say the same.
    const text = sql`json_extract(e.body_json, '$.text')`;
    const columns = sql`
      p.seq, p.pair_low, p.pair_high, p.sender_bot_id, p.recipient_bot_id, p.sent_entry_id,
      p.received_entry_id, json_extract(e.body_json, '$.urgent') AS urgent,
      json_extract(e.body_json, '$.state') AS state, e.created_at
    `;
    const card = sql`entries e ON e.id = COALESCE(p.received_entry_id, p.sent_entry_id)`;
    const inPair = (botIds: PairBotIds) =>
      sql`p.pair_low = ${botIds[0]} AND p.pair_high = ${botIds[1]}`;

    const messagesOf = Effect.fn("Pairs.messagesOf")(function* (rows: ReadonlyArray<unknown>) {
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(MessageRow))(rows);
      return yield* Effect.forEach(decoded, (row) =>
        Effect.map(decodeText(row.text), (full) => toMessage(row, full)),
      );
    }, Effect.orDie);

    /**
     * The pairs with messages, latest message first; with `botId`, only
     * that bot's. The latest message's text is cut to a preview.
     */
    const pairs = Effect.fn("Pairs.pairs")(function* (botId: BotId | null) {
      const ofBot = botId === null ? sql`` : sql`WHERE pair_low = ${botId} OR pair_high = ${botId}`;
      const rows = yield* sql`
        SELECT last.count, ${columns}, substr(${text}, 1, ${PREVIEW_LENGTH}) AS text
        FROM (
          SELECT COUNT(*) AS count, MAX(seq) AS seq FROM pair_messages ${ofBot}
          GROUP BY pair_low, pair_high
        ) last
        JOIN pair_messages p ON p.seq = last.seq
        JOIN ${card}
        ORDER BY p.seq DESC
      `;
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(PairRow))(rows);
      return decoded.map((row): TeammatePair => ({
        botIds: [row.pair_low, row.pair_high],
        lastMessage: toMessage(row, cut(row.text, PREVIEW_LENGTH)),
        count: row.count,
      }));
    }, Effect.orDie);

    /**
     * A pair's newest messages before `before`, oldest first: at most
     * `limit`, and no more than reach `FRAME_BUDGET` of text (at least one).
     */
    const newest = Effect.fn("Pairs.newest")(function* (
      botIds: PairBotIds,
      before: PairSeq | null,
      limit: number,
    ) {
      const older = before === null ? sql`` : sql`AND p.seq < ${before}`;
      // Each message with the length of the newer ones before it: it is kept
      // while they are still under the budget.
      const rows = yield* sql`
        SELECT * FROM (
          SELECT ${columns}, ${text} AS text,
            SUM(length(${text})) OVER (ORDER BY p.seq DESC) - length(${text}) AS newer
          FROM pair_messages p JOIN ${card}
          WHERE ${inPair(botIds)} ${older}
          ORDER BY p.seq DESC
          LIMIT ${limit + 1}
        )
        WHERE newer < ${FRAME_BUDGET}
        ORDER BY seq DESC
      `;
      const found = yield* messagesOf(rows);
      const kept = found.slice(0, limit);
      const oldest = kept.at(-1);
      if (found.length > limit || oldest === undefined) {
        return { messages: kept.toReversed(), hasOlder: found.length > limit };
      }
      // Cut by the budget, or the last of them: whether any is older.
      const beyond = yield* sql`
        SELECT 1 FROM pair_messages p WHERE ${inPair(botIds)} AND p.seq < ${oldest.seq} LIMIT 1
      `;
      return { messages: kept.toReversed(), hasOlder: beyond.length > 0 };
    }, Effect.orDie);

    /** Whether one of `ids` is a card of a teammate message. */
    const anyCard = Effect.fn("Pairs.anyCard")(function* (ids: ReadonlyArray<string>) {
      const rows = yield* sql`
        SELECT 1 FROM pair_messages p
        WHERE ${sql.in("p.sent_entry_id", ids)} OR ${sql.in("p.received_entry_id", ids)}
        LIMIT 1
      `;
      return rows.length > 0;
    }, Effect.orDie);

    /**
     * The entries of `botId`'s conversation that changed after `after`, and
     * the sequence they reach; `null` when they can no longer all be told.
     */
    const changedCards = Effect.fn("Pairs.changedCards")(function* (botId: BotId, after: Sequence) {
      const resume = yield* changes.since({ _tag: "conversation", botId }, after);
      if (resume._tag === "gap") return null;
      return {
        ids: [...new Set(resume.changes.map((change) => change.entityId))],
        sequence: resume.changes.at(-1)?.sequence ?? after,
      };
    });

    const subscribe = Stream.unwrap(
      Effect.gen(function* () {
        // Joined before the snapshot is read, so no change falls between.
        const signals = yield* changes.subscribe;
        const first = yield* transaction(
          Effect.all({ sequence: changes.watermark, pairs: pairs(null) }),
        );
        // What this subscriber was last sent of each pair, and how far each
        // conversation's changes were read for it.
        const shown = new Map<string, { readonly botIds: PairBotIds; readonly shown: string }>();
        const show = (pair: TeammatePair) =>
          shown.set(keyOf(pair.botIds), { botIds: pair.botIds, shown: shownOf(pair) });
        first.pairs.forEach(show);
        const read = new Map<BotId, Sequence>();

        /** `botId`'s pairs that changed for this subscriber, and those gone. */
        const pairsOfBot = Effect.fn("Pairs.pairsOfBot")(function* (botId: BotId) {
          const now = yield* pairs(botId);
          const upsert = now.filter(
            (pair) => shown.get(keyOf(pair.botIds))?.shown !== shownOf(pair),
          );
          upsert.forEach(show);
          const kept = new Set(now.map((pair) => keyOf(pair.botIds)));
          const remove = [...shown.entries()]
            .filter(([key, { botIds }]) => botIds.includes(botId) && !kept.has(key))
            .map(([key, { botIds }]) => {
              shown.delete(key);
              return botIds;
            });
          if (upsert.length === 0 && remove.length === 0) return null;
          const frame: PairsFrame = { _tag: "changed", upsert, remove };
          return frame;
        });

        /**
         * A conversation's change moves its bot's pairs only through a
         * teammate message's card; a change of the bot itself (its deletion
         * takes its cards) may move any of them.
         */
        const changedOf = Effect.fn("Pairs.changedOf")(function* (
          scope: Extract<ChangeScope, { readonly _tag: "conversation" | "bot" }>,
        ) {
          if (scope._tag === "bot") return yield* pairsOfBot(scope.botId);
          const cards = yield* transaction(
            Effect.gen(function* () {
              const found = yield* changedCards(
                scope.botId,
                read.get(scope.botId) ?? first.sequence,
              );
              if (found === null) return { sequence: yield* changes.watermark, moved: true };
              return {
                sequence: found.sequence,
                moved: found.ids.length > 0 && (yield* anyCard(found.ids)),
              };
            }),
          );
          read.set(scope.botId, cards.sequence);
          return cards.moved ? yield* pairsOfBot(scope.botId) : null;
        });

        return Stream.concat(
          Stream.succeed<PairsFrame>({ _tag: "snapshot", pairs: first.pairs }),
          Stream.fromSubscription(signals).pipe(
            Stream.filter(
              (scope): scope is Extract<ChangeScope, { readonly _tag: "conversation" | "bot" }> =>
                scope._tag === "conversation" || scope._tag === "bot",
            ),
            Stream.mapEffect(changedOf),
            Stream.filter((frame): frame is NonNullable<typeof frame> => frame !== null),
          ),
        );
      }),
    );

    const messages = (botIds: PairBotIds) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Joined before the snapshot is read, so no change falls between.
          const signals = yield* changes.subscribe;
          // How far each bot's conversation's changes were read, in the order of `botIds`.
          const read: [Sequence, Sequence] = [Sequence.make(0), Sequence.make(0)];
          const snapshot = transaction(
            Effect.gen(function* () {
              const sequence = yield* changes.watermark;
              const page = yield* newest(botIds, null, SNAPSHOT_SIZE);
              read.fill(sequence);
              const frame: PairMessagesFrame = { _tag: "snapshot", ...page };
              return frame;
            }),
          );
          const first = yield* snapshot;

          /** The pair's messages whose cards changed in `botId`'s conversation. */
          const changedIn = (botId: BotId) =>
            transaction(
              Effect.gen(function* () {
                const index = botId === botIds[0] ? 0 : 1;
                const found = yield* changedCards(botId, read[index]);
                if (found === null) return yield* snapshot;
                read[index] = found.sequence;
                if (found.ids.length === 0) return null;
                const touched = sql`
                  ${inPair(botIds)}
                  AND (${sql.in("p.sent_entry_id", found.ids)}
                    OR ${sql.in("p.received_entry_id", found.ids)})
                `;
                // Too much to send at once: the bounded snapshot instead.
                const sized = yield* sql`
                  SELECT COALESCE(SUM(length(${text})), 0) AS size
                  FROM pair_messages p JOIN ${card} WHERE ${touched}
                `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SizeRows)), Effect.orDie);
                if ((sized[0]?.size ?? 0) > FRAME_BUDGET) return yield* snapshot;
                const upsert = yield* messagesOf(
                  yield* sql`
                    SELECT ${columns}, ${text} AS text FROM pair_messages p JOIN ${card}
                    WHERE ${touched}
                    ORDER BY p.seq
                  `.pipe(Effect.orDie),
                );
                if (upsert.length === 0) return null;
                const frame: PairMessagesFrame = { _tag: "changed", upsert };
                return frame;
              }),
            );

          /**
           * A bot's deletion changes no message, but may take some away with
           * their last card: the client starts over from a snapshot.
           */
          const deleted = Effect.fn("Pairs.deleted")(function* (botId: BotId) {
            const rows = yield* sql`SELECT 1 FROM bots WHERE id = ${botId}`.pipe(Effect.orDie);
            return rows.length > 0 ? null : yield* snapshot;
          });

          return Stream.concat(
            Stream.succeed<PairMessagesFrame>(first),
            Stream.fromSubscription(signals).pipe(
              Stream.filter(
                (scope): scope is Extract<ChangeScope, { readonly _tag: "conversation" | "bot" }> =>
                  (scope._tag === "conversation" || scope._tag === "bot") &&
                  botIds.includes(scope.botId),
              ),
              Stream.mapEffect((scope) =>
                scope._tag === "conversation" ? changedIn(scope.botId) : deleted(scope.botId),
              ),
              Stream.filter((frame): frame is NonNullable<typeof frame> => frame !== null),
            ),
          );
        }),
      );

    const history = (input: {
      readonly botIds: PairBotIds;
      readonly before: PairSeq | null;
      readonly limit: number;
    }) => newest(input.botIds, input.before, input.limit);

    return Pairs.of({ history, subscribe, messages });
  }),
);
