// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type ConnectorAskEntry,
  type ConnectorGlyph,
  type ConnectorId,
  Conflict,
  EntryId,
  type Invalid,
  NotFound,
  type OAuthClientInput,
  RoomId,
} from "@j3-bots/contracts";
import type { ToolInput } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import {
  AudienceColumn,
  audienceColumns,
  audienceOf,
  DispatchSeq,
  TurnsInvariant,
} from "../turns/model.ts";
import { Wakes } from "../turns/Wakes.ts";
import { type SpeakingTurn, workStopped } from "../turns/workStopped.ts";

/** How long an ask to add a connector waits for the operator before it expires. */
const CONNECTOR_ASK_WAIT = Duration.hours(24);

/** How often the server looks for asks past their wait. */
const SWEEP_EVERY = Duration.minutes(1);

/**
 * What the operator's yes gives an add: their word for an address in their
 * own network, or the client they registered at an own app's issuer, which
 * the server uses it with only.
 */
export type Needs =
  | { readonly _tag: "private-network" }
  | { readonly _tag: "own-app"; readonly issuer: OAuthClientInput["issuer"] };

/**
 * What a bot asked to add, as its `add_mcp_server` call gave it: kept in the
 * server's memory only, since an address or a value can carry a key.
 */
export interface PendingAdd {
  readonly botId: BotId;
  /** The call's request, which the connector's id derives from. */
  readonly requestId: string;
  readonly input: ToolInput<"add_mcp_server">;
  readonly needs: Needs;
  /**
   * Whether the bot was the primary bot when it asked: the yes grants the
   * server no more widely than the bot could have then.
   */
  readonly primary: boolean;
}

/** How the operator's yes ended: the connector added, or the add refused. */
export type Settled =
  | { readonly _tag: "added"; readonly connectorId: ConnectorId; readonly note: string }
  | { readonly _tag: "failed"; readonly note: string };

type Closing =
  | { readonly _tag: "added"; readonly connectorId: ConnectorId; readonly note: string }
  | { readonly _tag: "failed"; readonly note: string }
  | { readonly _tag: "declined" }
  | { readonly _tag: "expired" };

const OpenAsk = Schema.Struct({
  bot_id: BotId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  origin_seq: Schema.NullOr(DispatchSeq),
});

/**
 * A bot's asks for the operator's word before it adds a connector that
 * needs it (decision 0068, `docs/architecture/server.md`, "Connectors"): the
 * `connector-ask` card `add_mcp_server` shows in the bot's conversation
 * closes once, added or failed on the operator's yes, declined, or expired
 * past its wait or under a restart, and each close wakes the bot for the
 * audience of the turn that asked.
 */
export class ConnectorAsks extends Context.Service<
  ConnectorAsks,
  {
    /**
     * Shows the card for `add` in its bot's conversation; false when the
     * operator stopped the work that asked, and nothing was shown.
     */
    readonly open: (input: {
      readonly turn: SpeakingTurn;
      readonly name: string;
      readonly glyph: ConnectorGlyph | null;
      readonly ask: ConnectorAskEntry["ask"];
      readonly add: PendingAdd;
    }) => Effect.Effect<boolean>;
    /**
     * The operator's yes: `run` adds what the bot asked for, and the card
     * closes as it settled. `run` refusing the answer leaves the card open.
     */
    readonly answer: (
      entryId: EntryId,
      run: (add: PendingAdd) => Effect.Effect<Settled, Invalid>,
    ) => Effect.Effect<void, Conflict | Invalid | NotFound>;
    /**
     * The operator declines, in the caller's transaction. False when it had
     * closed already, or their yes is being added.
     */
    readonly decline: (card: ConnectorAskEntry) => Effect.Effect<boolean>;
    /** The expiry sweep, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/connectors/ConnectorAsks") {}

/** Where a held ask is: waiting on the operator, or being added on their yes. */
interface Held {
  readonly add: PendingAdd;
  readonly adding: boolean;
}

export const layer = Layer.effect(
  ConnectorAsks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = yield* Entries;
    const wakes = yield* Wakes;
    const transaction = transactional(sql);
    const stoppedWork = workStopped(sql);
    // An ask opened before this start lost what its bot asked to add.
    const startedAt = timeText(yield* DateTime.now);
    const held = yield* Ref.make<ReadonlyMap<EntryId, Held>>(new Map());

    const setHeld = (entryId: EntryId, value: Held | null) =>
      Ref.update(held, (map) => {
        const next = new Map(map);
        if (value === null) next.delete(entryId);
        else next.set(entryId, value);
        return next;
      });

    const closeRow = SqlSchema.findAll({
      Request: Schema.Struct({
        entryId: EntryId,
        at: Schema.String,
        closing: Schema.Literals(["added", "declined", "failed", "expired"]),
      }),
      Result: OpenAsk,
      execute: ({ entryId, at, closing }) => sql`
        UPDATE connector_asks SET closed_at = ${at}, closing = ${closing}
        WHERE entry_id = ${entryId} AND closed_at IS NULL
        RETURNING bot_id, audience, audience_room_id, origin_seq
      `,
    });

    /**
     * Closes the ask, if it is still open, and wakes its bot, in the caller's
     * transaction. The operator's answer is their word, which a Stop never
     * cancels ahead of time; an expiry continues the work that asked, so a
     * Stop of that work leaves the bot asleep.
     */
    const close = Effect.fn("ConnectorAsks.close")(function* (entryId: EntryId, outcome: Closing) {
      const [row] = yield* closeRow({
        entryId,
        at: timeText(yield* DateTime.now),
        closing: outcome._tag,
      }).pipe(Effect.orDie);
      if (row === undefined) return false;
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "connector-ask") {
        return yield* Effect.die(
          new TurnsInvariant({
            invariant: "An ask to add a connector's entry is a connector-ask one",
          }),
        );
      }
      const card = found.value.entry;
      yield* entries.update({
        ...card,
        status:
          outcome._tag === "added"
            ? { _tag: "added", connectorId: outcome.connectorId }
            : { _tag: outcome._tag },
      });
      const [wakeId] = yield* wakes.record([
        {
          botId: row.bot_id,
          kind: "system",
          audience: audienceOf(row),
          payload: {
            _tag: "connector-ask",
            cardId: card.id,
            outcome: outcome._tag,
            server: card.name,
            note: outcome._tag === "added" || outcome._tag === "failed" ? outcome.note : null,
          },
          sourceEntryId: card.id,
          hops: 0,
          retryOf: null,
          cause:
            outcome._tag !== "expired" || row.origin_seq === null
              ? { _tag: "operator" }
              : { _tag: "work", seq: row.origin_seq },
        },
      ]);
      yield* sql`
        UPDATE connector_asks SET follow_up_wake_id = ${wakeId ?? null} WHERE entry_id = ${entryId}
      `.pipe(Effect.orDie);
      return true;
    });

    const open = Effect.fn("ConnectorAsks.open")(function* (input: {
      readonly turn: SpeakingTurn;
      readonly name: string;
      readonly glyph: ConnectorGlyph | null;
      readonly ask: ConnectorAskEntry["ask"];
      readonly add: PendingAdd;
    }) {
      const { turn, add } = input;
      const shown = yield* transaction(
        Effect.gen(function* () {
          const work = yield* stoppedWork(turn);
          if (work.stopped) return null;
          const card = yield* entries.append({
            target: { _tag: "conversation", botId: add.botId },
            entry: {
              _tag: "connector-ask",
              author: { _tag: "bot", botId: add.botId },
              name: input.name,
              glyph: input.glyph,
              ask: input.ask,
              status: { _tag: "pending" },
            },
          });
          const now = yield* DateTime.now;
          const columns = audienceColumns(turn.audience);
          yield* sql`
            INSERT INTO connector_asks (
              entry_id, bot_id, audience, audience_room_id, origin_seq, expires_at, created_at
            ) VALUES (
              ${card.id}, ${add.botId}, ${columns.audience}, ${columns.roomId}, ${work.seq},
              ${timeText(DateTime.addDuration(now, CONNECTOR_ASK_WAIT))}, ${timeText(now)}
            )
          `.pipe(Effect.orDie);
          return card.id;
        }),
      );
      if (shown === null) return false;
      // Opened after this start, it is never taken for one a restart lost.
      yield* setHeld(shown, { add, adding: false });
      return true;
    });

    /**
     * Takes the ask for its add, once: a second answer, or a decline, finds
     * it being added and is refused.
     */
    const take = (entryId: EntryId) =>
      Ref.modify(held, (map): readonly [PendingAdd | null, ReadonlyMap<EntryId, Held>] => {
        const found = map.get(entryId);
        if (found === undefined || found.adding) return [null, map];
        return [found.add, new Map(map).set(entryId, { add: found.add, adding: true })];
      });

    const deadline = SqlSchema.findAll({
      Request: EntryId,
      Result: Schema.Struct({ expires_at: Schema.String }),
      execute: (entryId) => sql`
        SELECT expires_at FROM connector_asks WHERE entry_id = ${entryId} AND closed_at IS NULL
      `,
    });

    const answer = Effect.fn("ConnectorAsks.answer")(function* (
      entryId: EntryId,
      run: (add: PendingAdd) => Effect.Effect<Settled, Invalid>,
    ) {
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "connector-ask") {
        return yield* new NotFound({ resource: "entry" });
      }
      // Past its wait, an ask the sweep has not reached yet is closed all the same.
      const [open] = yield* deadline(entryId).pipe(Effect.orDie);
      const now = timeText(yield* DateTime.now);
      if (
        found.value.entry.status._tag !== "pending" ||
        open === undefined ||
        open.expires_at <= now
      ) {
        return yield* new Conflict({ reason: "card-closed" });
      }
      // The yes is the operator's: once taken, the add and the close finish
      // even when the connection that carried it drops. The add calls the
      // connector's server, so no transaction is held meanwhile.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const add = yield* take(entryId);
          if (add === null) return yield* new Conflict({ reason: "card-closed" });
          const settled = yield* run(add).pipe(
            Effect.onError(() => setHeld(entryId, { add, adding: false })),
          );
          yield* transaction(close(entryId, settled));
          yield* setHeld(entryId, null);
        }),
      );
    });

    const decline = Effect.fn("ConnectorAsks.decline")(function* (card: ConnectorAskEntry) {
      if ((yield* Ref.get(held)).get(card.id)?.adding === true) return false;
      const closed = yield* close(card.id, { _tag: "declined" });
      yield* setHeld(card.id, null);
      return closed;
    });

    const openAsks = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        entry_id: EntryId,
        expires_at: Schema.String,
        created_at: Schema.String,
      }),
      execute: () => sql`
        SELECT entry_id, expires_at, created_at FROM connector_asks WHERE closed_at IS NULL
      `,
    });

    /**
     * Closes as expired the asks past `CONNECTOR_ASK_WAIT`, and those opened
     * before this start, whose add a restart lost. One being added waits for
     * its add.
     */
    const sweep = Effect.gen(function* () {
      const open = yield* openAsks(undefined).pipe(Effect.orDie);
      if (open.length === 0) return;
      const now = timeText(yield* DateTime.now);
      for (const { entry_id, expires_at, created_at } of open) {
        if (expires_at > now && created_at >= startedAt) continue;
        const add = yield* take(entry_id);
        const lost = created_at < startedAt;
        if (add === null && !lost) continue;
        yield* transaction(close(entry_id, { _tag: "expired" }));
        yield* setHeld(entry_id, null);
      }
    });

    const run = Stream.tick(SWEEP_EVERY).pipe(
      Stream.runForEach(() => sweep),
      Effect.andThen(Effect.never),
    );

    return ConnectorAsks.of({ open, answer, decline, run });
  }),
);
