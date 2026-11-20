// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  type AttachmentId,
  BotId,
  type CommandId,
  Conflict,
  EntryId,
  type EntryTarget,
  Invalid,
  type Mentions,
  type MessageEntry,
  NotFound,
  type QuestionEntry,
  RoomId,
} from "@j3-bots/contracts";
import { attachmentLimitViolation, type TurnId } from "@j3-bots/engine-t3";
import type {
  AskAnswer,
  CatchUpItem,
  OperatorMessage,
  TeammateMessage,
  Wake,
} from "@j3-bots/prompts";
import { renderWake } from "@j3-bots/prompts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Attachments } from "../attachments/Attachments.ts";
import { BotStore } from "../bots/BotStore.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { RoomRouting } from "../rooms/RoomRouting.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { Ledger, WAKE_COLUMNS, WakeRow } from "./Ledger.ts";
import {
  type Audience,
  audienceColumns,
  audienceOf,
  CatchUpNote,
  conversation,
  DispatchRowId,
  sameAudience,
  SessionRowId,
  TurnsInvariant,
} from "./model.ts";
import { inboxPath, Sender, type SendResult } from "./Sender.ts";
import { isIdle, sessionWork } from "./sessionWork.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { type Pass, onePassAtATime, passOutcome, reconcile } from "./reconciler.ts";
import { Signals } from "./Signals.ts";
import { Wakes } from "./Wakes.ts";

const MainSession = Schema.Struct({
  id: SessionRowId,
  bot_id: Schema.String,
});

const AskCardRow = Schema.Struct({
  option_values_json: json(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  audience_room_id: Schema.NullOr(RoomId),
});

const WaitingBot = Schema.Struct({ bot_id: BotId });

const NoteRow = Schema.Struct({ id: Schema.String, note_json: Schema.NullOr(json(CatchUpNote)) });
const HeldRow = Schema.Struct({
  id: Schema.String,
  sender_bot_id: BotId,
  text: Schema.String,
  created_at: Time,
});

/** One planned dispatch: the wakes it carries, into which session, and how. */
interface Plan {
  readonly sessionId: SessionRowId;
  readonly botId: BotId;
  readonly wakes: ReadonlyArray<WakeRow>;
  readonly audience: Audience;
  readonly delivery:
    | { readonly _tag: "start" }
    | { readonly _tag: "steer"; readonly turnId: TurnId };
}

/**
 * The wake pipeline (`docs/architecture/server.md`, The wake pipeline). A wake
 * is written with the entry that caused it; the dispatcher holds it until its
 * bot's main session can take it, coalesces it with the bot's other pending
 * wakes of the same kind and audience, writes the dispatch with its envelope,
 * and hands it to `Sender`. Dispatches whose answer was lost are recovered
 * here too.
 */
export class Pipeline extends Context.Service<
  Pipeline,
  {
    readonly sendMessage: (input: {
      readonly commandId: CommandId;
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments: ReadonlyArray<AttachmentId>;
      readonly mentions?: Mentions;
    }) => Effect.Effect<EntryId, NotFound | Conflict | Invalid>;
    /** Sends a failed message again, as new wakes, to the recipients it failed for. */
    readonly retryMessage: (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /** Sends again the wakes of the dispatch a retryable notice is about. */
    readonly retryNotice: (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /** One pass of the dispatcher over every bot with pending wakes. */
    readonly dispatchPending: Effect.Effect<void>;
    /** One pass of the recovery over the dispatches due. */
    readonly recoverDue: Effect.Effect<void>;
    /** The dispatcher and the recovery, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/Pipeline") {}

export const layer = Layer.effect(
  Pipeline,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const ids = yield* Ids;
    const wakes = yield* Wakes;
    const entries = yield* Entries;
    const ledger = yield* Ledger;
    const sender = yield* Sender;
    const signals = yield* Signals;
    const receipts = yield* CommandReceipts;
    const settings = yield* SettingsStore;
    const rooms = yield* Rooms;
    const routing = yield* RoomRouting;
    const bots = yield* BotStore;
    const attachments = yield* Attachments;
    const engineState = yield* EngineState;
    const workOf = sessionWork(sql);
    const readiness = yield* Readiness;
    const observer = yield* Observer;
    const random = yield* SecureRandom.SecureRandom;

    // ---- Operator commands ------------------------------------------------

    const checkMentions = Effect.fn("Pipeline.checkMentions")(function* (
      target: EntryTarget,
      mentions: Mentions | undefined,
    ) {
      if (target._tag === "conversation") {
        if (mentions !== undefined && (mentions._tag !== "bots" || mentions.ids.length > 0)) {
          return yield* new Invalid({ reason: "mentions" });
        }
        return;
      }
      const room = yield* rooms.find(target.roomId);
      if (Option.isNone(room)) return yield* new NotFound({ resource: "room" });
      if (room.value.status === "archived") return yield* new Conflict({ reason: "room-archived" });
      if (mentions?._tag === "bots") {
        const members = new Set(room.value.members);
        if (
          new Set(mentions.ids).size !== mentions.ids.length ||
          mentions.ids.some((id) => !members.has(id))
        ) {
          return yield* new Invalid({ reason: "mentions" });
        }
      }
      return room.value;
    });

    /** The operator's files, each uploaded and not yet sent, within the engine's limits. */
    const filesOf = Effect.fn("Pipeline.filesOf")(function* (
      attachmentIds: ReadonlyArray<AttachmentId>,
    ) {
      if (new Set(attachmentIds).size !== attachmentIds.length) {
        return yield* new Invalid({ reason: "attachment" });
      }
      const files: Array<Attachment> = [];
      for (const id of attachmentIds) {
        const [row] = yield* sql<{ readonly source: string; readonly entry_id: string | null }>`
          SELECT source, entry_id FROM attachments WHERE id = ${id}
        `.pipe(Effect.orDie);
        const stored = yield* attachments.open(id);
        if (
          row === undefined ||
          Option.isNone(stored) ||
          row.source !== "operator" ||
          row.entry_id !== null
        ) {
          return yield* new Invalid({ reason: "attachment" });
        }
        files.push(stored.value.attachment);
      }
      if (attachmentLimitViolation(files) !== undefined) {
        return yield* new Invalid({ reason: "attachment" });
      }
      return files;
    });

    const sendMessage = Effect.fn("Pipeline.sendMessage")(function* (input: {
      readonly commandId: CommandId;
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments: ReadonlyArray<AttachmentId>;
      readonly mentions?: Mentions;
    }) {
      const { commandId, ...payload } = input;
      return yield* receipts.once({
        commandId,
        method: "message.send",
        payload,
        result: EntryId,
        apply: Effect.gen(function* () {
          if (input.target._tag === "conversation") {
            if (Option.isNone(yield* bots.find(input.target.botId))) {
              return yield* new NotFound({ resource: "bot" });
            }
          }
          const room = yield* checkMentions(input.target, input.mentions);
          const files = yield* filesOf(input.attachments);
          const entry = yield* entries.append({
            target: input.target,
            commandId,
            entry: {
              _tag: "message",
              author: { _tag: "operator" },
              text: input.text,
              attachments: files,
              mentions: input.mentions ?? { _tag: "bots", ids: [] },
              delivery: { _tag: "pending" },
              commandId,
            },
          });
          if (files.length > 0) {
            yield* sql`
              UPDATE attachments SET entry_id = ${entry.id}
              WHERE ${sql.in(
                "id",
                files.map((file) => file.id),
              )}
            `.pipe(Effect.orDie);
          }
          if (entry._tag !== "message") {
            return yield* Effect.die(new TurnsInvariant({ invariant: "A message was appended" }));
          }
          if (input.target._tag === "conversation") {
            yield* wakes.record([
              {
                botId: input.target.botId,
                kind: "user",
                audience: conversation,
                payload: { _tag: "message", entryId: entry.id },
                sourceEntryId: entry.id,
                hops: 0,
                retryOf: null,
                cause: { _tag: "operator" },
              },
            ]);
          } else if (room !== undefined) {
            yield* routing.operatorMessage({ room, message: entry });
          }
          return entry.id;
        }),
      });
    });

    /** A message's failed wakes that no retry has sent again yet. */
    const failedWakes = (entryId: EntryId) =>
      SqlSchema.findAll({
        Request: EntryId,
        Result: WakeRow,
        execute: (id) => sql`
          SELECT ${sql.literal(WAKE_COLUMNS)} FROM wakes w
          WHERE source_entry_id = ${id} AND status = 'failed'
            AND NOT EXISTS (SELECT 1 FROM wakes r WHERE r.retry_of = w.id)
          ORDER BY w.rowid
        `,
      })(entryId).pipe(Effect.orDie);

    const retryMessage = Effect.fn("Pipeline.retryMessage")(function* (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "message.retry",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const found = yield* entries.find(input.entryId);
          if (Option.isNone(found) || found.value.entry._tag !== "message") {
            return yield* new NotFound({ resource: "entry" });
          }
          if (found.value.entry.delivery._tag !== "failed") {
            return yield* new Conflict({ reason: "not-retryable" });
          }
          const failed = yield* failedWakes(input.entryId);
          yield* wakes.record(
            failed.map((wake) => ({
              botId: wake.bot_id,
              kind: wake.kind,
              audience: audienceOf(wake),
              payload: wake.payload_json,
              sourceEntryId: wake.source_entry_id,
              hops: wake.hops,
              retryOf: wake.id,
              cause: { _tag: "operator" },
            })),
          );
          yield* ledger.refreshMessages([input.entryId]);
        }),
      });
    });

    const retryNotice = Effect.fn("Pipeline.retryNotice")(function* (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "notice.retry",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const found = yield* entries.find(input.entryId);
          if (Option.isNone(found) || found.value.entry._tag !== "notice") {
            return yield* new NotFound({ resource: "entry" });
          }
          const notice = found.value.entry;
          const [link] = yield* SqlSchema.findAll({
            Request: EntryId,
            Result: Schema.Struct({
              dispatch_id: DispatchRowId,
              reason: Schema.Literals(["undelivered", "turn"]),
            }),
            execute: (entryId) => sql`
              SELECT dispatch_id, reason FROM notice_retries WHERE entry_id = ${entryId}
            `,
          })(notice.id).pipe(Effect.orDie);
          if (!notice.retryable || link === undefined) {
            return yield* new Conflict({ reason: "not-retryable" });
          }
          // A delivery that failed counts only while the dispatch still has
          // failed: one the engine applied after all must not go twice.
          if (link.reason === "undelivered") {
            const dispatch = yield* ledger.find(link.dispatch_id);
            if (Option.isNone(dispatch) || dispatch.value.status !== "failed") {
              return yield* new Conflict({ reason: "not-retryable" });
            }
          }
          const sent = yield* ledger.wakesOf(link.dispatch_id);
          const retried = new Set<string>();
          if (sent.length > 0) {
            const rows = yield* sql<{ readonly retry_of: string }>`
              SELECT retry_of FROM wakes
              WHERE ${sql.in(
                "retry_of",
                sent.map((wake) => wake.id),
              )}
            `.pipe(Effect.orDie);
            for (const row of rows) retried.add(row.retry_of);
          }
          // A failed wake is retried as such, so its message shows the retry;
          // one a message retry already sent again is not sent a third time.
          yield* wakes.record(
            sent
              .filter((wake) => wake.kind === "user" && !retried.has(wake.id))
              .map((wake) => ({
                botId: wake.bot_id,
                kind: wake.kind,
                audience: audienceOf(wake),
                payload: wake.payload_json,
                sourceEntryId: wake.source_entry_id,
                hops: wake.hops,
                retryOf: wake.status === "failed" ? wake.id : null,
                cause: { _tag: "operator" },
              })),
          );
          yield* ledger.refreshMessages(
            sent.flatMap((wake) => (wake.source_entry_id === null ? [] : [wake.source_entry_id])),
          );
          yield* entries.update({ ...notice, retryable: false });
        }),
      });
    });

    // ---- The dispatcher -----------------------------------------------------

    /**
     * The bot's main session, if it can be planned into: live, opened in the
     * engine, and past the deadline of a busy refusal, which its next applied
     * event ends sooner.
     */
    const mainSession = SqlSchema.findOneOption({
      Request: Schema.Struct({ botId: Schema.String, now: Schema.String }),
      Result: MainSession,
      execute: ({ botId, now }) => sql`
        SELECT id, bot_id FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
          AND lost_at IS NULL AND engine_session_id IS NOT NULL
          AND (busy_until IS NULL OR busy_until <= ${now})
      `,
    });

    /** The busy deadlines still ahead: the dispatcher looks again at the earliest. */
    const busyDeadlines = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ busy_until: Time }),
      execute: (now) => sql`
        SELECT busy_until FROM sessions
        WHERE busy_until > ${now} AND retired_at IS NULL AND lost_at IS NULL
      `,
    });

    // Rows of one table are ordered by `rowid`, the order they were written in:
    // wakes written in one transaction share their time.
    const pendingOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: WakeRow,
      execute: (botId) => sql`
        SELECT ${sql.literal(WAKE_COLUMNS)} FROM wakes
        WHERE bot_id = ${botId} AND status = 'pending'
        ORDER BY priority, rowid
      `,
    });

    /** Each bot with a pending wake, the one with the most urgent wake first. */
    const waitingBots = SqlSchema.findAll({
      Request: Schema.Void,
      Result: WaitingBot,
      execute: () => sql`
        SELECT bot_id FROM wakes WHERE status = 'pending'
        GROUP BY bot_id ORDER BY MIN(priority), MIN(rowid)
      `,
    })(undefined).pipe(Effect.orDie);

    /**
     * Sessions with work the engine may have, across every bot: what the
     * concurrency budget counts. A dispatch never sent holds no slot; it takes
     * one when it is sent.
     */
    const busySessions = sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM sessions s
      WHERE s.retired_at IS NULL AND s.lost_at IS NULL AND (
        s.admitted_turn_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.finished_at IS NULL)
        OR EXISTS (
          SELECT 1 FROM dispatches d WHERE d.session_id = s.id
            AND (d.status IN ('accepted', 'delivered') OR (d.status = 'intended' AND d.attempts > 0))
        )
      )
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.n ?? 0),
    );

    /**
     * Written and never sent, not fenced, not waiting to stage its files
     * again, and in a session no Stop holds (as the send's claim requires):
     * sent before anything new is written, whether or not its bot has a wake
     * pending.
     */
    const unsent = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: DispatchRowId, delivery: Schema.Literals(["start", "steer"]) }),
      execute: () => sql`
        SELECT id, delivery FROM dispatches d
        WHERE status = 'intended' AND attempts = 0 AND fenced_by_stop_id IS NULL
          AND next_attempt_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM stop_targets t WHERE t.session_id = d.session_id AND t.stopped_at IS NULL
          )
        ORDER BY rowid
      `,
    })(undefined).pipe(Effect.orDie);

    /** Whether the bot's provider is at its usage limit, which holds automated wakes. */
    const providerLimited = Effect.fn("Pipeline.providerLimited")(function* (botId: BotId) {
      const bot = yield* bots.find(botId);
      if (Option.isNone(bot)) return false;
      const status = yield* engineState.current;
      const provider = status.providers.find((p) => p.id === bot.value.bot.model.providerId);
      return provider?.status._tag === "limited";
    });

    /** The files a wake's message carries, as the engine's limits count them. */
    const filesOfWake = Effect.fn("Pipeline.filesOfWake")(function* (wake: WakeRow) {
      if (wake.payload_json._tag !== "message") return [];
      const found = yield* entries.find(wake.payload_json.entryId);
      return Option.isSome(found) && found.value.entry._tag === "message"
        ? found.value.entry.attachments
        : [];
    });

    /**
     * The head wake and the pending wakes of the same kind and audience after
     * it, oldest first, up to the engine's limits for one message. One answer
     * per envelope, and none in a steer; a system event is never coalesced.
     */
    const coalesce = Effect.fn("Pipeline.coalesce")(function* (
      pending: ReadonlyArray<WakeRow>,
      delivery: Plan["delivery"],
    ) {
      const [head] = pending;
      if (head === undefined) return [];
      const audience = audienceOf(head);
      const group: Array<WakeRow> = [];
      const files: Array<Attachment> = [];
      let answers = 0;
      for (const wake of pending) {
        if (wake.kind !== head.kind || !sameAudience(audienceOf(wake), audience)) continue;
        if (head.kind === "system" && group.length > 0) break;
        if (wake.payload_json._tag === "answer" && (answers > 0 || delivery._tag === "steer")) {
          continue;
        }
        const more = yield* filesOfWake(wake);
        if (group.length > 0 && attachmentLimitViolation([...files, ...more]) !== undefined) break;
        group.push(wake);
        files.push(...more);
        if (wake.payload_json._tag === "answer") answers++;
      }
      return group;
    });

    /**
     * How the bot's main session can take its head wake now: a plan, nothing
     * for now, or a session whose events are not known yet, which is looked
     * at again on a later pass.
     */
    const planFor = Effect.fn("Pipeline.planFor")(function* (
      botId: BotId,
      slots: number,
      now: DateTime.Utc,
    ) {
      const session = yield* mainSession({ botId, now: timeText(now) }).pipe(Effect.orDie);
      if (Option.isNone(session)) return null;
      const pending = yield* pendingOf(botId).pipe(Effect.orDie);
      const head = pending[0];
      if (head === undefined) return null;
      // Nothing is planned, and no slot taken, before the session's events
      // are known: what they say decides how it can take the wake.
      yield* observer.watch(session.value.id);
      if (!(yield* observer.ready(session.value.id))) return "not-ready" as const;
      const work = yield* workOf(session.value.id);
      if (work.stopUnsettled) return null;
      if ((head.kind === "routine" || head.kind === "bot") && (yield* providerLimited(botId))) {
        return null;
      }
      const audience = audienceOf(head);
      let delivery: Plan["delivery"];
      if (isIdle(work)) {
        // A pending continuation holds back every wake but the operator's.
        if (work.continuations > 0 && head.kind !== "user") return null;
        if (work.continuations === 0 && slots <= 0) return null;
        delivery = { _tag: "start" };
      } else if (
        // An answer waits for the turn that asked to finish: it starts the next.
        head.kind === "user" &&
        head.payload_json._tag !== "answer" &&
        work.admitted !== null &&
        work.unsent === 0 &&
        sameAudience(work.admitted.audience, audience)
      ) {
        delivery = { _tag: "steer", turnId: work.admitted.turnId };
      } else {
        return null;
      }
      const group = yield* coalesce(pending, delivery);
      return {
        sessionId: session.value.id,
        botId,
        wakes: group,
        audience,
        delivery,
      } satisfies Plan;
    });

    // ---- Envelopes ----------------------------------------------------------

    const zoneOf = Effect.map(settings.get, (now) =>
      Option.getOrElse(DateTime.zoneMakeNamed(now.timeZone), () =>
        DateTime.zoneMakeNamedUnsafe("UTC"),
      ),
    );

    const operatorMessageOf = Effect.fn("Pipeline.operatorMessageOf")(function* (entryId: EntryId) {
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "message") return null;
      const message: MessageEntry = found.value.entry;
      return {
        at: message.createdAt,
        text: message.text,
        attachments: message.attachments.map((file) => ({
          name: file.name,
          path: inboxPath(file),
          mediaType: file.mediaType,
        })),
      } satisfies OperatorMessage;
    });

    const askCardOf = SqlSchema.findOneOption({
      Request: EntryId,
      Result: AskCardRow,
      execute: (cardId) => sql`
        SELECT option_values_json, audience_room_id FROM ask_cards WHERE entry_id = ${cardId}
      `,
    });

    const answerOf = Effect.fn("Pipeline.answerOf")(function* (cardId: EntryId) {
      const found = yield* entries.find(cardId);
      if (Option.isNone(found) || found.value.entry._tag !== "question") return null;
      const card: QuestionEntry = found.value.entry;
      const row = yield* askCardOf(cardId).pipe(Effect.orDie);
      if (Option.isNone(row)) return null;
      const values = row.value.option_values_json;
      const roomId = row.value.audience_room_id;
      const roomName =
        roomId === null
          ? null
          : Option.match(yield* rooms.find(roomId), {
              onNone: () => null,
              onSome: (room) => room.name,
            });
      const question = card.questions[0];
      const status = card.status;
      const response: AskAnswer["response"] =
        status._tag === "answered"
          ? {
              type: "answered",
              chosen: (status.answers[question.id]?.optionIds ?? []).flatMap((optionId) => {
                const option = question.options.find((candidate) => candidate.id === optionId);
                return option === undefined
                  ? []
                  : [{ label: option.label, value: values[optionId] ?? null }];
              }),
              text: status.answers[question.id]?.text ?? null,
            }
          : { type: "dismissed" };
      return { question: question.prompt, room: roomName, response } satisfies AskAnswer;
    });

    const notesOf = (botId: BotId) =>
      SqlSchema.findAll({
        Request: Schema.String,
        Result: NoteRow,
        execute: (id) => sql`
          SELECT id, note_json FROM catch_up_notes
          WHERE bot_id = ${id} AND consumed_dispatch_id IS NULL ORDER BY rowid
        `,
      })(botId).pipe(Effect.orDie);

    const heldOf = (botId: BotId) =>
      SqlSchema.findAll({
        Request: Schema.String,
        Result: HeldRow,
        execute: (id) => sql`
          SELECT id, sender_bot_id, text, created_at FROM held_messages
          WHERE recipient_bot_id = ${id} AND consumed_dispatch_id IS NULL ORDER BY rowid
        `,
      })(botId).pipe(Effect.orDie);

    /** What the session has not seen: catch-up notes, then held teammate messages. */
    const sinceLastTurn = Effect.fn("Pipeline.sinceLastTurn")(function* (botId: BotId) {
      const items: Array<CatchUpItem> = [];
      const notes = yield* notesOf(botId);
      for (const note of notes) {
        const value = note.note_json;
        if (value === null) continue;
        items.push(
          value._tag === "routine-delivered"
            ? { type: "routine-delivered", routine: value.routine, at: value.at, text: value.text }
            : { type: "profile-changed", changes: value.changes },
        );
      }
      const held = yield* heldOf(botId);
      for (const message of held) {
        const sender = yield* bots.find(message.sender_bot_id);
        const from = Option.match(sender, {
          onNone: () => ({ id: message.sender_bot_id, name: "A former teammate", title: "" }),
          onSome: ({ bot }) => ({ id: bot.id, name: bot.profile.name, title: bot.profile.title }),
        });
        const teammate: TeammateMessage = {
          from,
          at: message.created_at,
          text: message.text,
          urgent: false,
        };
        items.push({ type: "held-message", message: teammate });
      }
      return { items, notes: notes.map((note) => note.id), held: held.map((row) => row.id) };
    });

    const wakeOf = Effect.fn("Pipeline.wakeOf")(function* (
      plan: Plan,
      since: ReadonlyArray<CatchUpItem>,
    ) {
      const base = { at: yield* DateTime.now, timeZone: yield* zoneOf, sinceLastTurn: since };
      const [head] = plan.wakes;
      if (head === undefined) {
        return yield* Effect.die(new TurnsInvariant({ invariant: "A plan carries a wake" }));
      }
      if (head.kind === "system") {
        return { ...base, kind: "system", event: { name: "undelivered" } } satisfies Wake;
      }
      if (head.kind !== "user") {
        // Room, teammate and routine envelopes come with their wakes in part 2b.
        return yield* Effect.die(
          new TurnsInvariant({ invariant: `No envelope for ${head.kind} wakes yet` }),
        );
      }
      const messages: Array<OperatorMessage> = [];
      let answer: AskAnswer | null = null;
      for (const wake of plan.wakes) {
        const payload = wake.payload_json;
        if (payload._tag === "message") {
          const message = yield* operatorMessageOf(payload.entryId);
          if (message !== null) messages.push(message);
        } else if (payload._tag === "answer") {
          answer = yield* answerOf(payload.cardId);
        }
      }
      const [first, ...rest] = messages;
      if (answer !== null) return { ...base, kind: "user", answer, messages } satisfies Wake;
      if (first === undefined) return null;
      return { ...base, kind: "user", answer: null, messages: [first, ...rest] } satisfies Wake;
    });

    /**
     * Writes the dispatch for a plan, in one transaction: its envelope, its
     * files in order, its wakes linked, and the notes and held messages the
     * envelope consumed. Nothing changes if the plan no longer holds.
     */
    const writeDispatch = Effect.fn("Pipeline.writeDispatch")(function* (plan: Plan) {
      return yield* transaction(
        Effect.gen(function* () {
          const still = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM wakes
            WHERE ${sql.in(
              "id",
              plan.wakes.map((wake) => wake.id),
            )} AND status = 'pending'
          `;
          if ((still[0]?.n ?? 0) !== plan.wakes.length) return null;
          const since = yield* sinceLastTurn(plan.botId);
          const wake = yield* wakeOf(plan, since.items);
          if (wake === null) {
            // Its message is gone: nothing to deliver.
            yield* ledger.cancelWakes(plan.wakes.map((row) => row.id));
            return null;
          }
          const envelope = yield* renderWake(wake).pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
          );
          const id = DispatchRowId.make(yield* ids.make("dispatch"));
          const at = timeText(yield* DateTime.now);
          const { audience, roomId } = audienceColumns(plan.audience);
          yield* sql`
            INSERT INTO dispatches (
              id, bot_id, session_id, audience, audience_room_id, delivery, steer_turn_id,
              envelope, status, created_at, updated_at
            ) VALUES (
              ${id}, ${plan.botId}, ${plan.sessionId}, ${audience}, ${roomId}, ${plan.delivery._tag},
              ${plan.delivery._tag === "steer" ? plan.delivery.turnId : null},
              ${envelope}, 'intended', ${at}, ${at}
            )
          `;
          let position = 0;
          for (const row of plan.wakes) {
            for (const file of yield* filesOfWake(row)) {
              yield* sql`
                INSERT INTO dispatch_attachments (dispatch_id, position, attachment_id)
                VALUES (${id}, ${position++}, ${file.id})
              `;
            }
          }
          yield* sql`
            UPDATE wakes SET status = 'dispatched', dispatch_id = ${id}, updated_at = ${at}
            WHERE ${sql.in(
              "id",
              plan.wakes.map((row) => row.id),
            )}
          `;
          if (since.notes.length > 0) {
            yield* sql`UPDATE catch_up_notes SET consumed_dispatch_id = ${id} WHERE ${sql.in("id", since.notes)}`;
          }
          if (since.held.length > 0) {
            yield* sql`UPDATE held_messages SET consumed_dispatch_id = ${id} WHERE ${sql.in("id", since.held)}`;
          }
          return id;
        }),
      ).pipe(Effect.orDie);
    });

    /**
     * A defect in planning one bot is logged and the pass goes on with the
     * others; its wakes stay pending for a later pass. A defect in a send is
     * the sender's, which gives the dispatch a later deadline.
     */
    const planOne = <A>(effect: Effect.Effect<A>, otherwise: A): Effect.Effect<A> =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.as(Effect.logError("A bot's wakes could not be planned", cause), otherwise),
        ),
      );

    /**
     * A pass of the dispatcher. A session that is not ready only defers its
     * own dispatch; only the engine refusing a command ends the pass.
     */
    /** Whether a send may have put a turn's worth of work in the engine: it holds a slot. */
    const holdsSlot = (result: SendResult) => result !== "skipped" && result !== "none";

    const dispatchPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        const { budgets } = yield* settings.get;
        let slots = budgets.concurrentTurns - (yield* busySessions);
        // A dispatch written before a crash, or while the engine was down,
        // goes first: a start takes a slot when it is sent, like a new one.
        for (const { id, delivery } of yield* unsent) {
          if (delivery === "start" && slots <= 0) continue;
          const result = yield* sender.send(id);
          if (result === "engine-unavailable") return { _tag: "unavailable" } as const;
          if (result === "skipped") outcome.defer();
          if (delivery === "start" && holdsSlot(result)) slots--;
        }
        for (const { bot_id: botId } of yield* waitingBots) {
          const planned = yield* planOne(
            Effect.gen(function* () {
              const plan = yield* planFor(botId, slots, now);
              if (plan === null || plan === "not-ready") return plan;
              const dispatchId = yield* writeDispatch(plan);
              return dispatchId === null ? null : { plan, dispatchId };
            }),
            null,
          );
          if (planned === "not-ready") outcome.defer();
          if (planned === null || planned === "not-ready") continue;
          const result = yield* sender.send(planned.dispatchId);
          if (result === "engine-unavailable") return { _tag: "unavailable" } as const;
          if (result === "skipped") outcome.defer();
          if (planned.plan.delivery._tag === "start" && holdsSlot(result)) slots--;
        }
        // A session refused as busy is looked at again once its deadline passes.
        for (const row of yield* busyDeadlines(timeText(now)).pipe(Effect.orDie)) {
          outcome.until(row.busy_until);
        }
        return outcome.done();
      }).pipe(Effect.withSpan("Pipeline.dispatchPending")),
    );

    const dispatchPending = Effect.asVoid(dispatchPass);

    // ---- Recovery -------------------------------------------------------------

    /**
     * What the recovery owns: every undecided dispatch the engine may have
     * (sent at least once, fenced or not: a fenced one settles here, with the
     * same backoff), and one whose files wait to be staged again in a session
     * no Stop holds.
     */
    const dueRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: DispatchRowId, next_attempt_at: Schema.NullOr(Time) }),
      execute: () => sql`
        SELECT id, next_attempt_at FROM dispatches d
        WHERE status = 'intended' AND (
          attempts > 0
          OR (
            next_attempt_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM stop_targets t
              WHERE t.session_id = d.session_id AND t.stopped_at IS NULL
            )
          )
        )
        ORDER BY rowid
      `,
    })(undefined).pipe(Effect.orDie);

    /** A pass of the recovery over what is due, which learns the next deadline. */
    const recoveryPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = passOutcome();
        for (const row of yield* dueRows) {
          if (row.next_attempt_at !== null && DateTime.isGreaterThan(row.next_attempt_at, now)) {
            continue;
          }
          const result = yield* sender.send(row.id);
          if (result === "engine-unavailable") return { _tag: "unavailable" } as const;
          if (result === "skipped") outcome.defer();
        }
        // The deadlines as the sends left them.
        for (const row of yield* dueRows) outcome.until(row.next_attempt_at);
        return outcome.done();
      }).pipe(Effect.withSpan("Pipeline.recoverDue")),
    );

    const recoverDue = Effect.asVoid(recoveryPass);

    // Both wait for the startup or reconnect sequence (`Turns.ts`) to release
    // them, and park after the engine refuses until it is ready again.
    const run = Effect.all(
      [
        reconcile({
          name: "The dispatcher",
          pass: dispatchPass,
          signal: signals.dispatch,
          readiness,
        }),
        reconcile({
          name: "The recovery",
          pass: recoveryPass,
          signal: signals.recovery,
          readiness,
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.andThen(Effect.never));

    return Pipeline.of({
      sendMessage,
      retryMessage,
      retryNotice,
      dispatchPending,
      recoverDue,
      run,
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
