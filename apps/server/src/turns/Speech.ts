// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Attachment,
  type BotId,
  Conflict,
  MAX_ATTACHMENT_SIZE,
  RoomId,
} from "@j3-bots/contracts";
import { SessionId, TurnId, toolInputDigest, ToolInputDigest } from "@j3-bots/engine-t3";
import type { ToolInput } from "@j3-bots/prompts";
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
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { RoomRouting } from "../rooms/RoomRouting.ts";
import {
  TurnEnded,
  type TurnToolCall,
  TurnToolRefused,
  TurnToolRetry,
  TurnTools,
  TurnToolUnavailable,
} from "../tools/TurnTools.ts";
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
import { Observer } from "./Observer.ts";

/**
 * The most bytes the files of one `say` take together. The operator's own
 * upload path has no total per message, so it is one upload's limit: a `say`
 * buffers at most this much, also on a small host.
 */
const MAX_SAY_ATTACHMENTS_SIZE = 25 * 1024 * 1024;

/** How many times a request is matched again after the first try, and within how long. */
const MATCH_RETRIES = 5;
const MATCH_WITHIN = Duration.seconds(2);

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
}

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
});

const StoredResult = Schema.Struct({ result_json: Schema.NullOr(json(Schema.Json)) });

const encodeResult = Schema.encodeEffect(json(Schema.Json));

/** A file a `say` attaches, read from the workspace and stored once the request is pinned. */
interface WorkspaceFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** The turn tools a request is pinned for. */
type PinnedTool = "say" | "ask" | "set_routine";

/**
 * The turn tools (`docs/architecture/server.md`, Bot tools): `say` and `ask`,
 * which speak, and `set_routine` (`routineTool.ts`). Each request is matched
 * to the engine's record of its call in the session's running admitted turn
 * and pinned to it, in the transaction that applies it, so a request acts
 * once, for the turn and the audience that made it. `message_bot` comes with
 * teammates in M3 (`docs/roadmap.md`).
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
    const readWorkspaceFile = yield* workspaceReader;
    const targetOf = liveTarget(sql);
    const spoken = routineSpeech(sql, yield* Ids, yield* ChangeLog);
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

    const storedResult = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: StoredResult,
      execute: (requestId) => sql`SELECT result_json FROM tool_calls WHERE id = ${requestId}`,
    });

    /** The oldest open call in the running admitted turn that matches and no request claimed. */
    const candidate = SqlSchema.findOneOption({
      Request: CallKey,
      Result: Candidate,
      execute: ({ sessionId, tool, digest }) => sql`
        SELECT c.engine_call_id, c.engine_turn_id, t.audience, t.audience_room_id
        FROM engine_tool_calls c
        JOIN sessions s ON s.id = c.session_id AND s.admitted_turn_id = c.engine_turn_id
        JOIN turns t ON t.session_id = c.session_id AND t.engine_turn_id = c.engine_turn_id
        WHERE c.session_id = ${sessionId} AND c.tool = ${tool} AND c.input_digest = ${digest}
          AND c.open = 1 AND t.finished_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM tool_calls p
            WHERE p.session_id = c.session_id AND p.engine_call_id = c.engine_call_id
          )
        ORDER BY c.seen_at, c.rowid
        LIMIT 1
      `,
    });

    /**
     * Brings the session's events up to the request, then looks for its call;
     * the engine records a call apart from the request, so it looks again a
     * bounded number of times.
     */
    const match = Effect.fn("Speech.match")(function* (call: TurnToolCall, caller: BotSession) {
      const sessionId = caller.id;
      const session = yield* engineSessionOf(sessionId).pipe(Effect.orDie);
      if (Option.isNone(session)) return yield* new TurnEnded();
      const digest = yield* toolInputDigest(call.arguments);
      const started = yield* DateTime.now;
      for (let attempt = 0; attempt <= MATCH_RETRIES; attempt++) {
        yield* observer.synchronize(sessionId, session.value.engine_session_id).pipe(
          Effect.catchTags({
            SessionNotFound: () => new TurnEnded(),
            // Nothing is pinned: the bridge forwards the request again.
            NotObserved: () => new TurnToolRetry(),
            EngineUnavailable: () => new TurnToolRetry(),
            EngineIndeterminate: () => new TurnToolRetry(),
            EngineIncompatible: () => new TurnToolRetry(),
          }),
        );
        const found = yield* candidate({ sessionId, tool: call.tool, digest }).pipe(Effect.orDie);
        if (Option.isSome(found)) {
          return {
            requestId: call.requestId,
            sessionId,
            botId: caller.botId,
            turnId: found.value.engine_turn_id,
            callId: found.value.engine_call_id,
            digest,
            audience: audienceOf(found.value),
          } satisfies Pin;
        }
        const elapsed = DateTime.distance(started, yield* DateTime.now);
        if (Duration.isGreaterThan(elapsed, MATCH_WITHIN)) break;
      }
      return yield* new TurnEnded();
    });

    /**
     * The call is still open in the session's admitted turn, with the
     * arguments it was matched by, and that turn has not finished.
     */
    const stillAdmitted = (found: Pin) =>
      sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM engine_tool_calls c
        JOIN sessions s ON s.id = c.session_id AND s.admitted_turn_id = c.engine_turn_id
        JOIN turns t ON t.session_id = c.session_id AND t.engine_turn_id = c.engine_turn_id
        WHERE c.session_id = ${found.sessionId} AND c.engine_call_id = ${found.callId}
          AND c.engine_turn_id = ${found.turnId} AND c.input_digest = ${found.digest}
          AND c.open = 1 AND t.finished_at IS NULL
          AND s.retired_at IS NULL AND s.lost_at IS NULL
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
      const stored = yield* storedResult(found.requestId).pipe(Effect.orDie);
      if (Option.isSome(stored) && stored.value.result_json !== null) {
        return { _tag: "stored", result: stored.value.result_json } as const;
      }
      const claimed = yield* sql`
        SELECT 1 FROM tool_calls WHERE session_id = ${found.sessionId}
          AND engine_call_id = ${found.callId}
      `.pipe(Effect.orDie);
      if (claimed.length > 0 || !(yield* stillAdmitted(found))) return yield* new TurnEnded();
      yield* requireTarget(found.botId, found.audience);
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
      return { _tag: "pinned" } as const;
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

    /** How far from the operator the wake behind the turn came. */
    const hopsOf = (found: Pin) =>
      sql<{ readonly hops: number | null }>`
        SELECT MAX(w.hops) AS hops FROM wakes w JOIN dispatches d ON d.id = w.dispatch_id
        WHERE d.session_id = ${found.sessionId} AND d.engine_turn_id = ${found.turnId}
      `.pipe(
        Effect.orDie,
        Effect.map(([row]) => row?.hops ?? 0),
      );

    /** Where the pinned turn's speech goes, unless its room was archived. */
    const requireTarget = Effect.fn("Speech.requireTarget")(function* (
      botId: BotId,
      audience: Audience,
    ) {
      const target = yield* targetOf(botId, audience);
      if (target === null) return yield* new Conflict({ reason: "room-archived" });
      return target;
    });

    /**
     * Reads the files a `say` attaches from the bot's workspace;
     * they are copied into the attachment store once the request is admitted,
     * so the operator can open them after the bot changes or removes its copy.
     * Paths outside the workspace, also by a link swapped in on the way, what
     * is not a regular file, empty files and files above
     * `MAX_ATTACHMENT_SIZE`, of which no more than that is read, are refused
     * (`readWorkspaceFile`), and so are files together above
     * `MAX_SAY_ATTACHMENTS_SIZE`, of which no more than that is read, and a
     * name the store would not take. Every file is checked before any is
     * stored.
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
      return files;
    });

    const say = Effect.fn("Speech.say")(function* (found: Pin, input: ToolInput<"say">) {
      // `to: "dm"` speaks to the operator in private, also from a room turn.
      const audience = input.to === "dm" ? conversation : found.audience;
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
                mentions: { _tag: "bots", ids: [] },
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
            if (target._tag === "room" && entry._tag === "message") {
              yield* routing.botMessage({
                roomId: target.roomId,
                botId: found.botId,
                message: entry,
                hops: yield* hopsOf(found),
              });
            }
            if (input.done === true) {
              for (const { id } of yield* deliveredBy(found))
                yield* ledger.closeDelivery(id, "done");
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

    const encodeValues = Schema.encodeEffect(
      json(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
    );

    const store = Effect.fn("Speech.store")(function* (found: Pin, result: Schema.Json) {
      yield* sql`
        UPDATE tool_calls SET result_json = ${yield* encodeResult(result)}
        WHERE id = ${found.requestId}
      `;
    }, Effect.orDie);

    const call = Effect.fn("TurnTools.call")(function* (call: TurnToolCall) {
      if (call.tool === "message_bot") return yield* new TurnToolUnavailable({ tool: call.tool });
      // A forward retried under the same id returns what the first one did.
      const stored = yield* storedResult(call.requestId).pipe(Effect.orDie);
      if (Option.isSome(stored) && stored.value.result_json !== null) {
        return stored.value.result_json;
      }
      const found = yield* match(call, call.caller);
      switch (call.tool) {
        case "say":
          return yield* say(found, call.input);
        case "ask":
          return yield* ask(found, call.input);
        case "set_routine":
          return yield* setRoutine(found, call.input, once("set_routine", found));
      }
    });

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

    return TurnTools.of({ call: admitted });
  }),
);
