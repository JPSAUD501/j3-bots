// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  BotId,
  Conflict,
  type ConnectorGlyph,
  type EntryTarget,
  MAX_ATTACHMENT_SIZE,
  MAX_VISUAL_BYTES,
  type MessageEntry,
  pairBotIds,
  ROOM_QUIET_ROUND,
  RoomId,
  siteOriginOf,
  type Visual,
  visualEscapesGuard,
  VisualHtml,
  VisualTitle,
} from "@j3-bots/contracts";
import {
  attachmentLimitViolation,
  type EngineTabId,
  SessionId,
  TurnId,
  toolInputDigest,
  ToolInputDigest,
} from "@j3-bots/engine-t3";
import {
  BROWSER_HELP_REQUESTED,
  MAX_BOTS_PER_REQUEST,
  SUGGESTION_REFUSED,
  SUGGESTION_SHOWN,
  type ToolInput,
} from "@j3-bots/prompts";
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
import { ConnectorStore } from "../connectors/ConnectorStore.ts";
import { ConnectorSources } from "../connectors/sources/Sources.ts";
import { fold, type OfferedService, offers, sameListing } from "../connectors/suggestions.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { type LiveRoom, liveRoom } from "../rooms/liveRoom.ts";
import { type BotMessageRouted, type BotWord, RoomRouting } from "../rooms/RoomRouting.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import {
  type FillCall,
  CallCutOff,
  type ClaimedCall,
  type CreateBotCall,
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
  SessionRowId,
} from "./model.ts";
import { notices } from "./notices.ts";
import { Observer } from "./Observer.ts";
import { Stops } from "./Stops.ts";
import { workStopped as workStoppedOf } from "./workStopped.ts";
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
const chainReached = (borrowed: boolean, limit: number) =>
  borrowed
    ? `this turn started on its own while background work that a chain of messages between bots started was still running in your session, so it counts as part of that chain, which reached your user's limit of ${limit} since they last spoke.`
    : `this chain of messages between bots reached your user's limit of ${limit} since they last spoke.`;

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

/**
 * Why a message the operator sent while a turn ran does not count in it
 * (`operatorSpokeIn`), and what the bot does instead.
 */
const LATE_WORD =
  "A message they sent while this turn was running does not count: if they asked for it there, tell them with `say` to ask again once you have finished.";
const storedRefusal = Schema.decodeUnknownOption(StoredRefusal);

/** The answer a stored result gives the bot: a refusal fails, anything else is the result. */
const answer = (result: Schema.Json) =>
  Option.match(storedRefusal(result), {
    onNone: () => Effect.succeed(result),
    onSome: ({ reason }) => Effect.fail(new TurnToolRefused({ reason })),
  });

/** What a connector suggestion offers, and with what glyph. */
interface Suggested extends OfferedService {
  readonly glyph: ConnectorGlyph | null;
}

/** What became of a bot's room message's wakes (`routeRoomMessage`). */
type RoutedRoomMessage = BotMessageRouted | null;

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

type SayVisual = NonNullable<ToolInput<"say">["visual"]>;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const decodeVisualHtml = Schema.decodeUnknownOption(VisualHtml);
const decodeVisualTitle = Schema.decodeUnknownOption(VisualTitle);

/** The turn tools a request is pinned for. */
type PinnedTool =
  | "say"
  | "ask"
  | "request_browser_help"
  | "message_bot"
  | "set_routine"
  | "set_operator_name"
  | "request_credential"
  | "fill_credential"
  | "suggest_connector"
  | "create_bot"
  | "start_room";

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
    const rooms = yield* Rooms;
    const changes = yield* ChangeLog;
    const settings = yield* SettingsStore;
    const settingsService = yield* SettingsService;
    const connectorStore = yield* ConnectorStore;
    const gallery = yield* ConnectorSources;
    const wakes = yield* Wakes;
    const browserTabs = yield* BrowserTabs;
    const ids = yield* Ids;
    const stoppedWork = workStoppedOf(sql);
    const turnStops = yield* Stops;
    const chains = hopCounts(sql);
    const { notify } = notices(sql, entries);
    const readWorkspaceFile = yield* workspaceReader;
    const targetOf = liveTarget(sql);
    const roomOf = liveRoom(sql);
    const spoken = routineSpeech(sql, ids, changes);
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
     * Whether the operator spoke in the pinned turn itself: what opened it was
     * the operator's, a message of theirs (sent again by a Retry or not) or
     * their answer to an `ask` card. A dismissed card says nothing, so the
     * wake it gives does not count. Neither does a steer riding the turn: the
     * engine tells whether the agent took it only once the turn has ended. A
     * steer the engine requeued as a turn of its own, or ran as one
     * (`new-turn`), opened that turn, and counts there. A continuation, or a
     * turn the engine started for a turn's background work, inherits no such
     * word: its chain's hops start again from the operator, but its fan-out
     * counts. So does the continuation of a steer the engine made a turn of
     * its own.
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
            JOIN entries os_source ON os_source.id = os_wake.source_entry_id
            WHERE os_dispatch.session_id = ${found.sessionId}
              AND os_dispatch.engine_turn_id = ${found.turnId}
              AND os_dispatch.status IN ('accepted', 'delivered', 'finished')
              AND os_turn.origin_turn_id IS NULL
              AND (
                os_dispatch.disposition IS NOT 'steered'
                OR os_dispatch.disposition_turn_id IS NOT os_dispatch.engine_turn_id
              )
              AND (
                os_source.author_kind = 'operator'
                OR (
                  json_extract(os_wake.payload_json, '$._tag') = 'answer'
                  AND json_extract(os_source.body_json, '$.status._tag') = 'answered'
                )
              )
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
     * Whether a Stop covers the pinned turn's work, of the bot or of
     * `audience` (the turn's own by default), and the dispatch that began it
     * (`workStopped`).
     */
    const workStopped = (found: Pin, audience: Audience = found.audience) =>
      stoppedWork({
        sessionId: found.sessionId,
        botId: found.botId,
        turnId: found.turnId,
        audience,
      });

    /**
     * Whether the operator stopped `roomId` after the pinned turn's chain
     * began: a room Stop recorded for the bot once its first turn had started.
     * It covers the chain's posts to the room whatever dispatch, if any, began
     * that work, as a turn the engine started on its own carries none.
     */
    const roomStoppedSince = (found: Pin, roomId: RoomId) =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ stopped: Schema.BooleanFromBit }),
        execute: () => sql`
          SELECT EXISTS (
            SELECT 1 FROM stops rs_stop
            WHERE rs_stop.bot_id = ${found.botId} AND rs_stop.scope = 'room'
              AND rs_stop.room_id = ${roomId} AND rs_stop.engine_turn_id IS NULL
              AND rs_stop.created_at > (
                SELECT MIN(rs_turn.started_at) FROM turns rs_turn
                WHERE rs_turn.session_id = ${found.sessionId}
                  AND rs_turn.engine_turn_id IN (${chainOf(found)})
              )
          ) AS stopped
        `,
      })(undefined).pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.stopped ?? false),
      );

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

    /**
     * The members a room `say` mentions, each once, checked against the room
     * in the caller's transaction. A refusal sends nothing.
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
     * The bot's workspace folder as provisioning resolved it: resolving
     * `workspacePath` now would follow a link the bot put in its folder's place.
     */
    const workspaceRootOf = Effect.fn("Speech.workspaceRootOf")(function* (botId: BotId) {
      const bot = yield* bots.find(botId);
      if (Option.isNone(bot)) return yield* new TurnEnded();
      if (Option.isNone(bot.value.workspaceRoot)) {
        return yield* new TurnToolRefused({
          reason: "Your workspace is not ready, so nothing can be attached or shown yet.",
        });
      }
      return bot.value.workspaceRoot.value;
    });

    /**
     * Reads the page a `say` shows from the bot's workspace, as
     * `workspaceFiles` reads a file: an `.html` file inside the workspace, at
     * most `MAX_VISUAL_BYTES`, of which no more than that is read, and UTF-8
     * text. It is kept as text and never run here; only a client's sandboxed
     * frame renders it.
     */
    const workspaceVisual = Effect.fn("Speech.workspaceVisual")(function* (
      botId: BotId,
      visual: SayVisual,
    ) {
      const refuse = (reason: string) => new TurnToolRefused({ reason });
      const given = visual.path;
      const title = Option.getOrUndefined(decodeVisualTitle(visual.title.trim()));
      if (title === undefined) return yield* refuse("Nothing was sent: the visual needs a title.");
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
        return yield* refuse(
          `Nothing was sent: ${given} is a URL. Save the page into your workspace first, then show its path.`,
        );
      }
      if (!/\.html?$/i.test(given)) {
        return yield* refuse(`Nothing was sent: ${given} is not an .html file.`);
      }
      const root = yield* workspaceRootOf(botId);
      const read = yield* readWorkspaceFile(root, given, MAX_VISUAL_BYTES);
      switch (read._tag) {
        case "missing":
          return yield* refuse(`Nothing was sent: there is no file at ${given} in your workspace.`);
        case "outside":
          return yield* refuse(
            `Nothing was sent: ${given} is outside your workspace. Save it under files/ first.`,
          );
        case "not-a-file":
          return yield* refuse(`Nothing was sent: ${given} is not a file.`);
        case "too-large":
          return yield* refuse(
            `Nothing was sent: ${given} is larger than ${MAX_VISUAL_BYTES / 1024} KB. Make the page smaller (fewer or smaller inlined images, less data), or attach it as a file.`,
          );
        case "unreadable":
          return yield* refuse(`Nothing was sent: ${given} could not be read.`);
        case "read": {
          const text = yield* Effect.try({
            try: () => strictUtf8.decode(read.bytes),
            catch: () => refuse(`Nothing was sent: ${given} is not UTF-8 text.`),
          });
          const html = Option.getOrUndefined(decodeVisualHtml(text));
          if (html === undefined)
            return yield* refuse(`Nothing was sent: ${given} has no content.`);
          if (visualEscapesGuard(html)) {
            return yield* refuse(
              `Nothing was sent: ${given} embeds another page (an <iframe>, <frame>, <object> or <embed>) or has a declarative shadow root (a shadowrootmode attribute), which a visual cannot hold. Draw everything in the page itself, and attach a shadow root from a script if you need one.`,
            );
          }
          return { title, html, height: visual.height ?? null } satisfies Visual;
        }
      }
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
      const root = yield* workspaceRootOf(botId);
      const refuse = (reason: string) => new TurnToolRefused({ reason });
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
     * Gives a bot's room message, a `say`, a `message_bot` to the room or a
     * kickoff, its round, and wakes the members it wakes
     * (`RoomRouting.botMessage`), unless the operator stopped the work that
     * spoke.
     */
    const routeRoomMessage = Effect.fn("Speech.routeRoomMessage")(function* (
      found: Pin,
      room: LiveRoom,
      message: MessageEntry,
      word: BotWord,
    ) {
      const work = yield* workStopped(found);
      return yield* routing.botMessage({
        room,
        botId: found.botId,
        turn: { sessionId: found.sessionId, turnId: found.turnId },
        message,
        word,
        seq: work.seq,
        stopped: work.stopped,
      });
    });

    /**
     * What the bot is told when a message it put in a room woke nobody, or
     * `null` when it woke the members it wakes.
     */
    const roomPosted = (routed: RoutedRoomMessage) =>
      routed?._tag === "quiet"
        ? ({
            status: "recorded",
            stopped: "room",
            note: `Your message is in the room, but nobody was woken: the bots here have answered each other for ${ROOM_QUIET_ROUND} rounds since your user last wrote, so the room waits for your user. Do not try to wake anyone for it again.`,
          } satisfies Schema.Json)
        : null;

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
      const shown =
        input.visual === undefined ? null : yield* workspaceVisual(found.botId, input.visual);
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
                ...(shown === null ? {} : { visual: shown }),
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
                ? yield* routeRoomMessage(found, room.value, entry, "bot")
                : null;
            if (input.done === true) {
              for (const { id } of yield* deliveredBy(found))
                yield* ledger.closeDelivery(id, "done");
            }
            return roomPosted(routed) ?? ({ status: "recorded" } satisfies Schema.Json);
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
          // Only the operator answers it, so its card waits in the bot's own
          // conversation, also from a room turn, as an engine request's does;
          // the room is told once a turn where to look. Its answer still
          // wakes the bot for the audience that asked.
          yield* requireTarget(found.botId, found.audience);
          const card = yield* entries.append({
            target: { _tag: "conversation", botId: found.botId },
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
          if (found.audience._tag === "room") {
            const told = yield* sql`
              SELECT 1 FROM engine_requests
              WHERE session_id = ${found.sessionId} AND engine_turn_id = ${found.turnId}
              LIMIT 1
            `.pipe(Effect.orDie);
            if (told.length === 0) {
              yield* notify(
                found.botId,
                found.audience,
                { _tag: "waiting-in-conversation", botId: found.botId },
                null,
              );
            }
          }
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
     * A message to a room the bot is a member of (`docs/architecture/server.md`,
     * Rooms), from a turn of any audience: posted there at once as the bot's,
     * and routed as a room `say` is, its `mention` checked against the room.
     * The first post of a turn the operator spoke in (`operatorSpokeIn`),
     * other than a turn of this room, is their request relayed, and is round
     * 0, once, as their own message there would be; any other post answers
     * the rounds before it. A turn of this room is left out because the
     * operator's message there already was their word. Refused, with nothing
     * written, for an archived room, one the bot is not in, and
     * work the operator stopped. `null` when no room has the id.
     */
    /**
     * Records that the pinned turn relays the operator's word to the room
     * (`room_relays`): `true` for its first post there, `false` once it has.
     */
    const firstRelay = (found: Pin, roomId: RoomId) =>
      sql<{ readonly room_id: string }>`
        INSERT INTO room_relays (room_id, session_id, engine_turn_id)
        VALUES (${roomId}, ${found.sessionId}, ${found.turnId})
        ON CONFLICT DO NOTHING
        RETURNING room_id
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    const messageRoom = Effect.fn("Speech.messageRoom")(function* (
      found: Pin,
      input: ToolInput<"message_bot">,
      roomId: RoomId,
    ) {
      const refuse = (reason: string) => new TurnToolRefused({ reason });
      const known = yield* rooms.find(roomId);
      if (Option.isNone(known)) return null;
      const room = known.value;
      if (input.urgent === true) {
        return yield* refuse(
          "Nothing was sent: `urgent` goes with a message to a teammate. In a room, the members you `mention` are woken.",
        );
      }
      if (room.status === "archived") {
        return yield* refuse(
          `Nothing was sent: the room ${room.name} is archived, so it takes no messages.`,
        );
      }
      if (!room.members.includes(found.botId)) {
        return yield* refuse(
          `Nothing was sent: you are not a member of the room ${room.name}. \`list_teammates\` shows the rooms you are in.`,
        );
      }
      const live = yield* roomOf(roomId);
      if (Option.isNone(live)) return yield* new Conflict({ reason: "room-archived" });
      const mention = yield* mentionedIn(found, live.value, input.mention ?? []);
      // A Stop of the room covers this turn's post there, whatever audience
      // the turn speaks for: it is recorded for every member, and covers the
      // work begun before it, by a dispatch or by the engine on its own.
      const there = { _tag: "room", roomId } as const;
      if (
        (yield* workStopped(found)).stopped ||
        (yield* workStopped(found, there)).stopped ||
        (yield* roomStoppedSince(found, roomId))
      ) {
        return yield* refuse("Your user stopped this work, so nothing was sent.");
      }
      const entry = yield* entries.append({
        target: { _tag: "room", roomId },
        entry: {
          _tag: "message",
          author: { _tag: "bot", botId: found.botId },
          text: input.text,
          attachments: [],
          mentions: { _tag: "bots", ids: mention },
          delivery: { _tag: "delivered" },
          commandId: null,
        },
      });
      yield* spoken.said({
        sessionId: found.sessionId,
        botId: found.botId,
        entryId: entry.id,
        text: input.text,
      });
      const inThisRoom = found.audience._tag === "room" && found.audience.roomId === roomId;
      const spoke = !inThisRoom && (yield* operatorSpokeIn(found));
      const word = spoke && (yield* firstRelay(found, roomId)) ? "relayed" : "bot";
      const routed =
        entry._tag === "message" ? yield* routeRoomMessage(found, live.value, entry, word) : null;
      const quiet = roomPosted(routed);
      // A turn from outside the room that the operator did not speak in may
      // carry a message of theirs steered into it, which does not count: they
      // are asked again, as the other tools that take only their word ask.
      if (quiet !== null && !inThisRoom && !spoke) {
        return { ...quiet, note: `${quiet.note} ${LATE_WORD}` };
      }
      return (
        quiet ??
        ({
          status: "posted",
          note: "It is in the room, and every member reads it in their next turn.",
        } satisfies Schema.Json)
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
     * conversation. A refusal never wakes anyone. A room's id posts in that
     * room instead (`messageRoom`).
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
          const roomId = Option.getOrNull(Schema.decodeOption(RoomId)(input.to));
          const posted = roomId === null ? null : yield* messageRoom(found, input, roomId);
          if (posted !== null) return posted;
          if (input.mention !== undefined) {
            return yield* refuse(
              "Nothing was sent: `mention` goes with a message to a room. A teammate reads your message whole.",
            );
          }
          const urgent = input.urgent === true;
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
                  : `Nothing was sent: ${chainReached(counted.borrowed, budgets.hops)} Do not try again. If your user is waiting on it, tell them with \`say\`.`,
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
                urgent,
                state: "sent",
              },
            });
          const sent = yield* card({ _tag: "conversation", botId: found.botId }, "sent");
          const received = yield* card({ _tag: "conversation", botId: recipientId }, "received");
          yield* sql`
            INSERT INTO handoffs (tool_call_id, recipient_bot_id, sent_entry_id, received_entry_id)
            VALUES (${found.requestId}, ${recipientId}, ${sent.id}, ${received.id})
          `.pipe(Effect.orDie);
          const [low, high] = pairBotIds(found.botId, recipientId);
          yield* sql`
            INSERT INTO pair_messages (
              pair_low, pair_high, sender_bot_id, recipient_bot_id, sent_entry_id, received_entry_id
            ) VALUES (${low}, ${high}, ${found.botId}, ${recipientId}, ${sent.id}, ${received.id})
          `.pipe(Effect.orDie);
          if (urgent) {
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
            urgent
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
          reason: `Nothing was saved: only your user can say what they want to be called, in a message of theirs that this turn answers. ${LATE_WORD}`,
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
     * The bots made for the operator's request the pinned turn answers, in the
     * order made: by its `create_bot` calls, and by those of every turn of the
     * bot that answered the same message or card before, as one that failed
     * and was retried. A Retry then goes on from the bots already made, to
     * `start_room`, instead of making a second set. The request is its source
     * entry, whatever kind of wake carried it: an operator's message in a
     * room is a `room` wake, and its Retry one too.
     */
    const madeForRequest = (found: Pin) =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ id: BotId }),
        execute: () => sql`
          SELECT json_extract(made.result_json, '$.id') AS id FROM tool_calls made
          WHERE made.tool = 'create_bot' AND made.result_json IS NOT NULL
            AND (
              (made.session_id = ${found.sessionId} AND made.engine_turn_id = ${found.turnId})
              OR EXISTS (
                SELECT 1 FROM dispatches earlier
                JOIN wakes earlier_wake ON earlier_wake.dispatch_id = earlier.id
                JOIN entries request ON request.id = earlier_wake.source_entry_id
                JOIN wakes here_wake ON here_wake.source_entry_id = earlier_wake.source_entry_id
                  AND here_wake.bot_id = earlier_wake.bot_id
                JOIN dispatches here ON here.id = here_wake.dispatch_id
                WHERE earlier.session_id = made.session_id
                  AND earlier.engine_turn_id = made.engine_turn_id
                  AND (
                    request.author_kind = 'operator'
                    OR (
                      json_extract(earlier_wake.payload_json, '$._tag') = 'answer'
                      AND json_extract(here_wake.payload_json, '$._tag') = 'answer'
                    )
                  )
                  AND here.session_id = ${found.sessionId}
                  AND here.engine_turn_id = ${found.turnId}
              )
            )
          ORDER BY made.created_at, made.rowid
        `,
      })(undefined).pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.id)),
      );

    /**
     * `create_bot` (`docs/architecture/server.md`, Bot tools): only in a turn
     * the operator spoke in (`operatorSpokeIn`), so a teammate, a room member
     * or a routine run cannot have bots made through the primary bot, and at
     * most `MAX_BOTS_PER_REQUEST` for one request of the operator's, counted
     * across the turns that answered it (`madeForRequest`). The call is pinned, and counted,
     * in the transaction that saves the bot (`MadeBy.claim`), whose hello waits
     * for this turn to end: `start_room` may still place it in a room.
     */
    const createBot = Effect.fn("Speech.createBot")(function* (found: Pin, call: CreateBotCall) {
      // Checked before the bot is saved, as for `set_operator_name`: matching
      // the call settled the turn's dispatches, and a refusal records nothing.
      if (!(yield* operatorSpokeIn(found))) {
        return yield* new TurnToolRefused({
          reason: `Nothing was created: only your user can ask for a new bot, in a message of theirs that this turn answers. ${LATE_WORD} If a teammate or a routine needs one, tell your user.`,
        });
      }
      const botId = yield* call.create({
        maker: found.botId,
        turn: { sessionId: found.sessionId, turnId: found.turnId },
        claim: Effect.fn("Speech.createBot.claim")(function* (id: BotId) {
          yield* requireUnclaimed(found);
          yield* requireTarget(found.botId, found.audience).pipe(
            Effect.catchTag(
              "Conflict",
              () =>
                new TurnToolRefused({
                  reason:
                    "Nothing was created: the room this turn speaks for was archived. Stop here.",
                }),
            ),
          );
          if ((yield* madeForRequest(found)).length >= MAX_BOTS_PER_REQUEST) {
            return yield* new TurnToolRefused({
              reason: `Nothing was created: one request of your user's may create at most ${MAX_BOTS_PER_REQUEST} bots, and this one has, in this turn or one that answered it before.`,
            });
          }
          yield* insertPin("create_bot", found);
          yield* store(found, { id });
        }),
      });
      return { id: botId } satisfies Schema.Json;
    });

    /**
     * `start_room` (`docs/architecture/server.md`, Rooms): only in a turn the
     * operator spoke in, as only the operator asks for a room. In the
     * transaction that pins the request it creates the room with the caller
     * as its first member, shows a `room-started` notice there and in the
     * caller's conversation, posts the kickoff as the caller's message, and
     * routes it as the operator's word, round 0 of the room's rounds, and
     * wakes the members it mentions, or every member when
     * it mentions none. A member this turn's `create_bot` made opens in the room: its
     * hello, which waits for this turn (`MadeBy`), is cancelled, and its
     * conversation shows a `made-for-room` notice instead.
     */
    const startRoom = Effect.fn("Speech.startRoom")(function* (
      found: Pin,
      input: ToolInput<"start_room">,
    ) {
      const refuse = (reason: string) => new TurnToolRefused({ reason });
      if (!(yield* operatorSpokeIn(found))) {
        return yield* refuse(
          `Nothing was started: only your user can ask for a room, in a message of theirs that this turn answers. ${LATE_WORD} If teammates should work on something together, tell your user.`,
        );
      }
      const members: Array<BotId> = [];
      for (const id of input.members) {
        const botId = Option.getOrNull(Schema.decodeOption(BotId)(id));
        if (botId === found.botId) {
          return yield* refuse(
            "Nothing was started: that id in `members` is your own. You join as the first member; list only your teammates.",
          );
        }
        if (botId === null) {
          return yield* refuse(
            `Nothing was started: no teammate has the id ${id}. \`list_teammates\` shows your teammates now.`,
          );
        }
        if (members.includes(botId)) {
          return yield* refuse(`Nothing was started: ${id} is in \`members\` more than once.`);
        }
        members.push(botId);
      }
      const mention: Array<BotId> = [];
      for (const id of input.mention ?? members) {
        const botId = Option.getOrNull(Schema.decodeOption(BotId)(id));
        if (botId === null || !members.includes(botId)) {
          return yield* refuse(
            `Nothing was started: ${id} in \`mention\` is not one of \`members\`. Mention only teammates who join.`,
          );
        }
        if (!mention.includes(botId)) mention.push(botId);
      }
      return yield* once(
        "start_room",
        found,
      )(
        Effect.gen(function* () {
          for (const botId of members) {
            if (Option.isNone(yield* bots.find(botId))) {
              return yield* refuse(
                `Nothing was started: no teammate has the id ${botId}; they may have been deleted. \`list_teammates\` shows your teammates now.`,
              );
            }
          }
          const work = yield* workStopped(found);
          if (work.stopped) {
            return yield* refuse("Your user stopped this work, so nothing was started.");
          }
          const room = yield* rooms
            .open({ name: input.name, members: [found.botId, ...members] })
            .pipe(
              Effect.catchTag("Invalid", () =>
                refuse("Nothing was started: a room holds two to six bots, you included."),
              ),
            );
          const notice = { _tag: "room-started", botId: found.botId, roomId: room.id } as const;
          yield* notify(found.botId, { _tag: "room", roomId: room.id }, notice, null);
          yield* notify(found.botId, conversation, notice, null);
          const kickoff = yield* entries.append({
            target: { _tag: "room", roomId: room.id },
            entry: {
              _tag: "message",
              author: { _tag: "bot", botId: found.botId },
              text: input.kickoff,
              attachments: [],
              mentions: { _tag: "bots", ids: mention },
              delivery: { _tag: "delivered" },
              commandId: null,
            },
          });
          const made = yield* madeForRequest(found);
          for (const botId of members.filter((id) => made.includes(id))) {
            const hello = yield* sql<{ readonly id: string }>`
              SELECT id FROM wakes
              WHERE bot_id = ${botId} AND status = 'pending'
                AND json_extract(payload_json, '$._tag') = 'first-run'
            `.pipe(Effect.orDie);
            yield* ledger.cancelWakes(hello.map((wake) => wake.id));
            yield* notify(
              botId,
              conversation,
              { _tag: "made-for-room", botId: found.botId, roomId: room.id },
              null,
            );
            yield* changes.touch({ _tag: "bot", botId });
          }
          const live = yield* roomOf(room.id);
          const routed =
            Option.isSome(live) && kickoff._tag === "message"
              ? yield* routeRoomMessage(found, live.value, kickoff, "kickoff")
              : null;
          const posted = roomPosted(routed);
          return {
            status: "started",
            id: room.id,
            note:
              posted?.note ??
              "The room is in your user's list, and the members the kickoff wakes answer it there. Tell your user what you set up.",
            ...(posted === null ? {} : { stopped: posted.stopped }),
          } satisfies Schema.Json;
        }),
      );
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

    /**
     * `suggest_connector` (`docs/architecture/server.md`, Connectors): a
     * connector card in the bot's own conversation, whatever audience the
     * turn speaks for, as a save-login card is. The bot names a service; it
     * is one of the operator's connectors the bot may not use yet, else an
     * entry of J3 Bots' curated gallery. No card is shown for a service the
     * bot can use already, nor for one a card of the bot's there still offers
     * or the operator said Not now to: that is final in this conversation.
     * The checks run in the transaction that writes the card, so two calls at
     * once show one card, and a refusal is stored, so a forward retried gives
     * it again.
     */
    const suggestConnector = Effect.fn("Speech.suggestConnector")(function* (
      found: Pin,
      input: ToolInput<"suggest_connector">,
    ) {
      return yield* once(
        "suggest_connector",
        found,
      )(
        Effect.gen(function* () {
          const refused = (reason: string) => ({ _tag: "refused", reason }) satisfies Schema.Json;
          // The card keeps the entry's English name: the server knows no
          // operator's language, and a client words a gallery card from its
          // listing. Only a variant's name (Linear with a key) differs by one.
          const listing = gallery.find(input.connector, "en");
          const variants = Option.match(listing, {
            onNone: () => [],
            onSome: (entry) => gallery.variants(entry.ref),
          });
          const wanted = fold(input.connector);
          const own = (yield* connectorStore.all).find(
            ({ name, slug, listing: from }) =>
              fold(name) === wanted ||
              slug === wanted ||
              (from !== null && variants.some((ref) => sameListing(from, ref))),
          );
          const suggested: Suggested | null =
            own !== undefined
              ? {
                  subject: { _tag: "connector", connectorId: own.id },
                  name: own.name,
                  glyph: own.glyph,
                  // The entries it came from, and those the bot named it by:
                  // one added by its address has none of its own.
                  listings: [
                    ...(own.listing === null ? [] : gallery.variants(own.listing)),
                    ...variants,
                  ],
                }
              : Option.match(listing, {
                  onNone: () => null,
                  onSome: (entry) => ({
                    subject: { _tag: "listing", ref: entry.ref },
                    name: entry.name,
                    glyph: entry.glyph,
                    listings: variants,
                  }),
                });
          if (suggested === null) return refused(SUGGESTION_REFUSED.unknown(input.connector));
          const { name } = suggested;
          if (
            own !== undefined &&
            (own.grant._tag === "all-bots" || own.grant.ids.includes(found.botId))
          ) {
            return refused(SUGGESTION_REFUSED.usable(name));
          }
          const target = yield* requireTarget(found.botId, conversation);
          const earlier = (yield* entries.ofKind(target, "connector-suggestion")).filter((card) =>
            offers(card, suggested),
          );
          // Named as the operator saw it on the earlier card.
          const declined = earlier.find((card) => card.status._tag === "dismissed");
          if (declined !== undefined) return refused(SUGGESTION_REFUSED.declined(declined.name));
          const waiting = earlier.find((card) => card.status._tag === "pending");
          if (waiting !== undefined) return refused(SUGGESTION_REFUSED.pending(waiting.name));
          yield* entries.append({
            target,
            entry: {
              _tag: "connector-suggestion",
              author: { _tag: "bot", botId: found.botId },
              subject: suggested.subject,
              name,
              glyph: suggested.glyph,
              reason: input.reason,
              status: { _tag: "pending" },
            },
          });
          return { status: "shown", note: SUGGESTION_SHOWN } satisfies Schema.Json;
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
        case "suggest_connector":
          return yield* suggestConnector(found, call.input);
        case "start_room":
          return yield* startRoom(found, call.input);
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
     * `create_bot`: matched as a turn tool is, under admission's deadline;
     * the bot is then saved with the call's pin (`createBot`), and opened
     * at the engine, which may take longer and is not cut short.
     */
    const createBotCall = Effect.fn("TurnTools.createBot")(function* (call: CreateBotCall) {
      const request = { ...call, tool: "create_bot" };
      const stored = yield* storedResult(keyOf(request)).pipe(Effect.orDie);
      if (Option.isSome(stored)) return stored.value.result_json;
      const matched = yield* match(request, call.caller, "open").pipe(
        Effect.timeoutOrElse({
          duration: ADMISSION_DEADLINE,
          orElse: () => Effect.fail(new TurnToolRetry()),
        }),
      );
      if (matched._tag === "stored") return matched.result;
      return yield* createBot(matched.pin, call);
    });

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

    const settleFill = Effect.fn("TurnTools.settleFill")(function* (
      fill: FillCall,
      result: Schema.Json,
    ) {
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
    const claimConnectorCall = Effect.fn("TurnTools.claimConnectorCall")(function* (
      call: ClaimedCall,
    ) {
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

    return TurnTools.of({
      call: admitted,
      createBot: createBotCall,
      claimFill,
      settleFill,
      claimConnectorCall,
    });
  }),
);
