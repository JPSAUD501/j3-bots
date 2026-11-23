// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type BrowserHelpEntry,
  type CommandId,
  Conflict,
  EntryId,
  Invalid,
  NotFound,
  RoomId,
} from "@j3-bots/contracts";
import { EngineTabId } from "@j3-bots/engine-t3";
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
import { RELEASE_WAIT, SWEEP_EVERY, TAB_ABSENT_GRACE } from "./browserHelpRules.ts";
import { BrowserTabs } from "./BrowserTabs.ts";
import { BrowserViewers } from "./BrowserViewers.ts";

/** How a browser help card closed. */
type Closing = "done" | "declined" | "tab-closed" | "timed-out";

const OpenCard = Schema.Struct({
  entry_id: EntryId,
  bot_id: BotId,
  engine_tab_id: EngineTabId,
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

const statusOf = (closing: Closing): BrowserHelpEntry["status"] =>
  closing === "done" || closing === "declined"
    ? { _tag: closing }
    : { _tag: "expired", cause: closing };

/**
 * The operator's help in a bot's browser (`docs/architecture/server.md`,
 * Browser help). A `browser-help` card closes once: answered done or declined,
 * expired with its tab, or expired past its wait while no device holds the
 * bot's tabs. Each close wakes the bot for the audience of the turn that
 * asked. Apart from a card, a device that took the bot's browser while a turn
 * of its main session ran wakes the bot once it gives the browser back.
 */
export class BrowserHelp extends Context.Service<
  BrowserHelp,
  {
    /**
     * The operator's answer to a card. Any device of theirs that holds the
     * bot's tabs lets go first, so the bot it wakes can use them.
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
    const tabs = yield* BrowserTabs;
    const viewers = yield* BrowserViewers;
    const transaction = transactional(sql);

    const openCards = SqlSchema.findAll({
      Request: Schema.Void,
      Result: OpenCard,
      execute: () => sql`
        SELECT entry_id, bot_id, engine_tab_id, expires_at
        FROM browser_help_cards WHERE closed_at IS NULL
      `,
    })(undefined).pipe(Effect.orDie);

    const closeRow = SqlSchema.findAll({
      Request: Schema.Struct({ entryId: EntryId, at: Schema.String }),
      Result: ClosedCard,
      execute: ({ entryId, at }) => sql`
        UPDATE browser_help_cards SET closed_at = ${at}
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
      const [row] = yield* closeRow({ entryId, at: timeText(yield* DateTime.now) }).pipe(
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
     * Every device lets go of the bot's tabs, and the engine says so, or
     * `RELEASE_WAIT` passes: a lost reply never holds up the answer. Safe to
     * repeat: a tab nobody holds is left as it is.
     */
    const handBack = Effect.fn("BrowserHelp.handBack")(function* (botId: BotId) {
      yield* viewers.release(yield* tabs.tabsOf(botId));
      yield* tabs.held.pipe(
        Stream.filter((held) => !held.some((one) => one.botId === botId)),
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
      // Outside the transaction: it waits on the engine. The card is closed
      // only once the bot can use its browser again.
      if (card.status._tag === "pending") yield* handBack(card.author.botId);
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
          if (!(yield* close(input.entryId, input.outcome))) {
            return yield* new Conflict({ reason: "card-closed" });
          }
        }),
      });
    });

    // ---- Expiry -------------------------------------------------------------------

    /** Since when each open card's tab has been missing from the engine's list. */
    const absentSince = new Map<EntryId, DateTime.Utc>();

    const sweep = Effect.fn("BrowserHelp.sweep")(function* (
      open: ReadonlySet<EngineTabId>,
      heldBy: ReadonlySet<BotId>,
    ) {
      const now = yield* DateTime.now;
      const cards = yield* openCards;
      const stillOpen = new Set(cards.map((card) => card.entry_id));
      for (const id of absentSince.keys()) if (!stillOpen.has(id)) absentSince.delete(id);
      for (const card of cards) {
        let closing: Closing | null = null;
        if (open.has(card.engine_tab_id)) {
          absentSince.delete(card.entry_id);
        } else {
          const since = absentSince.get(card.entry_id) ?? now;
          absentSince.set(card.entry_id, since);
          if (Duration.isGreaterThanOrEqualTo(DateTime.distance(since, now), TAB_ABSENT_GRACE)) {
            closing = "tab-closed";
          }
        }
        // Someone at work in the bot's browser keeps the card open past its wait.
        if (closing === null && DateTime.isGreaterThanOrEqualTo(now, card.expires_at)) {
          if (!heldBy.has(card.bot_id)) closing = "timed-out";
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
     * The operator gave back the bot's browser they took at `since`. Unless a
     * card covered it, or a wake about the browser already waits, the bot is
     * woken when a turn of its main session ran meanwhile: its browser calls
     * failed while the operator held it. With no turn, nothing was blocked.
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

    /** Since when a device has held one of each bot's tabs. */
    const heldSince = new Map<BotId, DateTime.Utc>();

    const followHeld = Effect.fn("BrowserHelp.followHeld")(function* (
      held: ReadonlyArray<{ readonly botId: BotId }>,
    ) {
      const now = yield* DateTime.now;
      const holding = new Set(held.map((one) => one.botId));
      for (const botId of holding) if (!heldSince.has(botId)) heldSince.set(botId, now);
      for (const [botId, since] of heldSince) {
        if (holding.has(botId)) continue;
        heldSince.delete(botId);
        yield* transaction(handedBack(botId, since));
      }
    });

    /**
     * The sweep runs on every change of the open or held tabs, and on a
     * steady tick for the cards' waits.
     */
    const sweeps = Stream.zipLatestWith(
      Stream.zipLatestWith(tabs.open, tabs.held, (open, held) => ({ open, held })),
      Stream.tick(SWEEP_EVERY),
      (state) => state,
    ).pipe(
      Stream.runForEach(({ open, held }) => sweep(open, new Set(held.map((one) => one.botId)))),
    );

    const run = Effect.all([tabs.held.pipe(Stream.runForEach(followHeld)), sweeps], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.andThen(Effect.never));

    return BrowserHelp.of({ answer, run });
  }),
);
