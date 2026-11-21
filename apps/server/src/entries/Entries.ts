// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type CommandId,
  Entry,
  EntryId,
  EntryOrder,
  type EntryTarget,
  NotFound,
  RoomId,
  type Sequence,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { ChangeLog, type ChangeScope, scopeKey } from "../persistence/ChangeLog.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { Presence } from "../presence/Presence.ts";
import { PushDeliveries } from "../push/PushDeliveries.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry before it is written: the server gives it its id, its place and its time. */
export type EntryDraft = DistributiveOmit<Entry, "id" | "order" | "createdAt">;

/** How many entries a subscription's snapshot holds. */
const SNAPSHOT_SIZE = 100;

/** The fields every entry has, kept in their own columns rather than in `body_json`. */
const COMMON_FIELDS = new Set(["_tag", "id", "order", "author", "createdAt"]);

const EntryJson = Schema.toCodecJson(Entry);
const decodeEntry = Schema.decodeUnknownEffect(EntryJson);
const encodeEntry = Schema.encodeEffect(EntryJson);
const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const EntryRow = Schema.Struct({
  id: EntryId,
  position: EntryOrder,
  kind: Schema.String,
  author_kind: Schema.Literals(["operator", "bot", "system"]),
  author_bot_id: Schema.NullOr(BotId),
  body_json: Body,
  created_at: Time,
});

const LocatedRow = Schema.Struct({
  ...EntryRow.fields,
  conversation_bot_id: Schema.NullOr(BotId),
  room_id: Schema.NullOr(RoomId),
});

const ENTRY_COLUMNS = `id, position, kind, author_kind, author_bot_id, body_json, created_at`;

const toEntry = Effect.fn("Entries.toEntry")(function* (row: typeof EntryRow.Type) {
  const author =
    row.author_kind === "bot" && row.author_bot_id !== null
      ? { _tag: "bot", botId: row.author_bot_id }
      : { _tag: row.author_kind };
  return yield* decodeEntry({
    ...row.body_json,
    _tag: row.kind,
    id: row.id,
    order: row.position,
    author,
    createdAt: DateTime.formatIso(row.created_at),
  });
}, Effect.orDie);

/** What the roster needs to know about a conversation or room. */
export interface TargetSummary {
  readonly last: Option.Option<Entry>;
  /** Whether a bot or J3 Bots wrote something after the operator's read mark. */
  readonly unread: boolean;
}

export type EntryFrame =
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
    };

const scopeOf = (
  target: EntryTarget,
): Extract<ChangeScope, { readonly _tag: "conversation" | "room" }> =>
  target._tag === "conversation"
    ? { _tag: "conversation", botId: target.botId }
    : { _tag: "room", roomId: target.roomId };

/**
 * Entries of conversations and rooms. An entry is appended with the next place
 * in its target and keeps it: it can change (a card is answered), never move or
 * disappear on its own. Every write records a change in the same transaction,
 * which is what subscriptions follow, and an append writes the pushes its
 * notification makes.
 */
export class Entries extends Context.Service<
  Entries,
  {
    /** Appends in the caller's transaction, or in its own. */
    readonly append: (input: {
      readonly target: EntryTarget;
      readonly entry: EntryDraft;
      readonly commandId?: CommandId;
    }) => Effect.Effect<Entry>;
    /** Replaces an entry's content. Its target, place and kind stay; the database refuses otherwise. */
    readonly update: (entry: Entry) => Effect.Effect<void>;
    readonly find: (
      id: EntryId,
    ) => Effect.Effect<Option.Option<{ readonly target: EntryTarget; readonly entry: Entry }>>;
    /** Entries before `before`, oldest first. */
    readonly history: (input: {
      readonly target: EntryTarget;
      readonly before: EntryOrder;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly entries: ReadonlyArray<Entry>; readonly hasOlder: boolean },
      NotFound
    >;
    /** The latest `limit` entries of a target, oldest first. */
    readonly latest: (target: EntryTarget, limit: number) => Effect.Effect<ReadonlyArray<Entry>>;
    /** Moves the operator's read mark forward to `through`. */
    readonly markRead: (target: EntryTarget, through: EntryOrder) => Effect.Effect<void, NotFound>;
    readonly summary: (target: EntryTarget) => Effect.Effect<TargetSummary>;
    /**
     * The latest entries, then every change after them. With `after`, only the
     * changes after that sequence, when they can all still be told; a snapshot
     * otherwise. Fails with `NotFound` once the target is gone.
     */
    readonly subscribe: (
      target: EntryTarget,
      after: Sequence | null,
    ) => Stream.Stream<EntryFrame, NotFound>;
  }
>()("@j3-bots/server/entries/Entries") {}

export const layer = Layer.effect(
  Entries,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* ChangeLog;
    const presence = yield* Presence;
    const pushes = yield* PushDeliveries;
    const ids = yield* Ids;
    const transaction = transactional(sql);

    const targetColumn = (target: EntryTarget) =>
      target._tag === "conversation"
        ? sql`conversation_bot_id = ${target.botId}`
        : sql`room_id = ${target.roomId}`;

    const exists = Effect.fn("Entries.exists")(function* (target: EntryTarget) {
      const rows =
        target._tag === "conversation"
          ? yield* sql`SELECT 1 FROM conversations WHERE bot_id = ${target.botId}`
          : yield* sql`SELECT 1 FROM rooms WHERE id = ${target.roomId}`;
      return rows.length > 0;
    }, Effect.orDie);

    const requireTarget = Effect.fn("Entries.requireTarget")(function* (target: EntryTarget) {
      if (!(yield* exists(target))) {
        return yield* new NotFound({ resource: target._tag === "room" ? "room" : "bot" });
      }
    });

    const rowsOf = SqlSchema.findAll({
      Request: Schema.Struct({ ids: Schema.Array(EntryId) }),
      Result: EntryRow,
      execute: ({ ids }) =>
        sql`SELECT ${sql.literal(ENTRY_COLUMNS)} FROM entries WHERE ${sql.in("id", ids)} ORDER BY position`,
    });

    const newest = Effect.fn("Entries.newest")(function* (
      target: EntryTarget,
      before: EntryOrder | null,
      limit: number,
    ) {
      const rows = yield* sql`
        SELECT ${sql.literal(ENTRY_COLUMNS)} FROM entries
        WHERE ${targetColumn(target)}
          ${before === null ? sql`` : sql`AND position < ${before}`}
        ORDER BY position DESC
        LIMIT ${limit + 1}
      `;
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(EntryRow))(rows);
      const entries = yield* Effect.forEach(decoded.slice(0, limit).toReversed(), toEntry);
      return { entries, hasOlder: decoded.length > limit };
    }, Effect.orDie);

    const encodeBody = Schema.encodeEffect(Body);

    /** The kind-specific fields, as `body_json` stores them. */
    const bodyOf = Effect.fn("Entries.bodyOf")(function* (entry: Entry) {
      const encoded = yield* encodeEntry(entry);
      if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
        return yield* Effect.die("An entry encodes to a JSON object");
      }
      return yield* encodeBody(
        Object.fromEntries(Object.entries(encoded).filter(([key]) => !COMMON_FIELDS.has(key))),
      );
    }, Effect.orDie);

    const append = Effect.fn("Entries.append")(
      function* (input: {
        readonly target: EntryTarget;
        readonly entry: EntryDraft;
        readonly commandId?: CommandId;
      }) {
        const id = EntryId.make(yield* ids.make("entry"));
        const createdAt = yield* DateTime.now;
        const [next] = yield* sql<{ readonly next: number }>`
          SELECT COALESCE(MAX(position) + 1, 0) AS next FROM entries
          WHERE ${targetColumn(input.target)}
        `;
        const entry: Entry = {
          ...input.entry,
          id,
          order: EntryOrder.make(next?.next ?? 0),
          createdAt,
        };
        const at = timeText(createdAt);
        const author = entry.author;
        yield* sql`
          INSERT INTO entries (
            id, conversation_bot_id, room_id, position, kind, author_kind, author_bot_id,
            command_id, body_json, created_at, updated_at
          ) VALUES (
            ${id},
            ${input.target._tag === "conversation" ? input.target.botId : null},
            ${input.target._tag === "room" ? input.target.roomId : null},
            ${entry.order}, ${entry._tag}, ${author._tag},
            ${author._tag === "bot" ? author.botId : null},
            ${input.commandId ?? null}, ${yield* bodyOf(entry)}, ${at}, ${at}
          )
        `;
        yield* changes.record(scopeOf(input.target), id);
        // Who hears of it is settled with the entry: a push is written with
        // it, and the devices with a socket open are told once it commits.
        const told = yield* presence.recipients(input.target, entry);
        if (told !== null) {
          yield* pushes.record(told);
          yield* sql.afterCommit(presence.tell(told));
        }
        return entry;
      },
      transaction,
      Effect.orDie,
    );

    const update = Effect.fn("Entries.update")(
      function* (entry: Entry) {
        const located = yield* findRow(entry.id);
        if (Option.isNone(located)) return yield* Effect.die("An updated entry exists");
        yield* sql`
          UPDATE entries
          SET body_json = ${yield* bodyOf(entry)}, updated_at = ${timeText(yield* DateTime.now)}
          WHERE id = ${entry.id}
        `;
        yield* changes.record(scopeOf(located.value.target), entry.id);
      },
      transaction,
      Effect.orDie,
    );

    const findRowQuery = SqlSchema.findOneOption({
      Request: EntryId,
      Result: LocatedRow,
      execute: (id) => sql`
        SELECT ${sql.literal(ENTRY_COLUMNS)}, conversation_bot_id, room_id
        FROM entries WHERE id = ${id}
      `,
    });

    const findRow = Effect.fn("Entries.findRow")(function* (id: EntryId) {
      const row = yield* findRowQuery(id);
      if (Option.isNone(row)) return Option.none();
      const { conversation_bot_id: botId, room_id: roomId } = row.value;
      const target: EntryTarget | null =
        botId !== null
          ? { _tag: "conversation", botId }
          : roomId !== null
            ? { _tag: "room", roomId }
            : null;
      if (target === null) return yield* Effect.die("An entry has a target");
      return Option.some({ target, entry: yield* toEntry(row.value) });
    }, Effect.orDie);

    const history = Effect.fn("Entries.history")(function* (input: {
      readonly target: EntryTarget;
      readonly before: EntryOrder;
      readonly limit: number;
    }) {
      yield* requireTarget(input.target);
      return yield* newest(input.target, input.before, input.limit);
    });

    const markRead = Effect.fn("Entries.markRead")(function* (
      target: EntryTarget,
      through: EntryOrder,
    ) {
      yield* requireTarget(target);
      yield* transaction(
        Effect.gen(function* () {
          if (target._tag === "conversation") {
            yield* sql`
              UPDATE conversations SET read_through_order = ${through}
              WHERE bot_id = ${target.botId}
                AND (read_through_order IS NULL OR read_through_order < ${through})
            `;
            yield* changes.touch({ _tag: "bot", botId: target.botId });
          } else {
            yield* sql`
              UPDATE rooms SET read_through_order = ${through}
              WHERE id = ${target.roomId}
                AND (read_through_order IS NULL OR read_through_order < ${through})
            `;
            yield* changes.touch({ _tag: "room", roomId: target.roomId });
          }
        }),
      ).pipe(Effect.orDie);
    });

    const summary = Effect.fn("Entries.summary")(function* (target: EntryTarget) {
      const { entries } = yield* newest(target, null, 1);
      const mark =
        target._tag === "conversation"
          ? sql`(SELECT read_through_order FROM conversations WHERE bot_id = ${target.botId})`
          : sql`(SELECT read_through_order FROM rooms WHERE id = ${target.roomId})`;
      const unread = yield* sql`
        SELECT 1 FROM entries
        WHERE ${targetColumn(target)} AND author_kind <> 'operator'
          AND position > COALESCE(${mark}, -1)
        LIMIT 1
      `;
      return { last: Option.fromNullishOr(entries[0]), unread: unread.length > 0 };
    }, Effect.orDie);

    /** A snapshot and the sequence it is current at, read in one transaction. */
    const snapshot = Effect.fn("Entries.snapshot")(function* (target: EntryTarget) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* requireTarget(target);
          const sequence = yield* changes.watermark;
          const { entries, hasOlder } = yield* newest(target, null, SNAPSHOT_SIZE);
          return { _tag: "snapshot", sequence, entries, hasOlder } satisfies EntryFrame;
        }),
      );
    });

    /** What changed after `after`, or `None` when the subscriber must start over. */
    const changesSince = Effect.fn("Entries.changesSince")(function* (
      target: EntryTarget,
      after: Sequence,
    ) {
      return yield* transaction(
        Effect.gen(function* () {
          yield* requireTarget(target);
          const resume = yield* changes.since(scopeOf(target), after);
          if (resume._tag === "gap") return Option.none<EntryFrame>();
          const last = resume.changes.at(-1);
          if (last === undefined)
            return Option.some<EntryFrame>({
              _tag: "changed",
              sequence: after,
              upsert: [],
            });
          const rows = yield* rowsOf({
            ids: [...new Set(resume.changes.map((change) => EntryId.make(change.entityId)))],
          }).pipe(Effect.orDie);
          const upsert = yield* Effect.forEach(rows, toEntry);
          return Option.some<EntryFrame>({ _tag: "changed", sequence: last.sequence, upsert });
        }),
      );
    });

    const subscribe = (target: EntryTarget, after: Sequence | null) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Joined before the first read, so a change committed in between is not missed.
          const signals = yield* changes.subscribe;
          const key = scopeKey(scopeOf(target));
          const resumed = after === null ? Option.none() : yield* changesSince(target, after);
          const first = Option.isSome(resumed) ? resumed.value : yield* snapshot(target);
          let sequence = first.sequence;
          const followUps = Stream.fromSubscription(signals).pipe(
            Stream.filter((scope) => scopeKey(scope) === key),
            Stream.mapEffect(() =>
              changesSince(target, sequence).pipe(
                // Too much changed at once to replay: start over.
                Effect.flatMap(
                  Option.match({ onNone: () => snapshot(target), onSome: Effect.succeed }),
                ),
              ),
            ),
            Stream.filter((frame) => frame._tag === "snapshot" || frame.upsert.length > 0),
            Stream.tap((frame) =>
              Effect.sync(() => {
                sequence = frame.sequence;
              }),
            ),
          );
          return Stream.concat(Stream.succeed(first), followUps);
        }),
      );

    const latest = (target: EntryTarget, limit: number) =>
      Effect.map(newest(target, null, limit), (page) => page.entries);

    return Entries.of({
      append,
      update,
      find: findRow,
      history,
      latest,
      markRead,
      summary,
      subscribe,
    });
  }),
);
