// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, type RoomId, Sequence } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, timeText } from "./columns.ts";

/**
 * What a change belongs to. `conversation`, `room` and `routines` are recorded
 * in the `changes` table, which their subscriptions resume from; `bot` and
 * `sections` only tell live subscribers that a bot itself, or the roster's
 * sections, changed (the roster does not resume).
 */
export type ChangeScope =
  | { readonly _tag: "conversation"; readonly botId: BotId }
  | { readonly _tag: "room"; readonly roomId: RoomId }
  | { readonly _tag: "routines"; readonly botId: BotId }
  | { readonly _tag: "bot"; readonly botId: BotId }
  | { readonly _tag: "sections" };

/** The scopes the `changes` table records. */
type RecordedScope = Exclude<ChangeScope, { readonly _tag: "bot" | "sections" }>;

/** The `scope` column's value, and what a subscriber compares scopes by. */
export const scopeKey = (scope: ChangeScope): string => {
  switch (scope._tag) {
    case "room":
      return `room:${scope.roomId}`;
    case "sections":
      return "sections";
    default:
      return `${scope._tag}:${scope.botId}`;
  }
};

/** One recorded change: the entity, and whether it was removed. */
interface Change {
  readonly sequence: Sequence;
  readonly entityId: string;
  readonly removed: boolean;
}

/**
 * Where a resumed subscription starts: the changes after its sequence, or
 * `gap` when they can no longer all be told (too many, or older than what the
 * table keeps), and the subscriber must start over from a snapshot.
 */
export type Resume =
  | { readonly _tag: "changes"; readonly changes: ReadonlyArray<Change> }
  | { readonly _tag: "gap" };

/** At most this many changes are replayed to a resuming subscriber. */
const REPLAY_LIMIT = 500;

const ChangeRow = Schema.Struct({
  seq: Sequence,
  entity_id: Schema.String,
  removed: Flag,
});

/**
 * The server's change history, and the live signal that it moved. Every write
 * to something a client renders records its change in the same transaction;
 * subscribers are told once that transaction commits, then read what changed
 * since the last sequence they sent.
 */
export class ChangeLog extends Context.Service<
  ChangeLog,
  {
    /** Records a change, and signals it once the surrounding transaction commits. */
    readonly record: (
      scope: RecordedScope,
      entityId: string,
      removed?: boolean,
    ) => Effect.Effect<void>;
    /** Signals a change subscribers read from current state, once the transaction commits. */
    readonly touch: (scope: ChangeScope) => Effect.Effect<void>;
    /** Signals from now on. Subscribe before reading a snapshot, so no change falls between. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<ChangeScope>, never, Scope.Scope>;
    /** The newest sequence: a snapshot read in the same transaction is current as of it. */
    readonly watermark: Effect.Effect<Sequence>;
    /** The changes in `scope` after `after`, oldest first. */
    readonly since: (scope: RecordedScope, after: Sequence) => Effect.Effect<Resume>;
  }
>()("@j3-bots/server/persistence/ChangeLog") {}

export const layer = Layer.effect(
  ChangeLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pubsub = yield* PubSub.unbounded<ChangeScope>();

    const publishAfterCommit = (scope: ChangeScope) =>
      sql.afterCommit(PubSub.publish(pubsub, scope).pipe(Effect.asVoid));

    const record = Effect.fn("ChangeLog.record")(function* (
      scope: RecordedScope,
      entityId: string,
      removed = false,
    ) {
      const at = timeText(yield* DateTime.now);
      yield* sql`
        INSERT INTO changes (scope, entity_id, removed, created_at)
        VALUES (${scopeKey(scope)}, ${entityId}, ${removed ? 1 : 0}, ${at})
      `.pipe(Effect.orDie);
      yield* publishAfterCommit(scope);
    });

    const newest = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ seq: Schema.NullOr(Sequence), oldest: Schema.NullOr(Sequence) }),
      execute: () => sql`SELECT MAX(seq) AS seq, MIN(seq) AS oldest FROM changes`,
    });
    const bounds = newest(undefined).pipe(
      Effect.orDie,
      Effect.map((row) => ({
        newest: Option.isSome(row) ? row.value.seq : null,
        oldest: Option.isSome(row) ? row.value.oldest : null,
      })),
    );

    const changesAfter = SqlSchema.findAll({
      Request: Schema.Struct({ scope: Schema.String, after: Sequence }),
      Result: ChangeRow,
      execute: ({ scope, after }) => sql`
        SELECT seq, entity_id, removed FROM changes
        WHERE scope = ${scope} AND seq > ${after}
        ORDER BY seq
        LIMIT ${REPLAY_LIMIT + 1}
      `,
    });

    const since = Effect.fn("ChangeLog.since")(function* (scope: RecordedScope, after: Sequence) {
      const { newest, oldest } = yield* bounds;
      // A sequence this server never handed out, or one older than the oldest
      // change it keeps, cannot be resumed from.
      if (after > (newest ?? 0)) return { _tag: "gap" } satisfies Resume;
      if (oldest !== null && after + 1 < oldest) return { _tag: "gap" } satisfies Resume;
      const rows = yield* changesAfter({ scope: scopeKey(scope), after }).pipe(Effect.orDie);
      if (rows.length > REPLAY_LIMIT) return { _tag: "gap" } satisfies Resume;
      return {
        _tag: "changes",
        changes: rows.map((row) => ({
          sequence: row.seq,
          entityId: row.entity_id,
          removed: row.removed,
        })),
      } satisfies Resume;
    });

    return ChangeLog.of({
      record,
      touch: publishAfterCommit,
      subscribe: PubSub.subscribe(pubsub),
      watermark: bounds.pipe(Effect.map(({ newest }) => newest ?? Sequence.make(0))),
      since,
    });
  }),
);
