// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  type AttachmentId,
  attachmentOffsetsFit,
  BotId,
  type CommandId,
  Conflict,
  EntryId,
  type EntryTarget,
  Invalid,
  type Mentions,
  type MessageEntry,
  NotFound,
  ProviderId,
  type QuestionEntry,
  RoomId,
} from "@j3-bots/contracts";
import { attachmentLimitViolation, type TurnId } from "@j3-bots/engine-t3";
import type {
  AskAnswer,
  CatchUpItem,
  OperatorMessage,
  RoomEntry,
  RoomWake,
  SystemEvent,
  TeammateMessage,
  TeammateRef,
  Wake,
} from "@j3-bots/prompts";
import { renderWake, ROOM_CLOSING_LINES } from "@j3-bots/prompts";
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
import { EngineState, providerReady } from "../engine/EngineState.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { type LiveRoom, liveRoom } from "../rooms/liveRoom.ts";
import { RoomRouting } from "../rooms/RoomRouting.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { admission } from "./admission.ts";
import {
  askAnswer,
  fitsAlone,
  fitsEngine,
  operatorMessage,
  operatorZone,
  roomName,
  widestRoomHeader,
  widestTeammate,
} from "./envelopes.ts";
import { Ledger, UNDELIVERED, WAKE_COLUMNS, WakeRow } from "./Ledger.ts";
import {
  type Audience,
  audienceColumns,
  audienceOf,
  CatchUpNote,
  conversation,
  DispatchRowId,
  PRIORITY,
  RoomReason,
  sameAudience,
  SessionRowId,
  TurnsInvariant,
  type WakePayload,
} from "./model.ts";
import { modeRefusedSql } from "./modeRefusals.ts";
import { Sender, type SendOwner, type SendResult } from "./Sender.ts";
import { notices } from "./notices.ts";
import { behindOpeningSql, openingUnsentSql } from "./openings.ts";
import { isIdle, sessionWork } from "./sessionWork.ts";
import { Observer } from "./Observer.ts";
import { automatedSql, providerLimit } from "./providerLimit.ts";
import { Readiness } from "./Readiness.ts";
import { roomLiveSql } from "./roomLive.ts";
import { DEFECT_RETRY, type Pass, onePassAtATime, passOutcome, reconcile } from "./reconciler.ts";
import { takesNewWorkSql } from "./rotationRequests.ts";
import { Signals } from "./Signals.ts";
import { stopHoldsSql } from "./stopTargets.ts";
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
  /** It carries a routine's wake, the least urgent kind, in a side session. */
  routine: Schema.BooleanFromBit,
  /** It is automated work, which a usage limit holds (`automatedSql`). */
  automated: Schema.BooleanFromBit,
  /** It is addressed to a room. */
  room: Schema.BooleanFromBit,
  /** The provider its session runs on. */
  provider_id: ProviderId,
  /** The bot whose opening the dispatch carries, if it carries one. */
  opening_bot_id: Schema.NullOr(BotId),
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

/**
 * The most unseen room entries an envelope is built from: a member back after
 * a long absence is shown the newest, and told how many earlier ones it missed.
 */
const ROOM_ENTRIES_READ = 200;

/** The reason whose closing line is the longest, for a check of what a room envelope can take. */
const LONGEST_ROOM_REASON: RoomReason = RoomReason.literals.reduce((longest, reason) =>
  ROOM_CLOSING_LINES[reason].length > ROOM_CLOSING_LINES[longest].length ? reason : longest,
);

/** Why a bot is woken for a room, of several coalesced wakes: hosting asks the most of it. */
const strongestReason = (reasons: ReadonlyArray<RoomReason>): RoomReason =>
  reasons.includes("host") ? "host" : reasons.includes("mentioned") ? "mentioned" : "everyone";

/** The room's queue as planning reads it. */
const RoomQueue = Schema.Struct({
  /** The bot is a member of the room. */
  member: Schema.BooleanFromBit,
  /** A dispatch or turn of the room is live: it runs one turn at a time. */
  busy: Schema.BooleanFromBit,
  /** The bot whose wake for the room goes first, by priority, then as written. */
  next_bot_id: Schema.NullOr(BotId),
});

/** A planned wake's part of a user or bot envelope; `null` when its message or card is gone. */
type WakePart =
  | { readonly _tag: "message"; readonly message: OperatorMessage }
  | { readonly _tag: "answer"; readonly answer: AskAnswer }
  | { readonly _tag: "teammate"; readonly message: TeammateMessage }
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

/** A bot envelope of the teammates' messages; `null` when none of them is left to deliver. */
const botWake = (
  base: { readonly at: DateTime.Utc; readonly timeZone: DateTime.TimeZone.Named },
  since: ReadonlyArray<CatchUpItem>,
  parts: ReadonlyArray<WakePart>,
): Wake | null => {
  const [first, ...rest] = parts.flatMap((part) =>
    part?._tag === "teammate" ? [part.message] : [],
  );
  if (first === undefined) return null;
  return { ...base, sinceLastTurn: since, kind: "bot", messages: [first, ...rest] };
};

/**
 * The event a system wake reports, `askName` saying whether an opening asks
 * the operator's name; any other payload on one is a bug.
 */
const systemEventOf = (payload: WakePayload, askName: boolean): Effect.Effect<SystemEvent> => {
  switch (payload._tag) {
    case "first-run":
      return Effect.succeed({ name: "first-run", askName });
    case "undelivered":
      return Effect.succeed({ name: "undelivered" });
    case "message":
    case "answer":
    case "routine":
    case "teammate":
    case "room":
      return Effect.die(
        new TurnsInvariant({ invariant: `A system wake carries no ${payload._tag} payload` }),
      );
  }
};

/** A catch-up note as an envelope shows it. */
const catchUpItem = (note: CatchUpNote): CatchUpItem => {
  switch (note._tag) {
    case "routine-delivered":
      return { type: "routine-delivered", routine: note.routine, at: note.at, text: note.text };
    case "profile-changed":
      return { type: "profile-changed", changes: note.changes };
    case "session-rotated":
      return { type: "session-rotated", digest: note.digest };
  }
};

/** What a pass of the dispatcher collects: work it left, and its earliest deadline. */
type Outcome = ReturnType<typeof passOutcome>;

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
      /** Where the operator placed each file in `text`; left out, they follow it. */
      readonly attachmentOffsets?: ReadonlyArray<number>;
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
    const limitOf = providerLimit(sql, engineState);
    const { notify, openingOvertaken, closeOpeningRetries } = notices(sql, entries);

    const zoneOf = operatorZone(settings);
    const roomOf = liveRoom(sql);

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

    /**
     * The hello waits for a provider that can run it rather than fail before
     * it starts: nobody asked for it, so nobody waits on it either. It is held
     * while the engine does not report the bot's provider ready: signed out,
     * at its limit, unavailable, or not reported at all, as while the engine
     * is down or right after it started. Written or not, it is sent once the
     * provider is ready, which wakes the dispatcher; the send's claim checks
     * again (`Sender`).
     */
    const openingHeld = Effect.fn("Pipeline.openingHeld")(function* (botId: BotId) {
      const bot = yield* bots.find(botId);
      if (Option.isNone(bot)) return false;
      return !providerReady(yield* engineState.current, bot.value.bot.model.providerId);
    });

    const OpeningState = Schema.Struct({
      id: Schema.String,
      unsent: Schema.BooleanFromBit,
      holds: Schema.BooleanFromBit,
    });

    /**
     * The bot's opening that has not ended, if it has one: whether the engine
     * does not have it yet (`openingUnsentSql`), and whether an operator's
     * message waits behind it already.
     */
    const openingState = SqlSchema.findOneOption({
      Request: BotId,
      Result: OpeningState,
      execute: (botId) => sql`
        SELECT o.id,
          ${openingUnsentSql(sql, { wakeId: sql.literal("o.id") })} AS unsent,
          EXISTS (SELECT 1 FROM wakes h WHERE h.behind_opening_id = o.id) AS holds
        FROM wakes o
        WHERE o.bot_id = ${botId} AND json_extract(o.payload_json, '$._tag') = 'first-run'
          AND o.status IN ('pending', 'dispatched')
        ORDER BY o.rowid DESC LIMIT 1
      `,
    });

    /**
     * The opening an operator's message written now waits behind, if any:
     * one the engine does not have yet while its provider is not ready
     * (`openingHeld`), and one that holds a message already, until it ends,
     * so the messages keep their order whatever the provider does meanwhile.
     */
    const openingToWaitBehind = Effect.fn("Pipeline.openingToWaitBehind")(function* (botId: BotId) {
      const opening = yield* openingState(botId).pipe(Effect.orDie);
      if (Option.isNone(opening)) return null;
      const { id, unsent, holds } = opening.value;
      return holds || (unsent && (yield* openingHeld(botId))) ? { id, unsent } : null;
    });

    /**
     * The operator wrote in the bot's conversation: a hello the bot has not
     * sent yet would open a conversation already open, under an envelope
     * saying they have not written. Its `first-run` wake is cancelled while
     * it waits, and also once written into a dispatch the engine certainly
     * does not have (never sent; the send's claim needs it still `intended`
     * with no attempt). One the engine may have runs, and the base prompt has
     * the bot answer the operator's message instead of greeting. A failed
     * opening is no longer offered again either.
     */
    const withdrawOpening = Effect.fn("Pipeline.withdrawOpening")(function* (botId: BotId) {
      const unsent = yield* SqlSchema.findAll({
        Request: BotId,
        Result: Named,
        execute: (id) => sql`
          SELECT DISTINCT d.id FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
          WHERE w.bot_id = ${id} AND json_extract(w.payload_json, '$._tag') = 'first-run'
            AND d.status = 'intended' AND d.attempts = 0
        `,
      })(botId);
      for (const dispatch of unsent) yield* ledger.release(dispatch.id, { _tag: "cancelled" });
      const pending = yield* sql<{ readonly id: string }>`
        SELECT id FROM wakes
        WHERE bot_id = ${botId} AND status = 'pending'
          AND json_extract(payload_json, '$._tag') = 'first-run'
      `;
      yield* ledger.cancelWakes(pending.map((row) => row.id));
      yield* closeOpeningRetries(botId);
    }, Effect.orDie);

    const sendMessage = Effect.fn("Pipeline.sendMessage")(function* (input: {
      readonly commandId: CommandId;
      readonly target: EntryTarget;
      readonly text: string;
      readonly attachments: ReadonlyArray<AttachmentId>;
      readonly attachmentOffsets?: ReadonlyArray<number>;
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
          const offsets = input.attachmentOffsets;
          if (offsets !== undefined && !attachmentOffsetsFit(input.text, files.length, offsets)) {
            return yield* new Invalid({ reason: "attachment" });
          }
          // A message without files places none.
          const placed = offsets !== undefined && files.length > 0 ? offsets : undefined;
          // A message is dispatched in one envelope at the least: it must fit
          // the engine's input limit alone, as it renders now, with room for
          // what renders longer later. A room's message is checked in the
          // room at its widest, which it may be by then.
          const at = yield* DateTime.now;
          const base = { at, timeZone: yield* zoneOf };
          const message = operatorMessage(at, input.text, files, placed);
          const alone: Wake | null =
            room === undefined
              ? userWake(base, [], [{ _tag: "message", message }])
              : {
                  ...base,
                  sinceLastTurn: [],
                  kind: "room",
                  room: widestRoomHeader(room.id),
                  // As long as it can render: the longest closing line,
                  // and a line counting entries left out.
                  reason: LONGEST_ROOM_REASON,
                  omitted: Number.MAX_SAFE_INTEGER,
                  entries: [
                    {
                      author: "user",
                      at,
                      text: input.text,
                      mentions:
                        input.mentions?._tag === "everyone"
                          ? "everyone"
                          : (input.mentions?.ids ?? []).map((id) => widestTeammate(id).name),
                      attachments: message.attachments,
                    },
                  ],
                };
          if (alone !== null && !fitsAlone(alone)) {
            return yield* new Invalid({ reason: "message-length" });
          }
          // Decided in this transaction with the wake it writes: nothing the
          // dispatcher does meanwhile can take the opening from under it.
          const behind =
            input.target._tag === "conversation"
              ? yield* openingToWaitBehind(input.target.botId)
              : null;
          const entry = yield* entries.append({
            target: input.target,
            commandId,
            entry: {
              _tag: "message",
              author: { _tag: "operator" },
              text: input.text,
              attachments: files,
              ...(placed === undefined ? {} : { attachmentOffsets: placed }),
              mentions: input.mentions ?? { _tag: "bots", ids: [] },
              delivery:
                behind?.unsent === true
                  ? { _tag: "pending", behindOpening: true }
                  : { _tag: "pending" },
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
                ...(behind === null ? {} : { behindOpening: behind.id }),
              },
            ]);
            if (behind === null) {
              // The operator spoke first: there is no conversation left to open.
              yield* withdrawOpening(input.target.botId);
            } else {
              // The hello waits for its provider: the message waits behind
              // it, and goes once it has ended. Its retry is offered no more.
              yield* closeOpeningRetries(input.target.botId);
            }
          } else if (room !== undefined) {
            yield* routing.operatorMessage({ room, message: entry });
          }
          return entry.id;
        }),
      });
    });

    /**
     * A message's failed wakes that no retry has sent again yet, and that the
     * engine certainly does not have, as its delivery counts them: a wake of
     * a member that has left the room since is counted no more.
     */
    const failedWakes = (entryId: EntryId) =>
      SqlSchema.findAll({
        Request: EntryId,
        Result: WakeRow,
        execute: (id) => sql`
          SELECT ${sql.literal(WAKE_COLUMNS)} FROM wakes w
          WHERE source_entry_id = ${id} AND status = 'failed' AND recipient_left = 0
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
          // A failed wake survives its room's archival, but goes again only
          // into a room that takes messages.
          const { target } = found.value;
          if (target._tag === "room" && Option.isNone(yield* roomOf(target.roomId))) {
            return yield* new Conflict({ reason: "room-archived" });
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
          // An opening the operator has overtaken goes no more, also from a
          // notice a client still shows as retryable.
          if (
            !notice.retryable ||
            link === undefined ||
            (yield* openingOvertaken(link.dispatch_id))
          ) {
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
          // A teammate's message that reached the bot otherwise, by its
          // original wake landing late, say, does not go again.
          for (const id of yield* ledger.readHandoffWakes(link.dispatch_id)) retried.add(id);
          // A failed wake is retried as such, so its message shows the retry;
          // one a message retry already sent again is not sent a third time.
          // A failed opening, a teammate's urgent message, or a member's room
          // turn, is the operator's to retry too: none has a message of
          // theirs. A teammate's message goes again only while it failed:
          // one a Stop cancelled stays cancelled. It goes as it was, its kind
          // and hops kept; the Retry is the operator's, so no Stop of its
          // sender cancels it (`Stops.record`).
          const again = sent.filter(
            (wake) =>
              (wake.kind === "user" ||
                wake.kind === "room" ||
                wake.payload_json._tag === "first-run" ||
                (wake.payload_json._tag === "teammate" && wake.status === "failed")) &&
              !retried.has(wake.id),
          );
          // A room's wakes go again only into a room that takes messages, and
          // only to a member: one who left has nothing there to retry.
          for (const wake of again) {
            if (wake.audience !== "room") continue;
            const room =
              wake.audience_room_id === null ? Option.none() : yield* roomOf(wake.audience_room_id);
            if (Option.isNone(room)) return yield* new Conflict({ reason: "room-archived" });
            if (!room.value.members.includes(wake.bot_id)) {
              return yield* new Conflict({ reason: "not-retryable" });
            }
          }
          yield* wakes.record(
            again.map((wake) => ({
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
     * engine, running its bot's settings (`EngineSessions`), whose permission
     * mode the engine has not refused (`modeRefusedSql`), taking new work
     * (`takesNewWorkSql`), and past the deadline of a busy refusal, which its
     * next applied event ends sooner. A session due for any rotation but the
     * run limit's takes nothing new: its bot's wakes wait for the session that
     * replaces it. One not aligned yet takes nothing until it is, and one
     * whose bot's mode the engine refused nothing until the bot's settings
     * change or the engine is ready again, either of which nudges the
     * dispatcher.
     */
    const mainSession = SqlSchema.findOneOption({
      Request: Schema.Struct({ botId: Schema.String, now: Schema.String }),
      Result: MainSession,
      execute: ({ botId, now }) => sql`
        SELECT id, bot_id FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
          AND lost_at IS NULL AND engine_session_id IS NOT NULL AND settings_pending = 0
          AND NOT ${modeRefusedSql(sql, sql`sessions.bot_id`)}
          AND ${takesNewWorkSql(sql)} AND (busy_until IS NULL OR busy_until <= ${now})
      `,
    });

    /** A planned session, if it still takes new work where the dispatch is written. */
    const plannedSession = SqlSchema.findOneOption({
      Request: SessionRowId,
      Result: Schema.Struct({ id: SessionRowId }),
      execute: (id) => sql`
        SELECT id FROM sessions
        WHERE id = ${id} AND retired_at IS NULL AND lost_at IS NULL AND settings_pending = 0
          AND NOT ${modeRefusedSql(sql, sql`sessions.bot_id`)}
          AND ${takesNewWorkSql(sql)}
      `,
    });

    /** Those of the wakes still pending. */
    const pendingWakes = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (ids) => sql`SELECT id FROM wakes WHERE ${sql.in("id", ids)} AND status = 'pending'`,
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
    // wakes written in one transaction share their time. A routine's wake is
    // never planned into the main session: it waits for a side session of its
    // own (`docs/architecture/server.md`, Sessions).
    // An operator's message behind the bot's opening is not among them until
    // the opening has ended (`behindOpeningSql`): it never reaches the
    // opening's turn, and goes in the order it was written once that turn is
    // over, whatever became of it.
    const pendingOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: WakeRow,
      execute: (botId) => sql`
        SELECT ${sql.literal(WAKE_COLUMNS)} FROM wakes w
        WHERE bot_id = ${botId} AND status = 'pending' AND kind <> 'routine'
          AND NOT ${behindOpeningSql(sql, "w")}
        ORDER BY priority, rowid
      `,
    });

    /** Each bot with a pending wake for its main session, the one with the most urgent wake first. */
    const waitingBots = SqlSchema.findAll({
      Request: Schema.Void,
      Result: WaitingBot,
      execute: () => sql`
        SELECT bot_id FROM wakes WHERE status = 'pending' AND kind <> 'routine'
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
     * Written and never sent, not fenced, and in a session no Stop holds it
     * from (`stopHoldsSql`, as the send's claim reads it): sent before
     * anything new is written, whether or not its bot has a wake pending. One
     * whose files failed to stage waits
     * for its deadline, and an opening, also one written before a restart,
     * for its provider (`openingHeld`). Every first send is the dispatcher's,
     * under the budget.
     */
    const unsentRows = sql`
      SELECT id, session_id, delivery, next_attempt_at,
        EXISTS (
          SELECT 1 FROM wakes w WHERE w.dispatch_id = d.id AND w.kind = 'routine'
        ) AS routine,
        ${automatedSql(sql, sql.literal("d.id"))} AS automated,
        d.audience_room_id IS NOT NULL AS room,
        (SELECT s.provider_id FROM sessions s WHERE s.id = d.session_id) AS provider_id,
        (
          SELECT w.bot_id FROM wakes w
          WHERE w.dispatch_id = d.id AND json_extract(w.payload_json, '$._tag') = 'first-run'
          LIMIT 1
        ) AS opening_bot_id
      FROM dispatches d
      WHERE status = 'intended' AND attempts = 0 AND fenced_by_stop_id IS NULL
        AND NOT (CASE WHEN d.delivery = 'steer'
          THEN ${stopHoldsSql(sql, sql`d.session_id`, sql`d.audience_room_id`)}
          ELSE ${stopHoldsSql(sql, sql`d.session_id`, null)}
        END)
      ORDER BY rowid
    `.pipe(Effect.orDie);
    const unsent = Effect.flatMap(unsentRows, (rows) => readEach(rows, Unsent));

    /**
     * Whether the bot's provider is at its usage limit, which holds automated
     * wakes: the dispatcher looks again at the reset, when it is known.
     */
    const providerLimited = Effect.fn("Pipeline.providerLimited")(function* (
      botId: BotId,
      outcome: Outcome,
    ) {
      const bot = yield* bots.find(botId);
      if (Option.isNone(bot)) return false;
      const limit = yield* limitOf(bot.value.bot.model.providerId);
      if (Option.isNone(limit)) return false;
      outcome.until(limit.value.resetsAt);
      return true;
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
     * A room's wakes all go together: their envelope carries every entry the
     * bot has not seen, and the files of those it fits (`roomEnvelope`).
     */
    const coalesce = Effect.fn("Pipeline.coalesce")(function* (
      head: WakeRow,
      pending: ReadonlyArray<WakeRow>,
      delivery: Plan["delivery"],
    ) {
      const audience = audienceOf(head);
      const group: Array<WakeRow> = [];
      const files: Array<Attachment> = [];
      let answers = 0;
      for (const wake of pending) {
        if (wake.kind !== head.kind || !sameAudience(audienceOf(wake), audience)) continue;
        if (head.kind === "room") {
          group.push(wake);
          continue;
        }
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
     * The room's queue: whether a dispatch or turn of it is live
     * (`roomLiveSql`), and whose wake for it goes first among its members.
     * A member whose permission mode the engine refuses (`modeRefusedSql`)
     * has no place in it: nothing can be planned into its main session until
     * the operator acts, so its wakes wait out of the way, and take their
     * place again, as written, once the refusal is gone. Read from durable
     * rows, never a flag kept aside.
     */
    const roomQueue = SqlSchema.findOne({
      Request: Schema.Struct({ roomId: RoomId, botId: BotId }),
      Result: RoomQueue,
      execute: ({ roomId, botId }) => sql`
        SELECT
          EXISTS (
            SELECT 1 FROM room_members rq_self
            WHERE rq_self.room_id = ${roomId} AND rq_self.bot_id = ${botId}
          ) AS member,
          ${roomLiveSql(sql, sql`${roomId}`)} AS busy,
          (
            SELECT rq_wake.bot_id FROM wakes rq_wake
            WHERE rq_wake.audience_room_id = ${roomId} AND rq_wake.status = 'pending'
              AND rq_wake.kind <> 'routine'
              AND rq_wake.bot_id IN (
                SELECT rq_member.bot_id FROM room_members rq_member
                WHERE rq_member.room_id = ${roomId}
              )
              AND NOT ${modeRefusedSql(sql, sql`rq_wake.bot_id`)}
            ORDER BY rq_wake.priority, rq_wake.rowid LIMIT 1
          ) AS next_bot_id
      `,
    });

    /**
     * Whether the wake may start the next turn of the bot's main session
     * `sessionId`. A room runs one turn at a time
     * (`docs/architecture/server.md`, Rooms): a wake for a room may start a
     * turn only while nothing of the room is live and it is the room's first
     * wake, by priority and then as written, so members answer one after
     * another in the order they were addressed, each seeing the replies
     * before it, a member whose permission mode the engine refuses left out
     * (`roomQueue`). While that first wake's bot cannot get a turn slot, the
     * operator's room wake to a member whose session already holds one (its
     * continuation is pending, say) goes first instead, rather than wait
     * behind it for a slot it holds itself. A wake of a bot that left the
     * room goes on to the transaction that cancels it (`roomPlan`). Any other
     * wake may start one as before.
     */
    const mayStart = Effect.fn("Pipeline.mayStart")(function* (
      botId: BotId,
      wake: WakeRow,
      sessionId: SessionRowId,
    ) {
      const audience = audienceOf(wake);
      if (audience._tag !== "room" || audience.roomId === null) return true;
      const queue = yield* roomQueue({ roomId: audience.roomId, botId }).pipe(Effect.orDie);
      if (!queue.member) return true;
      if (queue.busy || queue.next_bot_id === null) return false;
      if (queue.next_bot_id === botId) return true;
      if (wake.priority !== PRIORITY.user || !(yield* admitsStart(sessionId))) return false;
      const first = yield* mainSession({
        botId: queue.next_bot_id,
        now: timeText(yield* DateTime.now),
      }).pipe(Effect.orDie);
      return Option.isSome(first) && !(yield* admitsStart(first.value.id));
    });

    /**
     * Whether the wake is the operator's word for a running turn with this
     * audience, which steers it so they can redirect it: an `ask` answer
     * waits for the turn that asked to finish, and starts the next.
     */
    const redirects = (wake: WakeRow, audience: Audience): boolean =>
      wake.priority === PRIORITY.user &&
      wake.payload_json._tag !== "answer" &&
      sameAudience(audienceOf(wake), audience);

    /**
     * How the bot's main session can take its head wake now: a plan, nothing
     * for now, or a session whose events are not known yet, which is looked
     * at again on a later pass.
     */
    const planFor = Effect.fn("Pipeline.planFor")(function* (
      botId: BotId,
      now: DateTime.Utc,
      outcome: Outcome,
    ) {
      const session = yield* mainSession({ botId, now: timeText(now) }).pipe(Effect.orDie);
      if (Option.isNone(session)) return null;
      const pending = yield* pendingOf(botId).pipe(Effect.orDie);
      if (pending.length === 0) return null;
      // Nothing is planned, and no slot taken, before the session's events
      // are known: what they say decides how it can take the wake.
      yield* observer.watch(session.value.id);
      if (!(yield* observer.ready(session.value.id))) return "not-ready" as const;
      const work = yield* workOf(session.value.id);
      // An unsettled Stop holds every new turn. A room's Stop that waits for
      // the admitted turn of another audience to end lets the operator's word
      // into that turn meanwhile (`stopHoldsSql`).
      if (work.stopUnsettled && (isIdle(work) || work.stopHoldsSteers)) return null;
      if (!isIdle(work)) {
        // A running turn takes only the operator's word for its own
        // audience. A wake for another audience waits for it to end, first in
        // line, and holds none of that word back.
        const { admitted } = work;
        if (admitted === null || work.unsent > 0) return null;
        const head = pending.find((wake) => redirects(wake, admitted.audience));
        if (head === undefined) return null;
        const delivery = { _tag: "steer", turnId: admitted.turnId } as const;
        return {
          sessionId: session.value.id,
          botId,
          wakes: yield* coalesce(head, pending, delivery),
          audience: audienceOf(head),
          delivery,
        } satisfies Plan;
      }
      // The opening goes before anything else, unless it waits for its
      // provider; the operator's messages behind it wait for it to end
      // (`pendingOf`).
      const opening = pending.find((wake) => wake.payload_json._tag === "first-run");
      const others = pending.filter((wake) => wake !== opening);
      const candidates =
        opening === undefined
          ? pending
          : (yield* openingHeld(botId))
            ? others
            : [opening, ...others];
      let head: WakeRow | undefined;
      for (const wake of candidates) {
        if (yield* mayStart(botId, wake, session.value.id)) {
          head = wake;
          break;
        }
      }
      if (head === undefined) return null;
      if (head.payload_json._tag !== "first-run" && head.priority !== PRIORITY.user) {
        // Every automated wake waits for the reset, a bot's room message too.
        if (yield* providerLimited(botId, outcome)) return null;
      }
      // A pending continuation holds back every wake but the operator's,
      // also in a room: the engine then drops the continuation.
      if (work.continuations > 0 && head.priority !== PRIORITY.user) return null;
      if (!(yield* admitsStart(session.value.id))) return null;
      const delivery = { _tag: "start" } as const;
      return {
        sessionId: session.value.id,
        botId,
        wakes: yield* coalesce(head, pending, delivery),
        audience: audienceOf(head),
        delivery,
      } satisfies Plan;
    });

    // ---- Envelopes ----------------------------------------------------------

    const operatorMessageOf = Effect.fn("Pipeline.operatorMessageOf")(function* (entryId: EntryId) {
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "message") return null;
      const message: MessageEntry = found.value.entry;
      return operatorMessage(
        message.createdAt,
        message.text,
        message.attachments,
        message.attachmentOffsets,
      );
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
      return askAnswer({
        card,
        status: card.status,
        values: row.value.option_values_json,
        room: yield* roomName(rooms, row.value.audience_room_id),
      });
    });

    /** A teammate as an envelope names them, also once they were deleted. */
    const teammateRef = Effect.fn("Pipeline.teammateRef")(function* (botId: BotId) {
      return Option.match(yield* bots.find(botId), {
        onNone: (): TeammateRef => ({ id: botId, name: "A former teammate", title: "" }),
        onSome: ({ bot }): TeammateRef => ({
          id: bot.id,
          name: bot.profile.name,
          title: bot.profile.title,
        }),
      });
    });

    /** An urgent message, from the handoff card it put in the recipient's conversation. */
    const teammateMessageOf = Effect.fn("Pipeline.teammateMessageOf")(function* (entryId: EntryId) {
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "handoff") return null;
      const card = found.value.entry;
      return {
        from: yield* teammateRef(card.author.botId),
        at: card.createdAt,
        text: card.text,
        urgent: card.urgent,
      } satisfies TeammateMessage;
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

    /**
     * The bot's held messages in the order they were sent, also a copy of an
     * urgent one its Stop held later: by when its card was written, then by
     * the card's place.
     */
    const heldOf = (botId: BotId) =>
      SqlSchema.findAll({
        Request: Schema.String,
        Result: HeldRow,
        execute: (id) => sql`
          SELECT m.id, m.sender_bot_id, m.text, m.created_at
          FROM held_messages m LEFT JOIN entries e ON e.id = m.handoff_entry_id
          WHERE m.recipient_bot_id = ${id} AND m.consumed_dispatch_id IS NULL
          ORDER BY m.created_at, e.seq, m.rowid
        `,
      })(botId).pipe(Effect.orDie);

    /** What the session has not seen, oldest first: catch-up notes, then held teammate messages. */
    const sinceLastTurn = Effect.fn("Pipeline.sinceLastTurn")(function* (botId: BotId) {
      const unseen: Array<Unseen> = [];
      for (const note of yield* notesOf(botId)) {
        const value = note.note_json;
        unseen.push({
          item: value === null ? null : catchUpItem(value),
          source: { _tag: "note", id: note.id },
        });
      }
      for (const message of yield* heldOf(botId)) {
        const teammate: TeammateMessage = {
          from: yield* teammateRef(message.sender_bot_id),
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
      if (payload._tag === "teammate") {
        const message = yield* teammateMessageOf(payload.entryId);
        return message === null ? null : ({ _tag: "teammate", message } satisfies WakePart);
      }
      return null;
    });

    // ---- Room envelopes -------------------------------------------------------

    /**
     * How far the bot has seen the room: the newest place any of its room
     * dispatches was written after, among those the engine may have applied.
     * One it certainly never applied (released, refused, dropped) leaves its
     * entries unseen, for the next envelope.
     */
    const seenThrough = SqlSchema.findOne({
      Request: Schema.Struct({ botId: BotId, roomId: RoomId }),
      Result: Schema.Struct({ through: Schema.NullOr(Schema.Int) }),
      execute: ({ botId, roomId }) => sql`
        SELECT MAX(room_through) AS through FROM dispatches
        WHERE audience_room_id = ${roomId} AND bot_id = ${botId} AND room_through IS NOT NULL
          AND status NOT IN ('released', 'dropped')
          AND NOT (status = 'failed' AND failure_reason = 'rejected')
      `,
    });

    /** The place of the room's newest entry. */
    const roomEnd = SqlSchema.findOne({
      Request: RoomId,
      Result: Schema.Struct({ end: Schema.NullOr(Schema.Int) }),
      execute: (roomId) => sql`SELECT MAX(position) AS end FROM entries WHERE room_id = ${roomId}`,
    });

    /**
     * The room's messages the bot has not seen: always those its wakes are
     * for, and, newest first, at most `ROOM_ENTRIES_READ` of the others after
     * what it has seen; and how many unseen messages there are in all. Its
     * own are not among them; it wrote them.
     */
    const unseenEntries = Effect.fn("Pipeline.unseenEntries")(function* (
      botId: BotId,
      roomId: RoomId,
      sources: ReadonlyArray<EntryId>,
    ) {
      const { through } = yield* seenThrough({ botId, roomId });
      const fromOthers = sql`
        room_id = ${roomId} AND kind = 'message'
        AND (author_bot_id IS NULL OR author_bot_id <> ${botId})
      `;
      const isSource = sources.length > 0 ? sql.in("id", sources) : sql`0`;
      const [count] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM entries
        WHERE ${fromOthers} AND (position > ${through ?? -1} OR ${isSource})
      `;
      const newest = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ id: EntryId }),
        execute: () => sql`
          SELECT id FROM entries
          WHERE ${fromOthers} AND position > ${through ?? -1} AND NOT ${isSource}
          ORDER BY position DESC LIMIT ${ROOM_ENTRIES_READ}
        `,
      })(undefined);
      const messagesOf = (ids: ReadonlyArray<EntryId>) =>
        Effect.map(
          Effect.forEach(ids, (id) => entries.find(id)),
          (found): Array<MessageEntry> =>
            found.flatMap((one) =>
              Option.isSome(one) && one.value.entry._tag === "message" ? [one.value.entry] : [],
            ),
        );
      return {
        sources: yield* messagesOf(sources),
        newestFirst: yield* messagesOf(newest.map((row) => row.id)),
        total: count?.n ?? 0,
      };
    }, Effect.orDie);

    /** The room as an envelope names it: its members in member order, and its host. */
    const roomHeader = Effect.fn("Pipeline.roomHeader")(function* (room: {
      readonly id: RoomId;
      readonly name: string;
      readonly hostId: BotId;
      readonly members: ReadonlyArray<BotId>;
    }) {
      const members = yield* Effect.forEach(room.members, teammateRef);
      const host = yield* teammateRef(room.hostId);
      return {
        id: room.id,
        name: room.name,
        members,
        hostName: host.name,
      } satisfies RoomWake["room"];
    });

    /** A room message as an envelope shows it, with the members it mentioned by name. */
    const roomEntryOf = Effect.fn("Pipeline.roomEntryOf")(function* (message: MessageEntry) {
      const mentions =
        message.mentions._tag === "everyone"
          ? ("everyone" as const)
          : (yield* Effect.forEach(message.mentions.ids, teammateRef)).map((ref) => ref.name);
      if (message.author._tag === "bot") {
        return {
          author: yield* teammateRef(message.author.botId),
          at: message.createdAt,
          text: message.text,
          mentions,
          files: message.attachments.map((file) => file.name),
        } satisfies RoomEntry;
      }
      return {
        author: "user",
        at: message.createdAt,
        text: message.text,
        mentions,
        attachments: operatorMessage(
          message.createdAt,
          message.text,
          message.attachments,
          message.attachmentOffsets,
        ).attachments,
      } satisfies RoomEntry;
    });

    /**
     * A room's envelope within the engine's limits: the entries its wakes are
     * for, then the newest of the others the bot has not seen that fit, with
     * what the session has not seen, and a line saying how many were left
     * out. The head wake's entry always goes; another wake whose entry does
     * not fit beside it waits for the next envelope, which carries that entry
     * again. A room never fails a wake for its size: one entry always fits,
     * since every writer of the operator's room text checks it alone and a
     * bot's message is short. The files of the operator's entries it carries
     * go with it.
     */
    const roomEnvelope = Effect.fn("Pipeline.roomEnvelope")(function* (
      plan: Plan,
      room: LiveRoom,
      carried: ReadonlyArray<Unseen>,
      base: { readonly at: DateTime.Utc; readonly timeZone: DateTime.TimeZone.Named },
    ) {
      const sourceIds = plan.wakes.map((wake) => wake.source_entry_id);
      const unseen = yield* unseenEntries(
        plan.botId,
        room.id,
        sourceIds.flatMap((id) => (id === null ? [] : [id])),
      );
      const shown = (message: MessageEntry) =>
        Effect.map(roomEntryOf(message), (entry) => ({ message, entry }));
      const sources = new Map(
        (yield* Effect.forEach(unseen.sources, shown)).map((one) => [one.message.id, one]),
      );
      const newestFirst = yield* Effect.forEach(unseen.newestFirst, shown);
      const header = yield* roomHeader(room);
      /** Why the first `wakes` wakes woke the bot: those left for later choose nothing here. */
      const reasonOf = (wakes: number) =>
        strongestReason(
          plan.wakes
            .slice(0, wakes)
            .flatMap((wake) =>
              wake.payload_json._tag === "room" ? [wake.payload_json.reason] : [],
            ),
        );
      /** The entries of the first `wakes` wakes, then the `newest` newest others, in room order. */
      const picked = (wakes: number, newest: number) => {
        const ids = new Set(sourceIds.slice(0, wakes));
        return [
          ...[...sources.values()].filter(({ message }) => ids.has(message.id)),
          ...newestFirst.slice(0, newest),
        ].toSorted((a, b) => a.message.order - b.message.order);
      };
      const filesOf = (wakes: number, newest: number) =>
        picked(wakes, newest).flatMap(({ message }) => message.attachments);
      const render = (wakes: number, newest: number, seen: number): RoomWake | null => {
        const entries = picked(wakes, newest);
        const [first, ...rest] = entries.map(({ entry }) => entry);
        if (first === undefined) return null;
        // The entries of the wakes left for the next envelope go there.
        const waiting = [...sources.keys()].filter(
          (id) => !sourceIds.slice(0, wakes).includes(id),
        ).length;
        return {
          ...base,
          sinceLastTurn: carried
            .slice(0, seen)
            .flatMap(({ item }) => (item === null ? [] : [item])),
          kind: "room",
          room: header,
          reason: reasonOf(wakes),
          omitted: unseen.total - entries.length - waiting,
          entries: [first, ...rest],
        };
      };
      const fits = (wakes: number, newest: number, seen: number) => {
        const wake = render(wakes, newest, seen);
        return (
          wake !== null &&
          fitsEngine(wake) &&
          attachmentLimitViolation(filesOf(wakes, newest)) === undefined
        );
      };
      const { end } = yield* roomEnd(room.id).pipe(Effect.orDie);
      // A wake whose entry is gone still shows the newest one.
      const least = picked(1, 0).length > 0 ? 0 : 1;
      if (!fits(1, least, 0)) {
        return {
          wake: render(1, least, 0),
          wakes: 1,
          seen: 0,
          files: filesOf(1, least),
          through: end,
          fits: false,
        };
      }
      const seen =
        carried.length > 0 && fits(1, least, 1)
          ? longestFitting(carried.length, (count) => fits(1, least, count))
          : 0;
      const wakes = longestFitting(plan.wakes.length, (count) => fits(count, least, seen));
      const newest =
        newestFirst.length > least && fits(wakes, least + 1, seen)
          ? longestFitting(newestFirst.length, (count) => fits(wakes, count, seen))
          : least;
      return {
        wake: render(wakes, newest, seen),
        wakes,
        seen,
        files: filesOf(wakes, newest),
        through: end,
        fits: true,
      };
    });

    /**
     * The envelope for a plan, within the engine's input limit: the head wake,
     * then as much of what the session has not seen as fits, oldest first,
     * then as many of the plan's other wakes as fit, in order. What is left
     * out stays for a later dispatch, in the same order.
     *
     * Every writer of a wake checks that it fits alone, so the two cases
     * below are a defence that never holds the queue: an unseen item that
     * no envelope could carry, as it would not fit even beside the smallest
     * wake there is, is left out for good (`dropped`); and a head wake that
     * does not fit alone goes in an envelope of its own that is never sent
     * (`oversized`), so the wakes behind it go on.
     */
    /**
     * Whether the bot's opening asks what to call the operator: nobody knows
     * yet, and no other bot's opening has gone to the engine. So only the
     * first bot to open without a name asks, and a name the operator passed
     * over there is not asked again. An opening sent again asks again: it is
     * the same hello. Read in the transaction that writes the dispatch.
     */
    const opensAsking = Effect.fn("Pipeline.opensAsking")(function* (botId: BotId) {
      if ((yield* settings.get).operatorName !== null) return false;
      const opened = yield* sql`
        SELECT 1 FROM wakes
        WHERE bot_id <> ${botId} AND json_extract(payload_json, '$._tag') = 'first-run'
          AND status IN ('dispatched', 'finished')
        LIMIT 1
      `;
      return opened.length === 0;
    }, Effect.orDie);

    const envelopeOf = Effect.fn("Pipeline.envelopeOf")(function* (
      plan: Plan,
      unseen: ReadonlyArray<Unseen>,
      room: LiveRoom | null,
    ) {
      const base = { at: yield* DateTime.now, timeZone: yield* zoneOf };
      const [head] = plan.wakes;
      if (head === undefined) {
        return yield* Effect.die(new TurnsInvariant({ invariant: "A plan carries a wake" }));
      }
      if (head.kind === "routine") {
        // A routine's envelope is the routine runner's.
        return yield* Effect.die(
          new TurnsInvariant({ invariant: "No envelope for routine wakes here" }),
        );
      }
      const system = (event: SystemEvent, since: ReadonlyArray<CatchUpItem>): Wake => ({
        ...base,
        sinceLastTurn: since,
        kind: "system",
        event,
      });
      // The smallest envelope there is, one that cannot carry the item alone
      // never will: a system one, whose `first-run` event has the shortest
      // line (`eventLine` in the prompts package) and carries nothing else.
      const carried: Array<Unseen> = [];
      const dropped: Array<Unseen["source"]> = [];
      for (const one of unseen) {
        if (
          one.item === null ||
          fitsEngine(system({ name: "first-run", askName: false }, [one.item]))
        ) {
          carried.push(one);
        } else dropped.push(one.source);
      }
      if (head.kind === "room") {
        if (room === null) {
          return yield* Effect.die(new TurnsInvariant({ invariant: "A room plan has its room" }));
        }
        const fitted = yield* roomEnvelope(plan, room, carried, base);
        return {
          wake: fitted.wake,
          wakes: plan.wakes.slice(0, fitted.wakes),
          consumed: carried.slice(0, fitted.seen).map(({ source }) => source),
          dropped,
          oversized: !fitted.fits && fitted.wake !== null,
          room: { files: fitted.files, through: fitted.through },
        };
      }
      const event =
        head.kind === "system"
          ? yield* systemEventOf(
              head.payload_json,
              head.payload_json._tag === "first-run" && (yield* opensAsking(plan.botId)),
            )
          : null;
      const parts = head.kind === "system" ? [] : yield* Effect.forEach(plan.wakes, partOf);
      const render = (wakes: number, seen: number): Wake | null => {
        const since = carried.slice(0, seen).flatMap(({ item }) => (item === null ? [] : [item]));
        if (event !== null) return system(event, since);
        return head.kind === "bot"
          ? botWake(base, since, parts.slice(0, wakes))
          : userWake(base, since, parts.slice(0, wakes));
      };
      // Nothing left to render takes no room.
      const fits = (wake: Wake | null) => wake === null || fitsEngine(wake);
      if (!fits(render(1, 0))) {
        return {
          wake: render(1, 0),
          wakes: plan.wakes.slice(0, 1),
          consumed: [],
          dropped,
          oversized: true,
          room: null,
        };
      }
      // A system event is never coalesced.
      const most = head.kind === "system" ? 1 : plan.wakes.length;
      const seen =
        carried.length > 0 && fits(render(1, 1))
          ? longestFitting(carried.length, (count) => fits(render(1, count)))
          : 0;
      const wakes = longestFitting(most, (count) => fits(render(count, seen)));
      return {
        wake: render(wakes, seen),
        wakes: plan.wakes.slice(0, wakes),
        consumed: carried.slice(0, seen).map(({ source }) => source),
        dropped,
        oversized: false,
        room: null,
      };
    });

    /**
     * Leaves out for good what the session has not seen and no envelope can
     * carry, showing it in the bot's conversation, in the caller's transaction.
     */
    const dropUnseen = Effect.fn("Pipeline.dropUnseen")(function* (
      botId: BotId,
      dropped: ReadonlyArray<Unseen["source"]>,
    ) {
      if (dropped.length === 0) return;
      const notes = dropped.flatMap((row) => (row._tag === "note" ? [row.id] : []));
      const held = dropped.flatMap((row) => (row._tag === "held" ? [row.id] : []));
      if (notes.length > 0) yield* sql`DELETE FROM catch_up_notes WHERE ${sql.in("id", notes)}`;
      if (held.length > 0) {
        const removed = yield* sql<{ readonly handoff_entry_id: string | null }>`
          DELETE FROM held_messages WHERE ${sql.in("id", held)} RETURNING handoff_entry_id
        `;
        yield* ledger.heldRemoved(
          removed.flatMap((row) =>
            row.handoff_entry_id === null ? [] : [EntryId.make(row.handoff_entry_id)],
          ),
          "not-delivered",
        );
      }
      yield* notify(botId, conversation, { _tag: "too-long" }, null);
    });

    /**
     * A plan for a room, read again in the transaction that writes its
     * dispatch: the room must still be active, or its wakes have nowhere to
     * go and are cancelled; the bot must still be a member, or its wakes for
     * the room are cancelled, so it reads nothing said there since it left;
     * a start must still find nothing of the room live, and its wake first
     * in the room's queue (`mayStart`), as the room runs one turn at a time;
     * and every room wake of the bot pending now goes together, so an entry written
     * since the plan was made, which the envelope carries, leaves no wake
     * behind for an envelope with nothing new.
     */
    const roomPlan = Effect.fn("Pipeline.roomPlan")(function* (plan: Plan) {
      const audience = plan.audience;
      if (audience._tag !== "room") return { _tag: "plan", plan, room: null } as const;
      const room = audience.roomId === null ? Option.none() : yield* roomOf(audience.roomId);
      if (Option.isNone(room)) {
        yield* ledger.cancelWakes(plan.wakes.map((wake) => wake.id));
        return { _tag: "done", result: null } as const;
      }
      const forRoom = (yield* pendingOf(plan.botId)).filter((wake) =>
        sameAudience(audienceOf(wake), audience),
      );
      if (!room.value.members.includes(plan.botId)) {
        yield* ledger.cancelWakes(forRoom.map((wake) => wake.id));
        // Its other wakes are planned again without these.
        return { _tag: "done", result: "stale" } as const;
      }
      const [head] = plan.wakes;
      if (plan.delivery._tag === "start" && head !== undefined) {
        if (!(yield* mayStart(plan.botId, head, plan.sessionId))) {
          return { _tag: "done", result: "stale" } as const;
        }
      }
      if (head?.kind !== "room") return { _tag: "plan", plan, room: room.value } as const;
      const wakes = forRoom.filter((wake) => wake.kind === "room");
      return { _tag: "plan", plan: { ...plan, wakes }, room: room.value } as const;
    });

    /**
     * Writes the dispatch for a plan, in one transaction: its envelope, its
     * files in order, its wakes linked, and the notes and held messages the
     * envelope consumed. Nothing changes if the plan no longer holds: its
     * session was retired, lost, became due for a rotation that takes no new
     * work, or its bot's settings changed since it was chosen, or a teammate's
     * message it waits on turned out read, whose wake is cancelled then
     * (`stale`, planned again), or its wakes are no longer pending.
     */
    const writeDispatch = Effect.fn("Pipeline.writeDispatch")(function* (chosen: Plan) {
      return yield* transaction(
        Effect.gen(function* () {
          if (Option.isNone(yield* plannedSession(chosen.sessionId))) return "stale" as const;
          // A teammate's message the bot read meanwhile goes no more, as a
          // wake or held; the plan is made again without such a wake.
          if (yield* ledger.settleRead(chosen.botId)) return "stale" as const;
          const still = yield* pendingWakes(chosen.wakes.map((wake) => wake.id));
          if (still.length !== chosen.wakes.length) return null;
          const roomed = yield* roomPlan(chosen);
          if (roomed._tag !== "plan") return roomed.result;
          const { plan, room } = roomed;
          const fitted = yield* envelopeOf(plan, yield* sinceLastTurn(plan.botId), room);
          yield* dropUnseen(plan.botId, fitted.dropped);
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
              envelope, room_through, status, created_at, updated_at
            ) VALUES (
              ${id}, ${plan.botId}, ${plan.sessionId}, ${audience}, ${roomId}, ${plan.delivery._tag},
              ${plan.delivery._tag === "steer" ? plan.delivery.turnId : null},
              ${envelope}, ${fitted.room?.through ?? null}, 'intended', ${at}, ${at}
            )
          `;
          const files =
            fitted.room === null
              ? (yield* Effect.forEach(fitted.wakes, filesOfWake)).flat()
              : fitted.room.files;
          for (const [position, file] of files.entries()) {
            yield* sql`
              INSERT INTO dispatch_attachments (dispatch_id, position, attachment_id)
              VALUES (${id}, ${position}, ${file.id})
            `;
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
          if (fitted.oversized) {
            // The engine would refuse it: it fails as refused, never sent,
            // and shows where it came from; the bot's next wake goes on.
            yield* ledger.fail(id, "rejected", { _tag: "failed", reason: "rejected" });
            yield* sql.afterCommit(signals.dispatch.fire);
            return null;
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
    const sendOne = (dispatchId: DispatchRowId, owner: SendOwner, outcome: Outcome) =>
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
     * Sends the dispatches written and not yet sent: a start is admitted when
     * it is sent, like a new one. A room start that cannot be sent now, for
     * want of a turn slot or held by a usage limit, goes to its send all the
     * same, which releases it rather than let it hold the room, and so does a
     * main session's start the limit holds, rather than hold back the
     * operator's word (`Sender`). Whether the engine refused a command.
     */
    const sendUnsent = Effect.fn("Pipeline.sendUnsent")(function* (
      rows: ReadonlyArray<typeof Unsent.Type>,
      now: DateTime.Utc,
      outcome: Outcome,
    ) {
      for (const row of rows) {
        if (row.next_attempt_at !== null && DateTime.isGreaterThan(row.next_attempt_at, now)) {
          continue;
        }
        const heldStart = row.delivery === "start" && !row.room;
        if (heldStart && !(yield* admitsStart(row.session_id))) continue;
        if (row.opening_bot_id !== null && (yield* openingHeld(row.opening_bot_id))) continue;
        // A routine's start, in its side session: a provider that reached its
        // usage limit since it was written holds it until the reset, as
        // planning would.
        if (heldStart && row.automated && row.routine) {
          const limit = yield* limitOf(row.provider_id);
          if (Option.isSome(limit)) {
            if (limit.value.resetsAt !== null) outcome.until(limit.value.resetsAt);
            continue;
          }
        }
        const result = yield* sendOne(row.id, "dispatcher", outcome);
        if (result === "engine-unavailable") return true;
        if (result === "skipped") outcome.defer();
      }
      return false;
    });

    /**
     * A pass of the dispatcher, which makes every first send. A session that
     * is not ready only defers its own dispatch; only the engine refusing a
     * command ends the pass. The free slots are read again before each send:
     * what holds one is what the engine may have, never what a send returned.
     * A slot goes to the most urgent work that can take it now: a routine's
     * start, the least urgent kind, is sent only after every bot's waiting
     * wakes were planned, so it never takes the slot an operator's message
     * would have.
     */
    const dispatchPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        // A dispatch written before a crash, while the engine was down, or
        // whose files failed to stage goes first.
        const written = yield* unsent;
        const routineStarts = written.filter((row) => row.routine);
        const others = written.filter((row) => !row.routine);
        if (yield* sendUnsent(others, now, outcome)) return { _tag: "unavailable" } as const;
        for (const { bot_id: botId } of yield* waitingBots) {
          const planned = yield* planOne(
            Effect.gen(function* () {
              // Planned again, once, when its session changed under the plan.
              for (let attempt = 0; attempt < 2; attempt++) {
                const plan = yield* planFor(botId, now, outcome);
                if (plan === null || plan === "not-ready") return plan;
                const dispatchId = yield* writeDispatch(plan);
                if (dispatchId !== "stale") {
                  return dispatchId === null ? null : { plan, dispatchId };
                }
              }
              return null;
            }),
            null,
          );
          if (planned === "not-ready") outcome.defer();
          if (planned === null || planned === "not-ready") continue;
          const result = yield* sendOne(planned.dispatchId, "dispatcher", outcome);
          if (result === "engine-unavailable") return { _tag: "unavailable" } as const;
          if (result === "skipped") outcome.defer();
        }
        if (yield* sendUnsent(routineStarts, now, outcome)) return { _tag: "unavailable" } as const;
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
