// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  BotId,
  Conflict,
  type EntryTarget,
  MAX_ATTACHMENT_SIZE,
  type MessageEntry,
  RoomId,
  siteOriginOf,
} from "@j3-bots/contracts";
import {
  attachmentLimitViolation,
  type EngineTabId,
  SessionId,
  TurnId,
  toolInputDigest,
  ToolInputDigest,
} from "@j3-bots/engine-t3";
import { BROWSER_HELP_REQUESTED, type ToolInput } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Attachments, isStorable } from "../attachments/Attachments.ts";
import { workspaceReader } from "../attachments/workspaceFile.ts";
import { BotStore } from "../bots/BotStore.ts";
import type { BotSession } from "../bots/EngineSessions.ts";
import { BROWSER_HELP_WAIT, siteOf } from "../browser/browserHelpRules.ts";
import { BrowserTabs } from "../browser/BrowserTabs.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { type LiveRoom, liveRoom } from "../rooms/liveRoom.ts";
import { RoomRouting } from "../rooms/RoomRouting.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import {
  type FillCall,
  CallCutOff,
  type ClaimedCall,
  TurnEnded,
  type TurnToolCall,
  TurnToolRefused,
  TurnToolRetry,
  TurnTools,
} from "../tools/TurnTools.ts";
import { hopCounts } from "./hopCounts.ts";
import { Ledger } from "./Ledger.ts";
import { liveTarget } from "./liveTarget.ts";
import { mediaTypeOf } from "./mediaTypes.ts";
import { routineSpeech } from "./routineSpeech.ts";
import { type Once, routineTool } from "./routineTool.ts";
import {
  ADMISSION_DEADLINE,
  type Audience,
  AudienceColumn,
  audienceColumns,
  audienceOf,
  conversation,
  DispatchRowId,
  DispatchSeq,
  SessionRowId,
} from "./model.ts";
import { notices } from "./notices.ts";
import { Observer } from "./Observer.ts";
import { Stops } from "./Stops.ts";
import { stopTargets } from "./stopTargets.ts";
import { Wakes } from "./Wakes.ts";

/**
 * The most bytes the files of one `say` take together. The operator's own
 * upload path has no total per message, so it is one upload's limit: a `say`
 * buffers at most this much, also on a small host.
 */
const MAX_SAY_ATTACHMENTS_SIZE = 25 * 1024 * 1024;

/** How many times a request is matched again after the first try, and within how long. */
const MATCH_RETRIES = 5;
const MATCH_WITHIN = Duration.seconds(2);

/**
 * Why a chain may go no further, for the bot: it reached the hop limit. A
 * count borrowed from background work (`hopCounts.borrow`) says where it came
 * from, so the limit does not look arbitrary to a turn that started on its own.
 */
const chainReached = (borrowed: boolean, what: "turns" | "messages", limit: number) =>
  borrowed
    ? `this turn started on its own while background work that a chain of ${what} between bots started was still running in your session, so it counts as part of that chain, which reached your user's limit of ${limit} since they last spoke.`
    : `this chain of ${what} between bots reached your user's limit of ${limit} since they last spoke.`;

/** A request pinned to the engine's record of its call, and so to a turn and an audience. */
interface Pin {
  readonly requestId: string;
  readonly sessionId: SessionRowId;
  readonly botId: BotId;
  readonly turnId: TurnId;
  readonly callId: string;
  /**
   * The arguments the call was matched by. The engine can record an open,
   * unclaimed call again with other arguments, so the pin holds only while
   * the call still has these.
   */
  readonly digest: ToolInputDigest;
  readonly audience: Audience;
  /** Whether a call the engine closed already is still the request's (`Calls`). */
  readonly calls: Calls;
}

/**
 * Which of the turn's calls a request may claim: J3 Bots' own tools only an
 * open one; a connector's tool also one the engine closed, since Codex's
 * record of a call closes while the call still waits on its approval
 * (`docs/architecture/server.md`, Connector tools). Either way the call is
 * the running admitted turn's, and no other request's.
 */
type Calls = "open" | "open-or-closed";

/** The least `engine_tool_calls.open` a call of `calls` has. */
const minimumOpen = (calls: Calls) => (calls === "open" ? 1 : 0);

const Candidate = Schema.Struct({
  engine_call_id: Schema.String,
  engine_turn_id: TurnId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
});

const CallKey = Schema.Struct({
  sessionId: SessionRowId,
  tool: Schema.String,
  digest: ToolInputDigest,
  calls: Schema.Literals(["open", "open-or-closed"]),
});

const StoredResult = Schema.Struct({ result_json: json(Schema.Json) });

/**
 * A refusal that committed something, as a `message_bot` past the hop limit
 * commits its notice: stored as the request's result like any other, so a
 * replayed forward refuses the same way.
 */
const StoredRefusal = Schema.TaggedStruct("refused", { reason: Schema.String });
const storedRefusal = Schema.decodeUnknownOption(StoredRefusal);

/** The answer a stored result gives the bot: a refusal fails, anything else is the result. */
const answer = (result: Schema.Json) =>
  Option.match(storedRefusal(result), {
    onNone: () => Effect.succeed(result),
    onSome: ({ reason }) => Effect.fail(new TurnToolRefused({ reason })),
  });

/** A request as its stored result is looked up: under its id, for its caller and its tool. */
const RequestKey = Schema.Struct({
  requestId: Schema.String,
  sessionId: SessionRowId,
  tool: Schema.String,
});

const encodeResult = Schema.encodeEffect(json(Schema.Json));

/** A file a `say` attaches, read from the workspace and stored once the request is pinned. */
interface WorkspaceFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** The turn tools a request is pinned for. */
type PinnedTool =
  | "say"
  | "ask"
  | "request_browser_help"
  | "message_bot"
  | "set_routine"
  | "set_operator_name"
  | "request_credential"
  | "fill_credential";

/** A request matched to its call, or one a forward of it already committed. */
type Matched =
  | { readonly _tag: "pin"; readonly pin: Pin }
  | { readonly _tag: "stored"; readonly result: Schema.Json };

/** What a request is matched and looked up by: a turn tool's call, a fill's or a connector tool's. */
interface Request {
  readonly tool: string;
  readonly requestId: string;
  readonly caller: BotSession;
  readonly arguments: Schema.Json;
}

const keyOf = (call: Request) => ({
  requestId: call.requestId,
  sessionId: call.caller.id,
  tool: call.tool,
});

/**
 * The turn tools (`docs/architecture/server.md`, Bot tools): `say` and `ask`,
 * which speak, `request_browser_help`, which asks the operator to do a step
 * in the bot's browser, `message_bot`, which reaches a teammate (Teammate messages),
 * `set_routine` (`routineTool.ts`) and `set_operator_name`. Each request is matched to the
 * engine's record of its call in the session's running admitted turn and
 * pinned to it, in the transaction that applies it, so a request acts once,
 * for the turn and the audience that made it.
 */
export const layer = Layer.effect(
  TurnTools,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const observer = yield* Observer;
    const entries = yield* Entries;
    const ledger = yield* Ledger;
    const attachments = yield* Attachments;
    const bots = yield* BotStore;
    const routing = yield* RoomRouting;
    const settings = yield* SettingsStore;
    const settingsService = yield* SettingsService;
    const wakes = yield* Wakes;
    const browserTabs = yield* BrowserTabs;
    const ids = yield* Ids;
    const stops = stopTargets(sql);
    const turnStops = yield* Stops;
    const chains = hopCounts(sql);
    const { notify } = notices(sql, entries);
    const readWorkspaceFile = yield* workspaceReader;
    const targetOf = liveTarget(sql);
    const roomOf = liveRoom(sql);
    const spoken = routineSpeech(sql, ids, yield* ChangeLog);
    const setRoutine = yield* routineTool;

    const engineSessionOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ engine_session_id: SessionId }),
      execute: (id) => sql`
        SELECT engine_session_id FROM sessions WHERE id = ${id} AND engine_session_id IS NOT NULL
      `,
    });

    const purposeOf = SqlSchema.findOneOption({
      Request: SessionRowId,
      Result: Schema.Struct({ purpose: Schema.Literals(["main", "side"]) }),
      execute: (id) => sql`SELECT purpose FROM sessions WHERE id = ${id}`,
    });

    /**
     * What a request committed already. The same id from another session, or
     * for another tool, is not that request and gets nothing.
     */
    const storedResult = SqlSchema.findOneOption({
      Request: RequestKey,
      Result: StoredResult,
      execute: ({ requestId, sessionId, tool }) => sql`
        SELECT result_json FROM tool_calls
        WHERE id = ${requestId} AND session_id = ${sessionId} AND tool = ${tool}
          AND result_json IS NOT NULL
      `,
    });

    /**
     * The oldest call in the running admitted turn that matches, is `calls`,
     * no request claimed, and is not held by an approval the operator declined:
     * a declined call is over, whatever the engine's record of it says.
     */
    const candidate = SqlSchema.findOneOption({
      Request: CallKey,
      Result: Candidate,
      execute: ({ sessionId, tool, digest, calls }) => sql`
        SELECT c.engine_call_id, c.engine_turn_id, t.audience, t.audience_room_id
        FROM engine_tool_calls c
        JOIN sessions s ON s.id = c.session_id AND s.admitted_turn_id = c.engine_turn_id
        JOIN turns t ON t.session_id = c.session_id AND t.engine_turn_id = c.engine_turn_id
        WHERE c.session_id = ${sessionId} AND c.tool = ${tool} AND c.input_digest = ${digest}
          AND c.open >= ${minimumOpen(calls)} AND t.finished_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM tool_calls p
            WHERE p.session_id = c.session_id AND p.engine_call_id = c.engine_call_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM engine_requests r
            WHERE r.session_id = c.session_id AND r.engine_call_id = c.engine_call_id
              AND json_extract(r.response_json, '$.decision') = 'deny'
          )
        ORDER BY c.seen_at, c.rowid
        LIMIT 1
      `,
    });

    /**
     * Brings the session's events up to the request, then looks for its call;
     * the engine records a call apart from the request, so it looks again a
     * bounded number of times. A forward of the same request that committed
     * meanwhile claimed the call: its stored result is the answer, also when
     * the engine no longer has the session.
     */
    const match = Effect.fn("Speech.match")(function* (
      call: Request,
      caller: BotSession,
      calls: Calls,
    ): Effect.fn.Return<Matched, TurnEnded | TurnToolRetry> {
      const sessionId = caller.id;
      const session = yield* engineSessionOf(sessionId).pipe(Effect.orDie);
      if (Option.isNone(session)) return yield* new TurnEnded();
      const digest = yield* toolInputDigest(call.arguments);
      const started = yield* DateTime.now;
      for (let attempt = 0; attempt <= MATCH_RETRIES; attempt++) {
        const vanished = yield* observer
          .synchronize(sessionId, session.value.engine_session_id)
          .pipe(
            Effect.as(false),
            Effect.catchTags({
              // Archived or removed: what a forward of this request committed
              // before that is still its answer.
              SessionNotFound: () => Effect.succeed(true),
              // Nothing is pinned: the bridge forwards the request again.
              NotObserved: () => new TurnToolRetry(),
              EngineUnavailable: () => new TurnToolRetry(),
              EngineIndeterminate: () => new TurnToolRetry(),
              EngineIncompatible: () => new TurnToolRetry(),
            }),
          );
        if (vanished) {
          const stored = yield* storedResult(keyOf(call)).pipe(Effect.orDie);
          if (Option.isSome(stored)) return { _tag: "stored", result: stored.value.result_json };
          return yield* new TurnEnded();
        }
        const found = yield* candidate({ sessionId, tool: call.tool, digest, calls }).pipe(
          Effect.orDie,
        );
        if (Option.isSome(found)) {
          return {
            _tag: "pin",
            pin: {
              requestId: call.requestId,
              sessionId,
              botId: caller.botId,
              turnId: found.value.engine_turn_id,
              callId: found.value.engine_call_id,
              digest,
              audience: audienceOf(found.value),
              calls,
            },
          };
        }
        const stored = yield* storedResult(keyOf(call)).pipe(Effect.orDie);
        if (Option.isSome(stored)) return { _tag: "stored", result: stored.value.result_json };
        const elapsed = DateTime.distance(started, yield* DateTime.now);
        if (Duration.isGreaterThan(elapsed, MATCH_WITHIN)) break;
      }
      return yield* new TurnEnded();
    });

    /**
     * The call is still the session's admitted turn's, open unless the pin
     * takes a closed one too, with the arguments it was matched by, not
     * declined by the operator, and that turn has not finished.
     */
    const stillAdmitted = (found: Pin) =>
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM engine_tool_calls c
        JOIN sessions s ON s.id = c.session_id AND s.admitted_turn_id = c.engine_turn_id
        JOIN turns t ON t.session_id = c.session_id AND t.engine_turn_id = c.engine_turn_id
        WHERE c.session_id = ${found.sessionId} AND c.engine_call_id = ${found.callId}
          AND c.engine_turn_id = ${found.turnId} AND c.input_digest = ${found.digest}
          AND c.open >= ${minimumOpen(found.calls)} AND t.finished_at IS NULL
          AND s.retired_at IS NULL AND s.lost_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM engine_requests r
            WHERE r.session_id = c.session_id AND r.engine_call_id = c.engine_call_id
              AND json_extract(r.response_json, '$.decision') = 'deny'
          )
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      );

    /**
     * Admits the request in the caller's transaction, from what is committed
     * there and not from what `match` read: the call must still be open,
     * unclaimed and with the arguments it was matched by in the running
     * admitted turn, and the room the turn speaks
     * for still live (also for a `say` to the operator, which a room's work
     * makes). A retry of a request already admitted gets its stored result.
     */
    const pin = Effect.fn("Speech.pin")(function* (tool: PinnedTool, found: Pin) {
      const stored = yield* storedResult({
        requestId: found.requestId,
        sessionId: found.sessionId,
        tool,
      }).pipe(Effect.orDie);
      if (Option.isSome(stored)) {
        return { _tag: "stored", result: stored.value.result_json } as const;
      }
      yield* requireUnclaimed(found);
      yield* requireTarget(found.botId, found.audience);
      yield* insertPin(tool, found);
      return { _tag: "pinned" } as const;
    });

    /**
     * The call is no other request's, nor is the id (one used by another
     * session or tool is not this request's to take), and the call is still
     * open in the running admitted turn with the arguments it was matched by.
     */
    const requireUnclaimed = Effect.fn("Speech.requireUnclaimed")(function* (found: Pin) {
      const claimed = yield* sql`
        SELECT 1 FROM tool_calls
        WHERE (session_id = ${found.sessionId} AND engine_call_id = ${found.callId})
          OR id = ${found.requestId}
      `.pipe(Effect.orDie);
      if (claimed.length > 0 || !(yield* stillAdmitted(found))) return yield* new TurnEnded();
    });

    const insertPin = Effect.fn("Speech.insertPin")(function* (tool: string, found: Pin) {
      const columns = audienceColumns(found.audience);
      yield* sql`
        INSERT INTO tool_calls (
          id, session_id, engine_turn_id, engine_call_id, audience, audience_room_id, tool,
          created_at
        ) VALUES (
          ${found.requestId}, ${found.sessionId}, ${found.turnId}, ${found.callId},
          ${columns.audience}, ${columns.roomId}, ${tool}, ${timeText(yield* DateTime.now)}
        )
      `.pipe(Effect.orDie);
    });

    /**
     * Applies a request once: in one transaction it is pinned, `apply` runs
     * and its result is stored, or a retry gets the result stored already.
     */
    const once =
      (tool: PinnedTool, found: Pin): Once =>
      (apply) =>
        transaction(
          Effect.gen(function* () {
            const pinned = yield* pin(tool, found);
            if (pinned._tag === "stored") return pinned.result;
            const result = yield* apply;
            yield* store(found, result);
            return result;
          }),
        );

    /** The dispatches the pinned turn delivers: its owner and the steers riding it. */
    const turnDispatches = SqlSchema.findAll({
      Request: Schema.Struct({ sessionId: SessionRowId, turnId: TurnId }),
      Result: Schema.Struct({ id: DispatchRowId }),
      execute: ({ sessionId, turnId }) => sql`
        SELECT id FROM dispatches
        WHERE session_id = ${sessionId} AND engine_turn_id = ${turnId}
          AND status IN ('accepted', 'delivered')
      `,
    });
    const deliveredBy = (found: Pin) =>
      turnDispatches({ sessionId: found.sessionId, turnId: found.turnId }).pipe(Effect.orDie);

    const deliveredSql = (found: Pin) => chains.deliveredInSql(found.sessionId, found.turnId);
    const chainOf = (found: Pin) => chains.chainSql(found.sessionId, found.turnId);

    /** The hop count of a wake the pinned turn causes (`hopCounts`), or `null`. */
    const hopCount = (found: Pin) => chains.hopCount(found.sessionId, found.turnId);

    /**
     * Whether the operator spoke in the pinned turn itself: a wake of theirs
     * started it, or the engine took a steer of theirs into it (`steered`
     * into this very turn). A continuation, or a turn the engine started for
     * a turn's background work, inherits no such word: its chain's hops
     * start again from the operator, but its fan-out counts. So does the
     * continuation of a steer the engine made a turn of its own (`new-turn`).
     */
    const operatorSpokeIn = (found: Pin) =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ spoke: Schema.BooleanFromBit }),
        execute: () => sql`
          SELECT EXISTS (
            SELECT 1 FROM dispatches os_dispatch
            JOIN wakes os_wake ON os_wake.dispatch_id = os_dispatch.id
            JOIN turns os_turn ON os_turn.session_id = os_dispatch.session_id
              AND os_turn.engine_turn_id = os_dispatch.engine_turn_id
            WHERE os_dispatch.session_id = ${found.sessionId}
              AND os_dispatch.engine_turn_id = ${found.turnId}
              AND os_dispatch.status IN ('accepted', 'delivered', 'finished')
              AND (
                (os_dispatch.disposition = 'steered'
                  AND os_dispatch.disposition_turn_id = ${found.turnId})
                OR os_turn.origin_turn_id IS NULL
              )
              AND (os_wake.kind = 'user' OR EXISTS (
                SELECT 1 FROM entries os_entry
                WHERE os_entry.id = os_wake.source_entry_id AND os_entry.author_kind = 'operator'
              ))
          ) AS spoke
        `,
      })(undefined).pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.spoke ?? false),
      );

    /** The teammates whose messages the pinned turn's chain delivers: its `bot` wakes and held messages. */
    const sendersCarried = (found: Pin) =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ sender: BotId }),
        execute: () => sql`
          SELECT e.author_bot_id AS sender FROM wakes w JOIN entries e ON e.id = w.source_entry_id
          WHERE w.kind = 'bot' AND w.dispatch_id IN (${deliveredSql(found)})
          UNION
          SELECT sender_bot_id AS sender FROM held_messages
          WHERE consumed_dispatch_id IN (${deliveredSql(found)})
        `,
      })(undefined).pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.sender)),
      );

    /**
     * Whether a Stop covers the pinned turn's work: one recorded while a turn
     * of its chain ran, or after the dispatch that began the chain's work
     * was written. A turn the engine started on its own goes on with the work
     * of the turn it names, so a Stop that covers that work covers it too,
     * also one recorded before it began; for work it does not name, only the
     * first counts.
     */
    const workStopped = Effect.fn("Speech.workStopped")(function* (found: Pin) {
      const [turn] = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ stopped: Schema.BooleanFromBit, seq: Schema.NullOr(DispatchSeq) }),
        execute: () => sql`
          SELECT
            EXISTS (
              SELECT 1 FROM turns ws_turn
              WHERE ws_turn.session_id = ${found.sessionId} AND ws_turn.stop_id IS NOT NULL
                AND ws_turn.engine_turn_id IN (${chainOf(found)})
            ) AS stopped,
            (
              SELECT MIN(ws_dispatch.seq) FROM dispatches ws_dispatch
              WHERE ws_dispatch.session_id = ${found.sessionId}
                AND ws_dispatch.engine_turn_id IN (${chainOf(found)})
            ) AS seq
        `,
      })(undefined).pipe(Effect.orDie);
      if (turn === undefined) return { stopped: false, seq: null };
      const stopped =
        turn.stopped ||
        (turn.seq !== null && (yield* stops.covers(found.botId, found.audience, turn.seq)));
      return { stopped, seq: turn.seq };
    });

    /** The teammates the pinned turn's chain has messaged, each once. */
    const messagedBy = (found: Pin) =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ recipient_bot_id: BotId }),
        execute: () => sql`
          SELECT DISTINCT h.recipient_bot_id FROM handoffs h
          JOIN tool_calls c ON c.id = h.tool_call_id
          WHERE c.session_id = ${found.sessionId}
            AND c.engine_turn_id IN (${chainOf(found)})
        `,
      })(undefined).pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.recipient_bot_id)),
      );

    /** Whether a `message_bot` of the pinned turn was already refused at the hop limit. */
    const chainStopped = (found: Pin) =>
      sql`
        SELECT 1 FROM tool_calls
        WHERE session_id = ${found.sessionId} AND engine_turn_id = ${found.turnId}
          AND tool = 'message_bot' AND json_extract(result_json, '$._tag') = 'refused'
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /** Whether a `say` of the pinned turn already found its mentions past the room's hop limit. */
    const roomChainStopped = (found: Pin) =>
      sql`
        SELECT 1 FROM tool_calls
        WHERE session_id = ${found.sessionId} AND engine_turn_id = ${found.turnId}
          AND tool = 'say' AND json_extract(result_json, '$.stopped') = 'hops'
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /**
     * The members a room `say` mentions, each once, checked against the room
     * and the fan-out limit in the caller's transaction. A refusal sends
     * nothing.
     */
    const mentionedIn = Effect.fn("Speech.mentionedIn")(function* (
      found: Pin,
      room: LiveRoom,
      given: ReadonlyArray<string>,
    ) {
      const refuse = (reason: string) => new TurnToolRefused({ reason });
      const mention: Array<BotId> = [];
      for (const id of given) {
        const botId = Option.getOrNull(Schema.decodeOption(BotId)(id));
        if (botId === found.botId) {
          return yield* refuse(
            "Nothing was sent: that id in `mention` is your own. Mention only the members who must act next.",
          );
        }
        if (botId === null || !room.members.includes(botId)) {
          return yield* refuse(
            `Nothing was sent: ${id} is not a member of this room. The room's members and their ids are in the wake; mention only them.`,
          );
        }
        if (!mention.includes(botId)) mention.push(botId);
      }
      const { budgets } = yield* settings.get;
      if (mention.length > budgets.fanOut) {
        return yield* refuse(
          `Nothing was sent: one message may mention at most ${budgets.fanOut} ${budgets.fanOut === 1 ? "member" : "members"}. Mention only who must act next, or tell your user who else should.`,
        );
      }
      return mention;
    });

    /**
     * Where the pinned turn's speech goes, unless its room was archived or
     * deleted, or the bot was removed from it: a turn for a room it has left
     * says nothing more there, and wakes nobody.
     */
    const requireTarget = Effect.fn("Speech.requireTarget")(function* (
      botId: BotId,
      audience: Audience,
    ) {
      const target = yield* targetOf(botId, audience);
      if (target !== null) return target;
      if (audience._tag === "room" && audience.roomId !== null) {
        if (Option.isSome(yield* roomOf(audience.roomId))) {
          return yield* new TurnToolRefused({
            reason:
              "Nothing was sent: your user removed you from this room, so this turn's work for it is over. Stop here.",
          });
        }
      }
      return yield* new Conflict({ reason: "room-archived" });
    });

    /**
     * Reads the files a `say` attaches from the bot's workspace;
     * they are copied into the attachment store once the request is admitted,
     * so the operator can open them after the bot changes or removes its copy.
     * Paths outside the workspace, also by a link swapped in on the way, what
     * is not a regular file, empty files and files above
     * `MAX_ATTACHMENT_SIZE`, of which no more than that is read, are refused
     * (`readWorkspaceFile`), and so are files together above
     * `MAX_SAY_ATTACHMENTS_SIZE`, of which no more than that is read, a
     * name the store would not take, and files the engine would refuse in
     * one message (`attachmentLimitViolation`), such as an image above its
     * inline limit. Every file is checked before any is stored.
     */
    const workspaceFiles = Effect.fn("Speech.workspaceFiles")(function* (
      botId: BotId,
      paths: ReadonlyArray<string>,
    ) {
      if (paths.length === 0) return [];
      const bot = yield* bots.find(botId);
      if (Option.isNone(bot)) return yield* new TurnEnded();
      const refuse = (reason: string) => new TurnToolRefused({ reason });
      // The real path kept from provisioning: resolving `workspacePath` now
      // would follow a link the bot put in its folder's place.
      if (Option.isNone(bot.value.workspaceRoot)) {
        return yield* refuse("Your workspace is not ready, so nothing can be attached yet.");
      }
      const root = bot.value.workspaceRoot.value;
      const files: Array<WorkspaceFile> = [];
      let total = 0;
      for (const given of paths) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
          return yield* refuse(
            `${given} is a URL. Save the file into your workspace first, then attach its path.`,
          );
        }
        const left = MAX_SAY_ATTACHMENTS_SIZE - total;
        const read = yield* readWorkspaceFile(root, given, Math.min(MAX_ATTACHMENT_SIZE, left));
        switch (read._tag) {
          case "missing":
            return yield* refuse(`There is no file at ${given} in your workspace.`);
          case "outside":
            return yield* refuse(`${given} is outside your workspace. Copy it under files/ first.`);
          case "not-a-file":
            return yield* refuse(`${given} is not a file.`);
          case "too-large":
            return yield* refuse(
              left < MAX_ATTACHMENT_SIZE
                ? `${given} cannot be attached: the files together are larger than ${MAX_SAY_ATTACHMENTS_SIZE / 1024 / 1024} MiB. Attach fewer, or send the rest in another message.`
                : `${given} cannot be attached: it is larger than ${MAX_ATTACHMENT_SIZE / 1024 / 1024} MiB.`,
            );
          case "unreadable":
            return yield* refuse(`${given} could not be read.`);
          case "read":
            if (read.bytes.length === 0) {
              return yield* refuse(`${given} cannot be attached: it is empty.`);
            }
            const file = { name: read.name, mediaType: mediaTypeOf(read.name), bytes: read.bytes };
            if (!isStorable({ ...file, size: file.bytes.length })) {
              return yield* refuse(
                `${given} cannot be attached: its name cannot be used. Rename it and attach it again.`,
              );
            }
            total += file.bytes.length;
            files.push(file);
        }
      }
      // Every `say` is held to the engine's rule for one message's files,
      // wherever it speaks, as the operator's own files are: a room
      // message's go in the envelope of each member it wakes, where the
      // engine would refuse what it refuses here.
      const violation = attachmentLimitViolation(
        files.map((file) => ({ mediaType: file.mediaType, size: file.bytes.length })),
      );
      if (violation !== undefined) {
        return yield* refuse(
          violation._tag === "image-too-large"
            ? `${paths[violation.index] ?? "An image"} cannot be attached: an image the model sees (GIF, JPEG, PNG or WebP) may be at most ${violation.limit / 1024 / 1024} MiB. Attach a smaller copy.`
            : "These files cannot be attached together. Attach fewer, and send the rest in another message.",
        );
      }
      return files;
    });

    /**
     * Wakes the members a room `say` mentioned, unless the operator stopped
     * the work that spoke. Past the room's hop limit nobody is woken, and the
     * room shows one `chain-stopped` notice for the turn, however often it
     * tries; nobody is woken to hear of it either.
     */
    const routeMentions = Effect.fn("Speech.routeMentions")(function* (
      found: Pin,
      room: LiveRoom,
      message: MessageEntry,
      mention: ReadonlyArray<BotId>,
    ) {
      if (mention.length === 0) return null;
      const work = yield* workStopped(found);
      if (work.stopped) return null;
      // A chain that cannot be traced wakes nobody.
      const counted = yield* hopCount(found);
      if (counted === null) return { _tag: "untraced" } as const;
      const routed = yield* routing.botMessage({
        room,
        botId: found.botId,
        message,
        mention,
        hops: counted.hops,
        seq: work.seq,
      });
      if (routed._tag === "hop-limit" && !(yield* roomChainStopped(found))) {
        yield* notify(
          found.botId,
          { _tag: "room", roomId: room.id },
          { _tag: "chain-stopped", limit: "hops" },
          null,
        );
      }
      return routed._tag === "hop-limit" ? { ...routed, borrowed: counted.borrowed } : routed;
    });

    const say = Effect.fn("Speech.say")(function* (found: Pin, input: ToolInput<"say">) {
      // `to: "dm"` speaks to the operator in private, also from a room turn.
      const audience = input.to === "dm" ? conversation : found.audience;
      const given = input.mention ?? [];
      if (given.length > 0 && audience._tag !== "room") {
        return yield* new TurnToolRefused({
          reason:
            input.to === "dm"
              ? 'Nothing was sent: `mention` goes with a message to the room, not with `to: "dm"`.'
              : "Nothing was sent: `mention` works only in a room turn, and this turn speaks to your user.",
        });
      }
      const read = yield* workspaceFiles(found.botId, input.attachments ?? []);
      // The file lock, then the transaction: the order every writer of the
      // attachment store takes them in. Admission and publication stay one
      // transaction.
      return yield* attachments.withStore((put) =>
        once(
          "say",
          found,
        )(
          Effect.gen(function* () {
            const target = yield* requireTarget(found.botId, audience);
            const room = target._tag === "room" ? yield* roomOf(target.roomId) : Option.none();
            const mention = Option.isSome(room) ? yield* mentionedIn(found, room.value, given) : [];
            const files: Array<Attachment> = [];
            for (const file of read) {
              files.push(
                yield* put({ ...file, bot: found.botId }).pipe(
                  Effect.mapError(
                    () => new TurnToolRefused({ reason: `${file.name} cannot be attached.` }),
                  ),
                ),
              );
            }
            const entry = yield* entries.append({
              target,
              entry: {
                _tag: "message",
                author: { _tag: "bot", botId: found.botId },
                text: input.text,
                attachments: files,
                mentions: { _tag: "bots", ids: mention },
                delivery: { _tag: "delivered" },
                commandId: null,
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
            yield* spoken.said({
              sessionId: found.sessionId,
              botId: found.botId,
              entryId: entry.id,
              text: input.text,
            });
            const routed =
              Option.isSome(room) && entry._tag === "message"
                ? yield* routeMentions(found, room.value, entry, mention)
                : null;
            if (input.done === true) {
              for (const { id } of yield* deliveredBy(found))
                yield* ledger.closeDelivery(id, "done");
            }
            if (routed?._tag === "untraced") {
              return {
                status: "recorded",
                stopped: "untraced",
                note: "Your message is in the room, but nobody was woken: this turn started on its own, and what started it cannot be traced, so it may not wake members. Do not mention anyone again for it. If your user is waiting on it, say so in the room.",
              } satisfies Schema.Json;
            }
            if (routed?._tag === "hop-limit") {
              return {
                status: "recorded",
                stopped: "hops",
                note: `Your message is in the room, but nobody was woken: ${chainReached(routed.borrowed, "turns", routed.limit)} Do not mention anyone again for it. If your user is waiting on it, say so in the room.`,
              } satisfies Schema.Json;
            }
            return { status: "recorded" } satisfies Schema.Json;
          }),
        ),
      );
    });

    const ask = Effect.fn("Speech.ask")(function* (found: Pin, input: ToolInput<"ask">) {
      // An answer wakes the bot's main session, which never saw a routine's
      // question: a routine's turn says what it needs instead.
      const session = yield* purposeOf(found.sessionId).pipe(Effect.orDie);
      if (Option.isSome(session) && session.value.purpose === "side") {
        return yield* new TurnToolRefused({
          reason:
            "A routine runs where the operator cannot answer a question card. Put the question in your say message instead.",
        });
      }
      const options = input.options.map((option, index) => ({
        id: `option-${index + 1}`,
        label: option.label,
        description: option.description ?? null,
        style: option.style ?? ("default" as const),
      }));
      const values = Object.fromEntries(
        input.options.map((option, index) => [`option-${index + 1}`, option.value ?? null]),
      );
      return yield* once(
        "ask",
        found,
      )(
        Effect.gen(function* () {
          const target = yield* requireTarget(found.botId, found.audience);
          const card = yield* entries.append({
            target,
            entry: {
              _tag: "question",
              author: { _tag: "bot", botId: found.botId },
              origin: "ask",
              questions: [
                {
                  id: "question",
                  prompt: input.prompt,
                  options,
                  acceptsText: input.allow_custom ?? false,
                  multiple: input.multi_select ?? false,
                },
              ],
              status: { _tag: "pending" },
            },
          });
          const [origin] = yield* sql<{ readonly id: string }>`
            SELECT w.id FROM wakes w JOIN dispatches d ON d.id = w.dispatch_id
            WHERE d.session_id = ${found.sessionId} AND d.engine_turn_id = ${found.turnId}
            ORDER BY w.priority, w.rowid LIMIT 1
          `.pipe(Effect.orDie);
          const columns = audienceColumns(found.audience);
          yield* sql`
            INSERT INTO ask_cards (
              entry_id, origin_wake_id, audience, audience_room_id, option_values_json
            ) VALUES (
              ${card.id}, ${origin?.id ?? null}, ${columns.audience}, ${columns.roomId},
              ${yield* encodeValues(values).pipe(Effect.orDie)}
            )
          `.pipe(Effect.orDie);
          // The bot ends its turn after asking; the answer wakes it again.
          for (const { id } of yield* deliveredBy(found)) yield* ledger.closeDelivery(id, "ask");
          return {
            status: "asked",
            note: "Your user's answer arrives as your next turn. End this turn now.",
          } satisfies Schema.Json;
        }),
      );
    });

    /**
     * How the bot's last browser help card for the tab closed, when its
     * operator declined it or let it run out and has not written since, in
     * the bot's conversation or the room the request is for: the bot may not
     * ask again for that tab until they do. Its cards wait one at a time, so
     * the last one asked is the last one closed.
     */
    const lastUnanswered = (found: Pin, tab: EngineTabId) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: Schema.Struct({
          closing: Schema.NullOr(Schema.Literals(["done", "declined", "tab-closed", "timed-out"])),
        }),
        execute: () => sql`
          SELECT lu_card.closing FROM browser_help_cards lu_card
          JOIN entries lu_asked ON lu_asked.id = lu_card.entry_id
          WHERE lu_card.bot_id = ${found.botId} AND lu_card.engine_tab_id = ${tab}
            AND NOT EXISTS (
              SELECT 1 FROM entries lu_entry
              WHERE lu_entry.kind = 'message' AND lu_entry.author_kind = 'operator'
                AND lu_entry.seq > lu_card.closed_through_seq
                AND (
                  lu_entry.conversation_bot_id = ${found.botId}
                  ${found.audience._tag === "room" ? sql`OR lu_entry.room_id = ${found.audience.roomId}` : sql``}
                )
            )
          ORDER BY lu_asked.seq DESC
          LIMIT 1
        `,
      })(undefined).pipe(
        Effect.orDie,
        Effect.map(
          Option.flatMap(({ closing }) =>
            closing === "declined" || closing === "timed-out"
              ? Option.some(closing)
              : Option.none(),
          ),
        ),
      );

    /**
     * `request_browser_help` (`docs/architecture/server.md`, Browser help): a
     * `browser-help` card in the bot's own conversation for its front tab,
     * found here, never named by the bot. Like an `ask`, it ends the turn; the
     * operator's answer, or the card expiring, wakes the bot for the turn's
     * audience, in a turn of its own: once the card is in, the server stops
     * the turn that asked (`Stops.endTurn`), so it can do nothing more in the
     * browser meanwhile. A turn for a room tells the room the bot waits in
     * its own conversation. Refused, with nothing written, in a routine run,
     * with no tab open, for work the operator stopped, while another of the
     * bot's cards waits, and for the tab of a card the operator declined or
     * let run out, until they write again (`lastUnanswered`).
     */
    const requestBrowserHelp = Effect.fn("Speech.requestBrowserHelp")(function* (
      found: Pin,
      input: ToolInput<"request_browser_help">,
    ) {
      const session = yield* purposeOf(found.sessionId).pipe(Effect.orDie);
      if (Option.isSome(session) && session.value.purpose === "side") {
        return yield* new TurnToolRefused({
          reason:
            "Nothing was asked: a routine run cannot wait for your user to act in your browser. Say in your message what blocked the run.",
        });
      }
      return yield* once(
        "request_browser_help",
        found,
      )(
        Effect.gen(function* () {
          // Looked up here, after the pin: a retry of a request that went
          // through returns what it answered, whatever the tabs are now.
          const front = yield* browserTabs.front(found.botId);
          if (Option.isNone(front)) {
            return yield* new TurnToolRefused({
              reason:
                "Nothing was asked: you have no browser tab open, so there is nothing for your user to act on. Open the page in your browser first.",
            });
          }
          const tab = front.value;
          yield* requireTarget(found.botId, found.audience);
          const work = yield* workStopped(found);
          if (work.stopped) {
            return yield* new TurnToolRefused({
              reason: "Nothing was asked: your user stopped this work. Stop here.",
            });
          }
          const [waiting] = yield* sql`
            SELECT 1 FROM browser_help_cards WHERE bot_id = ${found.botId} AND closed_at IS NULL
          `.pipe(Effect.orDie);
          if (waiting !== undefined) {
            return yield* new TurnToolRefused({
              reason:
                "Nothing was asked: your user already has a request of yours for help in your browser. Their answer arrives as your next turn. End this turn now.",
            });
          }
          const unanswered = yield* lastUnanswered(found, tab.tab);
          if (Option.isSome(unanswered)) {
            return yield* new TurnToolRefused({
              reason:
                unanswered.value === "declined"
                  ? "Nothing was asked: your user already answered that they cannot do a step on this page. Do not ask again: tell them what it still blocks. Once they write to you, you may ask again."
                  : "Nothing was asked: your last request for help on this page went unanswered. Do not ask again: tell your user the task waits on that step. Once they write to you, you may ask again.",
            });
          }
          const card = yield* entries.append({
            target: { _tag: "conversation", botId: found.botId },
            entry: {
              _tag: "browser-help",
              author: { _tag: "bot", botId: found.botId },
              reason: input.reason,
              note: input.note,
              site: siteOf(tab.url),
              tab: tab.ref,
              status: { _tag: "pending" },
            },
          });
          const now = yield* DateTime.now;
          const columns = audienceColumns(found.audience);
          yield* sql`
            INSERT INTO browser_help_cards (
              entry_id, bot_id, audience, audience_room_id, origin_seq, engine_tab_id,
              expires_at, created_at
            ) VALUES (
              ${card.id}, ${found.botId}, ${columns.audience}, ${columns.roomId}, ${work.seq},
              ${tab.tab}, ${timeText(DateTime.addDuration(now, BROWSER_HELP_WAIT))},
              ${timeText(now)}
            )
          `.pipe(Effect.orDie);
          if (found.audience._tag === "room") {
            yield* notify(
              found.botId,
              found.audience,
              { _tag: "waiting-in-conversation", botId: found.botId },
              null,
            );
          }
          // The turn ends here, also for a bot that would go on in the
          // browser, which J3 Bots does not see: the server stops it once
          // this commits, and the answer wakes the bot again.
          for (const { id } of yield* deliveredBy(found)) yield* ledger.closeDelivery(id, "ask");
          yield* turnStops.endTurn(found.botId, {
            sessionId: found.sessionId,
            turnId: found.turnId,
            audience: found.audience,
          });
          return {
            status: "requested",
            note: BROWSER_HELP_REQUESTED,
          } satisfies Schema.Json;
        }),
      );
    });

    /**
     * A message to a teammate (`docs/architecture/server.md`, Teammate
     * messages): a handoff card in each of the two conversations, and an
     * urgent message's `bot` wake or a held one for the teammate's next
     * envelope, all in the transaction that pins the request. Refused, with
     * nothing written, for a recipient that is not a teammate, for work the
     * operator stopped, and past the fan-out limit; past the hop limit, the
     * refusal is stored with one quiet notice per turn in the sender's
     * conversation. A refusal never wakes anyone.
     */
    const messageBot = Effect.fn("Speech.messageBot")(function* (
      found: Pin,
      input: ToolInput<"message_bot">,
    ) {
      const refuse = (reason: string) => new TurnToolRefused({ reason });
      return yield* once(
        "message_bot",
        found,
      )(
        Effect.gen(function* () {
          const recipientId = Option.getOrNull(Schema.decodeOption(BotId)(input.to));
          if (recipientId === found.botId) {
            return yield* refuse(
              "That id is your own. Nothing was sent: `message_bot` reaches a teammate, by an id from `list_teammates`.",
            );
          }
          const recipient = recipientId === null ? Option.none() : yield* bots.find(recipientId);
          if (recipientId === null || Option.isNone(recipient)) {
            return yield* refuse(
              `No teammate has the id ${input.to}; they may have been deleted. Nothing was sent. \`list_teammates\` shows your teammates now.`,
            );
          }
          const work = yield* workStopped(found);
          if (work.stopped) {
            return yield* refuse("Your user stopped this work, so nothing was sent.");
          }
          const { budgets } = yield* settings.get;
          // Fan-out counts the teammates the turn's chain brings in: not when
          // the operator spoke in this turn, and not a teammate whose message
          // it answers.
          if (!(yield* operatorSpokeIn(found))) {
            const answered = yield* sendersCarried(found);
            const messaged = yield* messagedBy(found);
            const added = messaged.filter((id) => !answered.includes(id));
            if (
              !messaged.includes(recipientId) &&
              !answered.includes(recipientId) &&
              added.length >= budgets.fanOut
            ) {
              return yield* refuse(
                `Nothing was sent: unless your user spoke in this turn, it may bring in at most ${budgets.fanOut} ${budgets.fanOut === 1 ? "teammate" : "teammates"} besides those whose messages it answers, and it already has. If someone else needs to know, tell your user.`,
              );
            }
          }
          const counted = yield* hopCount(found);
          if (counted === null || counted.hops > budgets.hops) {
            if (!(yield* chainStopped(found))) {
              yield* notify(
                found.botId,
                conversation,
                { _tag: "chain-stopped", limit: "hops" },
                null,
              );
            }
            return {
              _tag: "refused",
              reason:
                counted === null
                  ? "Nothing was sent: this turn started on its own, and what started it cannot be traced, so it may not message teammates. Do not try again. If your user is waiting on it, tell them with `say`."
                  : `Nothing was sent: ${chainReached(counted.borrowed, "messages", budgets.hops)} Do not try again. If your user is waiting on it, tell them with \`say\`.`,
            } satisfies typeof StoredRefusal.Type;
          }
          const card = (target: EntryTarget, direction: "sent" | "received") =>
            entries.append({
              target,
              entry: {
                _tag: "handoff",
                author: { _tag: "bot", botId: found.botId },
                recipientId,
                direction,
                text: input.text,
                urgent: input.urgent,
                state: "sent",
              },
            });
          const sent = yield* card({ _tag: "conversation", botId: found.botId }, "sent");
          const received = yield* card({ _tag: "conversation", botId: recipientId }, "received");
          yield* sql`
            INSERT INTO handoffs (tool_call_id, recipient_bot_id, sent_entry_id, received_entry_id)
            VALUES (${found.requestId}, ${recipientId}, ${sent.id}, ${received.id})
          `.pipe(Effect.orDie);
          if (input.urgent) {
            yield* wakes.record([
              {
                botId: recipientId,
                kind: "bot",
                audience: conversation,
                payload: { _tag: "teammate", entryId: received.id },
                sourceEntryId: received.id,
                hops: counted.hops,
                retryOf: null,
                cause: {
                  _tag: "teammate",
                  senderId: found.botId,
                  audience: found.audience,
                  seq: work.seq,
                },
              },
            ]);
          } else {
            yield* sql`
              INSERT INTO held_messages (
                id, recipient_bot_id, sender_bot_id, handoff_entry_id, text, hops, created_at
              ) VALUES (
                ${yield* ids.make("held")}, ${recipientId}, ${found.botId}, ${received.id},
                ${input.text}, ${counted.hops}, ${timeText(received.createdAt)}
              )
            `.pipe(Effect.orDie);
          }
          return (
            input.urgent
              ? { status: "sent", note: "It wakes them now." }
              : { status: "held", note: "They read it at the start of their next turn." }
          ) satisfies Schema.Json;
        }),
      );
    });

    /**
     * `set_operator_name` (`docs/architecture/server.md`, Bot tools): saves
     * what the operator asked to be called, as Settings saves it, with an
     * `operator-named` notice where the turn speaks. Only a turn the operator
     * spoke in may (`operatorSpokeIn`), so a teammate, another member of a
     * room or a routine run cannot rename them through the bot. The name
     * they already have changes nothing.
     */
    const setOperatorName = Effect.fn("Speech.setOperatorName")(function* (
      found: Pin,
      input: ToolInput<"set_operator_name">,
    ) {
      // Checked before `once`, outside the transaction that saves: matching the
      // call already applied every engine event up to it, the turn's start
      // included, so the dispatches this reads are settled; and a refusal must
      // record no result, so a retried request is checked again.
      if (!(yield* operatorSpokeIn(found))) {
        return yield* new TurnToolRefused({
          reason:
            "Nothing was saved: only your user can say what they want to be called, in a message of theirs that this turn answers.",
        });
      }
      const changes = { operatorName: input.name };
      const result = yield* once(
        "set_operator_name",
        found,
      )(
        Effect.gen(function* () {
          const saved = { name: input.name } satisfies Schema.Json;
          if ((yield* settings.get).operatorName === input.name) return saved;
          // Only a time zone can be refused.
          yield* settingsService.save(changes).pipe(Effect.orDie);
          yield* notify(
            found.botId,
            found.audience,
            { _tag: "operator-named", botId: found.botId, name: input.name },
            null,
          );
          return saved;
        }),
      );
      yield* settingsService.applied(changes);
      return result;
    });

    /**
     * `request_credential` (`docs/architecture/server.md`, The vault): a
     * save-login card in the bot's own conversation, whatever audience the
     * turn speaks for, since only the operator types into it. Its values go
     * from the client to the vault; nothing of them reaches the bot.
     */
    const requestCredential = Effect.fn("Speech.requestCredential")(function* (
      found: Pin,
      input: ToolInput<"request_credential">,
    ) {
      const origin = siteOriginOf(input.origin);
      if (Option.isNone(origin)) {
        return yield* new TurnToolRefused({
          reason:
            "Nothing was shown: origin must be the http or https address of the page that asks for the login.",
        });
      }
      return yield* once(
        "request_credential",
        found,
      )(
        Effect.gen(function* () {
          const target = yield* requireTarget(found.botId, conversation);
          yield* entries.append({
            target,
            entry: {
              _tag: "credential-request",
              author: { _tag: "bot", botId: found.botId },
              origin: origin.value,
              note: input.note,
              status: { _tag: "pending" },
            },
          });
          return {
            status: "shown",
            note: "Your user saves the login from the card when they choose. Its values never reach you, and nothing wakes you when it is saved.",
          } satisfies Schema.Json;
        }),
      );
    });

    const encodeValues = Schema.encodeEffect(
      json(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
    );

    const store = Effect.fn("Speech.store")(function* (found: Pin, result: Schema.Json) {
      yield* sql`
        UPDATE tool_calls SET result_json = ${yield* encodeResult(result)}
        WHERE id = ${found.requestId}
      `;
    }, Effect.orDie);

    const apply = Effect.fn("TurnTools.apply")(function* (call: TurnToolCall) {
      // A forward retried under the same id returns what the first one did.
      const stored = yield* storedResult(keyOf(call)).pipe(Effect.orDie);
      if (Option.isSome(stored)) return stored.value.result_json;
      const matched = yield* match(call, call.caller, "open");
      if (matched._tag === "stored") return matched.result;
      const found = matched.pin;
      switch (call.tool) {
        case "say":
          return yield* say(found, call.input);
        case "ask":
          return yield* ask(found, call.input);
        case "request_browser_help":
          return yield* requestBrowserHelp(found, call.input);
        case "message_bot":
          return yield* messageBot(found, call.input);
        case "set_routine":
          return yield* setRoutine(found, call.input, once("set_routine", found));
        case "set_operator_name":
          return yield* setOperatorName(found, call.input);
        case "request_credential":
          return yield* requestCredential(found, call.input);
      }
    });

    const call = (request: TurnToolCall) => Effect.flatMap(apply(request), answer);

    /**
     * Admission has an end-to-end deadline: past it nothing was admitted (an
     * interrupted transaction commits nothing) and the bridge forwards the
     * request again, which returns the stored result if the admission did
     * commit.
     */
    const admitted = (request: TurnToolCall) =>
      call(request).pipe(
        Effect.timeoutOrElse({
          duration: ADMISSION_DEADLINE,
          orElse: () => Effect.fail(new TurnToolRetry()),
        }),
      );

    /**
     * Pins a fill to the engine's record of its call, as `once` pins a turn
     * tool's, in one transaction. The fill runs after, outside it: it holds
     * a tab for seconds. Its result is stored by `settleFill`.
     */
    const claimFill = Effect.fn("TurnTools.claimFill")(
      function* (fill: FillCall) {
        const stored = yield* storedResult(keyOf(fill)).pipe(Effect.orDie);
        if (Option.isSome(stored)) {
          return { _tag: "stored", result: stored.value.result_json } as const;
        }
        const matched = yield* match(fill, fill.caller, "open");
        if (matched._tag === "stored") return matched;
        const pinned = yield* transaction(pin("fill_credential", matched.pin));
        if (pinned._tag === "stored") return pinned;
        return {
          _tag: "claimed",
          turnId: matched.pin.turnId,
          stillOpen: stillAdmitted(matched.pin),
        } as const;
      },
      Effect.timeoutOrElse({
        duration: ADMISSION_DEADLINE,
        orElse: () => Effect.fail(new TurnToolRetry()),
      }),
    );

    const settleFill = Effect.fn("TurnTools.settleFill")(function* (fill: FillCall, result: Schema.Json) {
      yield* sql`
        UPDATE tool_calls SET result_json = ${yield* encodeResult(result)}
        WHERE id = ${fill.requestId} AND session_id = ${fill.caller.id}
          AND tool = 'fill_credential'
      `;
    }, Effect.orDie);


    /** Whether the request was claimed before, under its id, for its caller and its tool. */
    const claimedBefore = (call: ClaimedCall) =>
      sql`
        SELECT 1 FROM tool_calls
        WHERE id = ${call.requestId} AND session_id = ${call.caller.id} AND tool = ${call.tool}
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /**
     * A connector tool's call: matched as a turn tool's is, then claimed in a
     * transaction of its own, which commits before the connector is called,
     * so the call is made there once. Its answer is not stored (the operator's
     * data stays at the connector), so a forward of a request claimed before
     * cannot be answered again, and is cut off. The match has admission's
     * deadline, past which nothing was claimed and the bridge forwards the
     * request again; the claim, once begun, is not cut short by it, so a claim
     * that committed is always followed by the call.
     */
    const claimConnectorCall = Effect.fn("TurnTools.claimConnectorCall")(function* (call: ClaimedCall) {
      if (yield* claimedBefore(call)) return yield* new CallCutOff();
      const matched = yield* match(call, call.caller, "open-or-closed").pipe(
        Effect.timeoutOrElse({
          duration: ADMISSION_DEADLINE,
          orElse: () => Effect.fail(new TurnToolRetry()),
        }),
      );
      // Nothing is stored for a connector's call: only a claim made meanwhile.
      if (matched._tag === "stored") return yield* new CallCutOff();
      yield* transaction(
        Effect.gen(function* () {
          if (yield* claimedBefore(call)) return yield* new CallCutOff();
          yield* requireUnclaimed(matched.pin);
          yield* insertPin(call.tool, matched.pin);
        }),
      );
    });

    return TurnTools.of({ call: admitted, claimFill, settleFill, claimConnectorCall });
  }),
);
