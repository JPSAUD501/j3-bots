// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type BrowserHelpEntry,
  BrowserTabRef,
  type CommandId,
  Conflict,
  EntryId,
  Invalid,
  NotFound,
  RoomId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { AudienceColumn, audienceOf, DispatchSeq, TurnsInvariant } from "../turns/model.ts";
import { type NewWake, Wakes } from "../turns/Wakes.ts";
import {
  HAND_BACK_GRACE,
  RELEASE_WAIT,
  SWEEP_EVERY,
  TAB_ABSENT_GRACE,
} from "./browserHelpRules.ts";
import { type PersonHold, TabAccess } from "./TabAccess.ts";

/** How a browser help card closed. */
type Closing = "done" | "declined" | "tab-closed" | "timed-out";

const OpenCard = Schema.Struct({
  entry_id: EntryId,
  bot_id: BotId,
  tab_ref: BrowserTabRef,
  expires_at: Time,
});

const ClosedCard = Schema.Struct({
  bot_id: BotId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  origin_seq: Schema.NullOr(DispatchSeq),
});

const WorkedTurn = Schema.Struct({
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  stopped: Schema.BooleanFromBit,
  seq: Schema.NullOr(DispatchSeq),
});

/** The bots on a tab the person holds. */
const botsHeld = (held: ReadonlyArray<PersonHold>): ReadonlySet<BotId> =>
  new Set(held.flatMap((hold) => hold.onIt));

const statusOf = (closing: Closing): BrowserHelpEntry["status"] =>
  closing === "done" || closing === "declined"
    ? { _tag: closing }
    : { _tag: "expired", cause: closing };

/**
 * The operator's help in a bot's browser (`docs/architecture/server.md`,
 * Browser help). A `browser-help` card closes once: answered done or declined,
 * expired with its tab, or expired past its wait while the person holds no
 * tab the bot is on. Each close wakes the bot for the audience of the turn
 * that asked. Apart from a card, a person who took a tab the bot was on while
 * a turn of its main session ran wakes the bot once they give it back.
 */
export class BrowserHelp extends Context.Service<
  BrowserHelp,
  {
    /**
     * The operator's answer to a card. They let go of every tab the bot is
     * on first, so the bot it wakes can use them.
     */
    readonly answer: (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
      readonly outcome: "done" | "declined";
    }) => Effect.Effect<void, NotFound | Conflict | Invalid>;
    /** The expiry sweep and the hand-back watcher, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/browser/BrowserHelp") {}

export const layer = Layer.effect(
  BrowserHelp,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const wakes = yield* Wakes;
    const tabs = yield* TabAccess;
    const transaction = transactional(sql);

    const openCards = SqlSchema.findAll({
      Request: Schema.Void,
      Result: OpenCard,
      execute: () => sql`
        SELECT entry_id, bot_id, tab_ref, expires_at
        FROM browser_help_cards WHERE closed_at IS NULL
      `,
    })(undefined).pipe(Effect.orDie);

    const closeRow = SqlSchema.findAll({
      Request: Schema.Struct({
        entryId: EntryId,
        at: Schema.String,
        closing: Schema.Literals(["done", "declined", "tab-closed", "timed-out"]),
      }),
      Result: ClosedCard,
      execute: ({ entryId, at, closing }) => sql`
        UPDATE browser_help_cards SET closed_at = ${at}, closing = ${closing},
          closed_through_seq = (SELECT COALESCE(MAX(seq), 0) FROM entries)
        WHERE entry_id = ${entryId} AND closed_at IS NULL
        RETURNING bot_id, audience, audience_room_id, origin_seq
      `,
    });

    /**
     * Closes the card, if it is still open, and wakes its bot: in the caller's
     * transaction. An answer is the operator's word, which a Stop never
     * cancels ahead of time; an expiry continues the work that asked, so a
     * Stop of that work leaves the bot asleep.
     */
    const close = Effect.fn("BrowserHelp.close")(function* (entryId: EntryId, closing: Closing) {
      const [row] = yield* closeRow({ entryId, at: timeText(yield* DateTime.now), closing }).pipe(
        Effect.orDie,
      );
      if (row === undefined) return false;
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "browser-help") {
        return yield* Effect.die(
          new TurnsInvariant({ invariant: "A browser help card's entry is a browser-help one" }),
        );
      }
      const card = found.value.entry;
      yield* entries.update({ ...card, status: statusOf(closing) });
      const answered = closing === "done" || closing === "declined";
      const [wakeId] = yield* wakes.record([
        {
          botId: row.bot_id,
          kind: "system",
          audience: audienceOf(row),
          payload: {
            _tag: "browser-help",
            cardId: card.id,
            outcome: closing,
            site: card.site === "" ? null : card.site,
          },
          sourceEntryId: card.id,
          hops: 0,
          retryOf: null,
          cause:
            answered || row.origin_seq === null
              ? { _tag: "operator" }
              : { _tag: "work", seq: row.origin_seq },
        },
      ]);
      yield* sql`
        UPDATE browser_help_cards SET follow_up_wake_id = ${wakeId ?? null}
        WHERE entry_id = ${entryId}
      `.pipe(Effect.orDie);
      return true;
    });

    /**
     * The person lets go of every tab the bot is on, and the tabs say so, or
     * `RELEASE_WAIT` passes: a hold that does not end never holds up the
     * answer. Safe to repeat: a tab nobody holds is left as it is.
     */
    const handBack = Effect.fn("BrowserHelp.handBack")(function* (botId: BotId) {
      const holds = yield* tabs.personHolds.pipe(Stream.runHead);
      for (const hold of Option.getOrElse(holds, () => [])) {
        if (hold.onIt.includes(botId)) yield* tabs.endPersonHold(hold.tab);
      }
      yield* tabs.personHolds.pipe(
        Stream.filter((held) => !held.some((hold) => hold.onIt.includes(botId))),
        Stream.runHead,
        Effect.timeoutOption(RELEASE_WAIT),
      );
    });

    const answer = Effect.fn("BrowserHelp.answer")(function* (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
      readonly outcome: "done" | "declined";
    }) {
      const found = yield* entries.find(input.entryId);
      if (Option.isNone(found)) return yield* new NotFound({ resource: "entry" });
      const card = found.value.entry;
      if (card._tag !== "browser-help") return yield* new Invalid({ reason: "answer" });
      // The card is claimed first, so nothing that letting go of the tabs
      // sets off, the expiry sweep included, can close it in between.
      yield* receipts.once({
        commandId: input.commandId,
        method: "card.answer",
        payload: {
          commandId: input.commandId,
          entryId: input.entryId,
          answer: { _tag: "browser-help", outcome: input.outcome },
        },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          if (yield* close(input.entryId, input.outcome)) return;
          // Two of the operator's devices gave the same answer at once: the
          // card says what both said.
          const closed = yield* entries.find(input.entryId);
          const status = Option.map(closed, ({ entry }) =>
            entry._tag === "browser-help" ? entry.status._tag : null,
          );
          if (Option.getOrNull(status) === input.outcome) return;
          return yield* new Conflict({ reason: "card-closed" });
        }),
      });
      // Then the person lets go, outside the transaction. The bot's first
      // call when it wakes is a snapshot, which reads the page whoever holds
      // it.
      yield* handBack(card.author.botId);
    });

    // ---- Expiry -------------------------------------------------------------------

    /**
     * Since when each open card's tab has been missing from the tabs, and
     * when the person last gave back the tabs each bot is on. Both live in
     * memory, from the server's start: after a restart, a missing tab's grace
     * counts again from then, and a card past its wait has no hand-back grace,
     * since nobody held a tab across the restart.
     */
    const absentSince = new Map<EntryId, DateTime.Utc>();
    /**
     * Since when the person has held a tab each bot is on, and when they last
     * gave back the tabs each bot is on, as `followHeld` saw the holds change.
     */
    const heldSince = new Map<BotId, DateTime.Utc>();
    const givenBackAt = new Map<BotId, DateTime.Utc>();

    const sweep = Effect.fn("BrowserHelp.sweep")(function* (open: ReadonlySet<BrowserTabRef>) {
      const now = yield* DateTime.now;
      const cards = yield* openCards;
      const stillOpen = new Set(cards.map((card) => card.entry_id));
      for (const id of absentSince.keys()) if (!stillOpen.has(id)) absentSince.delete(id);
      for (const card of cards) {
        let closing: Closing | null = null;
        if (open.has(card.tab_ref)) {
          absentSince.delete(card.entry_id);
        } else {
          const since = absentSince.get(card.entry_id) ?? now;
          absentSince.set(card.entry_id, since);
          if (Duration.isGreaterThanOrEqualTo(DateTime.distance(since, now), TAB_ABSENT_GRACE)) {
            closing = "tab-closed";
          }
        }
        // Someone at work in the bot's browser keeps the card open past its
        // wait, and for a grace once they gave it back, to answer the card.
        if (closing === null && DateTime.isGreaterThanOrEqualTo(now, card.expires_at)) {
          const givenBack = givenBackAt.get(card.bot_id);
          const graced =
            givenBack !== undefined &&
            Duration.isLessThan(DateTime.distance(givenBack, now), HAND_BACK_GRACE);
          if (!heldSince.has(card.bot_id) && !graced) closing = "timed-out";
        }
        if (closing === null) continue;
        yield* transaction(close(card.entry_id, closing));
        absentSince.delete(card.entry_id);
      }
    });

    // ---- Hand-back ----------------------------------------------------------------

    const workedTurn = SqlSchema.findOneOption({
      Request: Schema.Struct({ botId: BotId, since: Schema.String, now: Schema.String }),
      Result: WorkedTurn,
      execute: ({ botId, since, now }) => sql`
        SELECT t.audience, t.audience_room_id, t.stop_id IS NOT NULL AS stopped,
          (
            SELECT MIN(d.seq) FROM dispatches d
            WHERE d.session_id = t.session_id AND d.engine_turn_id = t.engine_turn_id
          ) AS seq
        FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE s.bot_id = ${botId} AND s.purpose = 'main'
          AND t.started_at <= ${now} AND (t.finished_at IS NULL OR t.finished_at >= ${since})
        ORDER BY t.started_at DESC LIMIT 1
      `,
    });

    /**
     * The person gave back the tabs the bot is on, which they took at
     * `since`. Unless a card covered it, or a wake about the browser already
     * waits, the bot is woken when a turn of its main session ran meanwhile:
     * its browser calls waited or failed while the person held them. With no
     * turn, nothing was blocked.
     */
    const handedBack = Effect.fn("BrowserHelp.handedBack")(function* (
      botId: BotId,
      since: DateTime.Utc,
    ) {
      const now = timeText(yield* DateTime.now);
      const sinceText = timeText(since);
      const [covered] = yield* sql`
        SELECT 1 FROM browser_help_cards
        WHERE bot_id = ${botId} AND (closed_at IS NULL OR closed_at >= ${sinceText})
        UNION ALL
        SELECT 1 FROM wakes
        WHERE bot_id = ${botId} AND status = 'pending'
          AND json_extract(payload_json, '$._tag') = 'browser-help'
        LIMIT 1
      `.pipe(Effect.orDie);
      if (covered !== undefined) return;
      const turn = yield* workedTurn({ botId, since: sinceText, now }).pipe(Effect.orDie);
      if (Option.isNone(turn) || turn.value.stopped) return;
      const wake: NewWake = {
        botId,
        kind: "system",
        audience: audienceOf(turn.value),
        payload: { _tag: "browser-help", cardId: null, outcome: "handed-back", site: null },
        sourceEntryId: null,
        hops: 0,
        retryOf: null,
        cause:
          turn.value.seq === null ? { _tag: "operator" } : { _tag: "work", seq: turn.value.seq },
      };
      yield* wakes.record([wake]);
    });

    const followHeld = Effect.fn("BrowserHelp.followHeld")(function* (
      held: ReadonlyArray<PersonHold>,
    ) {
      const now = yield* DateTime.now;
      const holding = botsHeld(held);
      for (const botId of holding) {
        if (heldSince.has(botId)) continue;
        heldSince.set(botId, now);
        givenBackAt.delete(botId);
      }
      for (const [botId, since] of heldSince) {
        if (holding.has(botId)) continue;
        heldSince.delete(botId);
        givenBackAt.set(botId, now);
        yield* transaction(handedBack(botId, since));
      }
    });

    /**
     * One fiber follows the holds, in the order they changed, and sweeps
     * after each change of the open or held tabs, and on a steady tick for
     * the cards' waits: a sweep never sees a hold the holds' own record has
     * not taken in yet. It reads the open tabs as they are when it runs.
     */
    const run = Stream.mergeAll(
      [
        tabs.personHolds.pipe(Stream.map(Option.some)),
        tabs.present.pipe(Stream.as(Option.none<ReadonlyArray<PersonHold>>())),
        Stream.tick(SWEEP_EVERY).pipe(Stream.as(Option.none<ReadonlyArray<PersonHold>>())),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach((held) =>
        Effect.gen(function* () {
          if (Option.isSome(held)) yield* followHeld(held.value);
          const open = yield* Stream.runHead(tabs.present);
          yield* sweep(Option.getOrElse(open, () => new Set<BrowserTabRef>()));
        }),
      ),
      Effect.andThen(Effect.never),
    );

    return BrowserHelp.of({ answer, run });
  }),
);
