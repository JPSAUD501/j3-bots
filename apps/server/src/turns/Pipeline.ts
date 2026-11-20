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
import {
  attachmentLimitViolation,
  ENGINE_INPUT_LIMIT,
  engineInputLength,
  type TurnId,
} from "@j3-bots/engine-t3";
import type {
  AskAnswer,
  CatchUpItem,
  OperatorMessage,
  TeammateMessage,
  Wake,
} from "@j3-bots/prompts";
import { renderWake, renderWakeForSize } from "@j3-bots/prompts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { admission } from "./admission.ts";
import { Ledger, UNDELIVERED, WAKE_COLUMNS, WakeRow } from "./Ledger.ts";
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
import { inboxPath, Sender, type SendOwner, type SendResult } from "./Sender.ts";
import { isIdle, sessionWork } from "./sessionWork.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { DEFECT_RETRY, type Pass, onePassAtATime, passOutcome, reconcile } from "./reconciler.ts";
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

/** What names a dispatch row, read before the rest of it so a broken one can be postponed. */
const Named = Schema.Struct({ id: DispatchRowId });
const Unsent = Schema.Struct({
  id: DispatchRowId,
  session_id: SessionRowId,
  delivery: Schema.Literals(["start", "steer"]),
  next_attempt_at: Schema.NullOr(Time),
});
const Due = Schema.Struct({ id: DispatchRowId, next_attempt_at: Schema.NullOr(Time) });

const NoteRow = Schema.Struct({ id: Schema.String, note_json: Schema.NullOr(json(CatchUpNote)) });
const HeldRow = Schema.Struct({
  id: Schema.String,
  sender_bot_id: BotId,
  text: Schema.String,
  created_at: Time,
});

/**
 * Room `message.send` leaves under the engine's input limit when it checks a
 * message alone: what can render longer when the message is dispatched later.
 * The wake's zone (an IANA name, at most about 30 characters), its weekday,
 * and the message's time, which gains its date once the day has changed, take
 * well under this.
 */
const DISPATCH_VARIANCE = 1_000;

/** Whether an envelope renders within the engine's input limit, less `reserve`. */
const fitsEngine = (wake: Wake, reserve = 0): boolean =>
  engineInputLength(renderWakeForSize(wake)) <= ENGINE_INPUT_LIMIT - reserve;

/**
 * The largest count in `[1, max]` for which `fits` holds, given that it holds
 * for 1 and, once it fails, fails for every larger count.
 */
const longestFitting = (max: number, fits: (count: number) => boolean): number => {
  let low = 1;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
};

/** A planned wake's part of a user envelope; `null` when its message or card is gone. */
type WakePart =
  | { readonly _tag: "message"; readonly message: OperatorMessage }
  | { readonly _tag: "answer"; readonly answer: AskAnswer }
  | null;

/** Something the session has not seen, with the row the dispatch consumes for it. */
interface Unseen {
  readonly item: CatchUpItem | null;
  readonly source: { readonly _tag: "note" | "held"; readonly id: string };
}

/** A user envelope from its parts; `null` when none of them is left to deliver. */
const userWake = (
  base: { readonly at: DateTime.Utc; readonly timeZone: DateTime.TimeZone.Named },
  since: ReadonlyArray<CatchUpItem>,
  parts: ReadonlyArray<WakePart>,
): Wake | null => {
  const messages: Array<OperatorMessage> = [];
  let answer: AskAnswer | null = null;
  for (const part of parts) {
    if (part?._tag === "message") messages.push(part.message);
    else if (part?._tag === "answer") answer = part.answer;
  }
  const wake = { ...base, sinceLastTurn: since, kind: "user" } as const;
  const [first, ...rest] = messages;
  if (answer !== null) return { ...wake, answer, messages } satisfies Wake;
  if (first === undefined) return null;
  return { ...wake, answer: null, messages: [first, ...rest] } satisfies Wake;
};

/** An operator's message as an envelope shows it. */
const operatorMessage = (
  at: DateTime.Utc,
  text: string,
  files: ReadonlyArray<Attachment>,
): OperatorMessage => ({
  at,
  text,
  attachments: files.map((file) => ({
    name: file.name,
    path: inboxPath(file),
    mediaType: file.mediaType,
  })),
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
    /** The dispatcher, for as long as the scope lives. */
    readonly runDispatcher: Effect.Effect<never>;
    /** The recovery, for as long as the scope lives. */
    readonly runRecovery: Effect.Effect<never>;
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
    const { admitsStart } = admission(sql, settings);

    /** The operator's zone, in which an envelope gives every time. */
    const zoneOf = Effect.map(settings.get, (now) =>
      Option.getOrElse(DateTime.zoneMakeNamed(now.timeZone), () =>
        DateTime.zoneMakeNamedUnsafe("UTC"),
      ),
    );

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
          // A message is dispatched in one envelope at the least: it must fit
          // the engine's input limit alone, as it renders now, with room for
          // what renders longer later.
          const at = yield* DateTime.now;
          const alone = userWake(
            { at, timeZone: yield* zoneOf },
            [],
            [{ _tag: "message", message: operatorMessage(at, input.text, files) }],
          );
          if (alone !== null && !fitsEngine(alone, DISPATCH_VARIANCE)) {
            return yield* new Invalid({ reason: "message-length" });
          }
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

    /**
     * A message's failed wakes that no retry has sent again yet, and that the
     * engine certainly does not have, as its delivery counts them.
     */
    const failedWakes = (entryId: EntryId) =>
      SqlSchema.findAll({
        Request: EntryId,
        Result: WakeRow,
        execute: (id) => sql`
          SELECT ${sql.literal(WAKE_COLUMNS)} FROM wakes w
          WHERE source_entry_id = ${id} AND status = 'failed'
            AND EXISTS (
              SELECT 1 FROM dispatches d
              WHERE d.id = w.dispatch_id AND ${sql.in("d.status", UNDELIVERED)}
            )
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
          // A delivery that failed counts only while it still did not reach
          // the bot: what the engine accepted or delivered late must not go twice.
          if (
            link.reason === "undelivered" &&
            !(yield* ledger.undeliveredRetryable(link.dispatch_id))
          ) {
            return yield* new Conflict({ reason: "not-retryable" });
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
     * The rows a pass reads, each decoded on its own: one that cannot be read
     * is postponed, so only it waits, and the pass goes on with the others.
     */
    const readEach = Effect.fn("Pipeline.readEach")(function* <A>(
      rows: ReadonlyArray<unknown>,
      schema: Schema.Decoder<A>,
    ) {
      const read: Array<A> = [];
      for (const raw of rows) {
        const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(schema)(raw));
        if (Exit.isSuccess(decoded)) {
          read.push(decoded.value);
          continue;
        }
        yield* Effect.logError(
          "A dispatch could not be read; it is tried again later",
          decoded.cause,
        );
        const named = Schema.decodeUnknownOption(Named)(raw);
        if (Option.isSome(named)) yield* sender.postpone(named.value.id);
      }
      return read;
    });

    /**
     * Written and never sent, not fenced, and in a session no Stop holds (as
     * the send's claim requires): sent before anything new is written, whether
     * or not its bot has a wake pending. One whose files failed to stage waits
     * for its deadline. Every first send is the dispatcher's, under the
     * budget.
     */
    const unsentRows = sql`
      SELECT id, session_id, delivery, next_attempt_at FROM dispatches d
      WHERE status = 'intended' AND attempts = 0 AND fenced_by_stop_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM stop_targets t WHERE t.session_id = d.session_id AND t.stopped_at IS NULL
        )
      ORDER BY rowid
    `.pipe(Effect.orDie);
    const unsent = Effect.flatMap(unsentRows, (rows) => readEach(rows, Unsent));

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
    const planFor = Effect.fn("Pipeline.planFor")(function* (botId: BotId, now: DateTime.Utc) {
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
        if (!(yield* admitsStart(session.value.id))) return null;
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

    const operatorMessageOf = Effect.fn("Pipeline.operatorMessageOf")(function* (entryId: EntryId) {
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "message") return null;
      const message: MessageEntry = found.value.entry;
      return operatorMessage(message.createdAt, message.text, message.attachments);
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

    /** What the session has not seen, oldest first: catch-up notes, then held teammate messages. */
    const sinceLastTurn = Effect.fn("Pipeline.sinceLastTurn")(function* (botId: BotId) {
      const unseen: Array<Unseen> = [];
      for (const note of yield* notesOf(botId)) {
        const value = note.note_json;
        unseen.push({
          item:
            value === null
              ? null
              : value._tag === "routine-delivered"
                ? {
                    type: "routine-delivered",
                    routine: value.routine,
                    at: value.at,
                    text: value.text,
                  }
                : { type: "profile-changed", changes: value.changes },
          source: { _tag: "note", id: note.id },
        });
      }
      for (const message of yield* heldOf(botId)) {
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
        unseen.push({
          item: { type: "held-message", message: teammate },
          source: { _tag: "held", id: message.id },
        });
      }
      return unseen;
    });

    const partOf = Effect.fn("Pipeline.partOf")(function* (wake: WakeRow) {
      const payload = wake.payload_json;
      if (payload._tag === "message") {
        const message = yield* operatorMessageOf(payload.entryId);
        return message === null ? null : ({ _tag: "message", message } satisfies WakePart);
      }
      if (payload._tag === "answer") {
        const answer = yield* answerOf(payload.cardId);
        return answer === null ? null : ({ _tag: "answer", answer } satisfies WakePart);
      }
      return null;
    });

    /**
     * The envelope for a plan, within the engine's input limit: the head wake,
     * then as much of what the session has not seen as fits, oldest first,
     * then as many of the plan's other wakes as fit, in order. What is left
     * out stays for a later dispatch, in the same order. The head goes
     * whatever its size: `message.send` refuses a message that would not fit
     * alone, and an answer or a system event is far below the limit.
     */
    const envelopeOf = Effect.fn("Pipeline.envelopeOf")(function* (
      plan: Plan,
      unseen: ReadonlyArray<Unseen>,
    ) {
      const base = { at: yield* DateTime.now, timeZone: yield* zoneOf };
      const [head] = plan.wakes;
      if (head === undefined) {
        return yield* Effect.die(new TurnsInvariant({ invariant: "A plan carries a wake" }));
      }
      if (head.kind !== "system" && head.kind !== "user") {
        // Room, teammate and routine envelopes come with their wakes in part 2b.
        return yield* Effect.die(
          new TurnsInvariant({ invariant: `No envelope for ${head.kind} wakes yet` }),
        );
      }
      const parts = head.kind === "user" ? yield* Effect.forEach(plan.wakes, partOf) : [];
      const render = (wakes: number, seen: number): Wake | null => {
        const since = unseen.slice(0, seen).flatMap(({ item }) => (item === null ? [] : [item]));
        return head.kind === "system"
          ? { ...base, sinceLastTurn: since, kind: "system", event: { name: "undelivered" } }
          : userWake(base, since, parts.slice(0, wakes));
      };
      // Nothing left to render takes no room.
      const fits = (wake: Wake | null) => wake === null || fitsEngine(wake);
      // A system event is never coalesced.
      const most = head.kind === "system" ? 1 : plan.wakes.length;
      const seen =
        unseen.length > 0 && fits(render(1, 1))
          ? longestFitting(unseen.length, (count) => fits(render(1, count)))
          : 0;
      const wakes = longestFitting(most, (count) => fits(render(count, seen)));
      return {
        wake: render(wakes, seen),
        wakes: plan.wakes.slice(0, wakes),
        consumed: unseen.slice(0, seen).map(({ source }) => source),
      };
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
          const fitted = yield* envelopeOf(plan, yield* sinceLastTurn(plan.botId));
          const { wake } = fitted;
          if (wake === null) {
            // Their messages are gone: nothing to deliver.
            yield* ledger.cancelWakes(fitted.wakes.map((row) => row.id));
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
          for (const row of fitted.wakes) {
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
              fitted.wakes.map((row) => row.id),
            )}
          `;
          const notes = fitted.consumed.flatMap((row) => (row._tag === "note" ? [row.id] : []));
          const held = fitted.consumed.flatMap((row) => (row._tag === "held" ? [row.id] : []));
          if (notes.length > 0) {
            yield* sql`UPDATE catch_up_notes SET consumed_dispatch_id = ${id} WHERE ${sql.in("id", notes)}`;
          }
          if (held.length > 0) {
            yield* sql`UPDATE held_messages SET consumed_dispatch_id = ${id} WHERE ${sql.in("id", held)}`;
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
     * One send of a pass, for the worker that owns it. The sender counts its
     * own defects against the dispatch, or defers it; one it could not even
     * defer is logged here, and the pass goes on with the others and looks
     * again later.
     */
    const sendOne = (
      dispatchId: DispatchRowId,
      owner: SendOwner,
      outcome: ReturnType<typeof passOutcome>,
    ) =>
      sender.send(dispatchId, owner).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("A dispatch could not be sent; it is tried again later", cause).pipe(
              Effect.andThen(DateTime.now),
              Effect.map((now): SendResult => {
                outcome.until(DateTime.addDuration(now, DEFECT_RETRY));
                return "none";
              }),
            ),
        ),
      );

    /**
     * A pass of the dispatcher, which makes every first send. A session that
     * is not ready only defers its own dispatch; only the engine refusing a
     * command ends the pass. The free slots are read again before each send:
     * what holds one is what the engine may have, never what a send returned.
     */
    const dispatchPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        // A dispatch written before a crash, while the engine was down, or
        // whose files failed to stage goes first: a start is admitted when it
        // is sent, like a new one.
        for (const row of yield* unsent) {
          if (row.next_attempt_at !== null && DateTime.isGreaterThan(row.next_attempt_at, now)) {
            continue;
          }
          if (row.delivery === "start" && !(yield* admitsStart(row.session_id))) continue;
          const result = yield* sendOne(row.id, "dispatcher", outcome);
          if (result === "engine-unavailable") return { _tag: "unavailable" } as const;
          if (result === "skipped") outcome.defer();
        }
        for (const { bot_id: botId } of yield* waitingBots) {
          const planned = yield* planOne(
            Effect.gen(function* () {
              const plan = yield* planFor(botId, now);
              if (plan === null || plan === "not-ready") return plan;
              const dispatchId = yield* writeDispatch(plan);
              return dispatchId === null ? null : { plan, dispatchId };
            }),
            null,
          );
          if (planned === "not-ready") outcome.defer();
          if (planned === null || planned === "not-ready") continue;
          const result = yield* sendOne(planned.dispatchId, "dispatcher", outcome);
          if (result === "engine-unavailable") return { _tag: "unavailable" } as const;
          if (result === "skipped") outcome.defer();
        }
        // A session refused as busy is looked at again once its deadline
        // passes, and so is a dispatch whose files failed to stage.
        for (const row of yield* busyDeadlines(timeText(now)).pipe(Effect.orDie)) {
          outcome.until(row.busy_until);
        }
        // One left for a free slot goes when a slot frees, which nudges the
        // dispatcher; only a deadline still ahead is waited for.
        const later = yield* DateTime.now;
        for (const row of yield* unsent) {
          if (row.next_attempt_at !== null && DateTime.isGreaterThan(row.next_attempt_at, later)) {
            outcome.until(row.next_attempt_at);
          }
        }
        return outcome.done();
      }).pipe(Effect.withSpan("Pipeline.dispatchPending")),
    );

    const dispatchPending = Effect.asVoid(dispatchPass);

    // ---- Recovery -------------------------------------------------------------

    /**
     * What the recovery owns: every claimed send, an undecided dispatch the
     * engine may have (sent at least once, fenced or not: a fenced one settles
     * here, with the same backoff). A dispatch never sent is the dispatcher's.
     */
    const dueRows = sql`
      SELECT id, next_attempt_at FROM dispatches
      WHERE status = 'intended' AND attempts > 0
      ORDER BY rowid
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => readEach(rows, Due)),
    );

    /** A pass of the recovery over what is due, which learns the next deadline. */
    const recoveryPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = passOutcome();
        for (const row of yield* dueRows) {
          if (row.next_attempt_at !== null && DateTime.isGreaterThan(row.next_attempt_at, now)) {
            continue;
          }
          const result = yield* sendOne(row.id, "recovery", outcome);
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
    const runDispatcher = reconcile({
      name: "The dispatcher",
      pass: dispatchPass,
      signal: signals.dispatch,
      readiness,
    });
    const runRecovery = reconcile({
      name: "The recovery",
      pass: recoveryPass,
      signal: signals.recovery,
      readiness,
    });

    return Pipeline.of({
      sendMessage,
      retryMessage,
      retryNotice,
      dispatchPending,
      recoverDue,
      runDispatcher,
      runRecovery,
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
