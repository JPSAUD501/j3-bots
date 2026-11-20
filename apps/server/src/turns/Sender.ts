// SPDX-License-Identifier: AGPL-3.0-or-later
import { AttachmentId, type BotId } from "@j3-bots/contracts";
import {
  type DispatchAttachment,
  type DispatchInput,
  Engine,
  EngineAttachmentId,
  SessionId,
} from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Attachments } from "../attachments/Attachments.ts";
import { Entries } from "../entries/Entries.ts";
import { Layout } from "../Layout.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { type DispatchRow, keyOf, Ledger, type WakesAfter } from "./Ledger.ts";
import {
  type DispatchRowId,
  MAX_INDETERMINATE_ANSWERS,
  MAX_STAGING_FAILURES,
  RECOVERY_WINDOW,
  recoveryBackoff,
  type WakeFailure,
} from "./model.ts";
import { notices } from "./notices.ts";
import { Observer } from "./Observer.ts";
import { SessionGate } from "./SessionGate.ts";
import { Signals } from "./Signals.ts";

/** Where an operator's file is copied in the bot's workspace, relative to it. */
export const inboxPath = (attachment: { readonly id: AttachmentId; readonly name: string }) =>
  `files/inbox/${attachment.id}/${attachment.name.replaceAll(/[/\\]/g, "_")}`;

/** What a send learned. */
export type SendResult =
  /** The dispatch has an answer, or needs none from this send. */
  | "settled"
  /** Nothing was sent: the engine cannot take commands. Try again once it is ready. */
  | "engine-unavailable"
  /** No answer yet: the recovery tries again at `next_attempt_at`. */
  | "scheduled";

const FileRow = Schema.Struct({
  position: Schema.Int,
  attachment_id: AttachmentId,
  engine_attachment_id: Schema.NullOr(EngineAttachmentId),
  usable_until: Schema.NullOr(Time),
});

const SessionState = Schema.Struct({
  engine_session_id: Schema.NullOr(SessionId),
  gone: Schema.BooleanFromBit,
  stop_unsettled: Schema.BooleanFromBit,
});

const FenceRow = Schema.Struct({
  scope: Schema.Literals(["bot", "room"]),
  room_id: Schema.NullOr(Schema.String),
});

/** How staging a dispatch's files went. */
type Staging =
  | { readonly _tag: "staged"; readonly files: ReadonlyArray<DispatchAttachment> }
  /** The engine cannot take commands: nothing was staged, and nothing counts. */
  | { readonly _tag: "unavailable" }
  /** It failed, and may not next time. */
  | { readonly _tag: "failed" };

/**
 * Sends one dispatch to the engine, through its session's gate
 * (`docs/architecture/server.md`, 3. A dispatch is written before the engine
 * is called). A dispatch with no recorded attempt was never sent, so its send
 * is the first (`dispatch`, with the adapter's local checks); any other is a
 * recovery (`redispatch`, the same key and input with none).
 *
 * The attempt is claimed durably, after staging and right before the call, by
 * one conditional update: still undecided, unchanged since it was read, and
 * either sent for delivery into a session no Stop holds, or, once a Stop
 * fenced it, resent only to learn the answer for a key already sent. That
 * claim is what makes a send a send: a Stop recorded before it fences the
 * dispatch, which is then never sent; one recorded after it finds the attempt
 * and waits for its answer. Every answer is recorded against the dispatch as
 * it stands then, so a fence that landed during the call decides where its
 * wakes go.
 */
export class Sender extends Context.Service<
  Sender,
  {
    /**
     * Sends a dispatch for delivery, unless a Stop fenced it or a Stop of its
     * session is unsettled; a fenced dispatch whose answer was lost is resent
     * only to learn the answer for its key (step 2 of a Stop).
     */
    readonly send: (dispatchId: DispatchRowId) => Effect.Effect<SendResult>;
  }
>()("@j3-bots/server/turns/Sender") {}

export const layer = Layer.effect(
  Sender,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const engine = yield* Engine;
    const ledger = yield* Ledger;
    const gate = yield* SessionGate;
    const signals = yield* Signals;
    const observer = yield* Observer;
    const attachments = yield* Attachments;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { sessionLost } = notices(sql, yield* Entries);

    const files = SqlSchema.findAll({
      Request: Schema.String,
      Result: FileRow,
      execute: (id) => sql`
        SELECT position, attachment_id, engine_attachment_id, usable_until
        FROM dispatch_attachments WHERE dispatch_id = ${id} ORDER BY position
      `,
    });

    const sessionState = SqlSchema.findOne({
      Request: Schema.String,
      Result: SessionState,
      execute: (sessionId) => sql`
        SELECT s.engine_session_id, (s.retired_at IS NOT NULL OR s.lost_at IS NOT NULL) AS gone,
          EXISTS (
            SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL
          ) AS stop_unsettled
        FROM sessions s WHERE s.id = ${sessionId}
      `,
    });

    const fenceOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: FenceRow,
      execute: (stopId) => sql`SELECT scope, room_id FROM stops WHERE id = ${stopId}`,
    });

    /**
     * Whether the Stop that fenced the dispatch stopped what it was for: every
     * one of a bot Stop, and a room Stop's own room. A room's Stop also fences
     * private work in a member's session, which the operator did not stop.
     */
    const stoppedByFence = Effect.fn("Sender.stoppedByFence")(function* (row: DispatchRow) {
      if (row.fenced_by_stop_id === null) return false;
      const fence = yield* fenceOf(row.fenced_by_stop_id).pipe(Effect.orDie);
      if (Option.isNone(fence) || fence.value.scope === "bot") return true;
      return row.audience === "room" && row.audience_room_id === fence.value.room_id;
    });

    /** The engine certainly applied nothing: the wakes wait again, unless the operator stopped them. */
    const unsentWakes = (row: DispatchRow) =>
      Effect.map(stoppedByFence(row), (stopped): WakesAfter =>
        stopped ? { _tag: "cancelled" } : { _tag: "pending" },
      );

    /**
     * It may have been sent, and will not be delivered: the wakes fail with
     * the real reason, visibly and retryable, unless the operator stopped
     * them. They never wait again.
     */
    const sentWakes = (row: DispatchRow, reason: WakeFailure) =>
      Effect.map(stoppedByFence(row), (stopped): WakesAfter =>
        stopped ? { _tag: "cancelled" } : { _tag: "failed", reason },
      );

    /** Reads the dispatch as it stands now, inside the result's transaction. */
    const current = Effect.fn("Sender.current")(function* (dispatchId: DispatchRowId) {
      return yield* ledger.find(dispatchId);
    });

    const releaseUnsent = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* current(dispatchId);
          if (Option.isNone(row)) return;
          yield* ledger.release(dispatchId, yield* unsentWakes(row.value));
        }),
      );

    const failSent = (dispatchId: DispatchRowId, reason: "rejected" | "unresolved") =>
      transaction(
        Effect.gen(function* () {
          const row = yield* current(dispatchId);
          if (Option.isNone(row)) return;
          yield* ledger.fail(dispatchId, reason, yield* sentWakes(row.value, reason));
        }),
      );

    /** The claimed attempt was never sent: it is given back, and a fenced dispatch is released. */
    const notSent = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE dispatches SET attempts = attempts - 1
            WHERE id = ${dispatchId} AND status = 'intended' AND attempts > 0
          `.pipe(Effect.orDie);
          const row = yield* current(dispatchId);
          if (
            Option.isSome(row) &&
            row.value.attempts === 0 &&
            row.value.fenced_by_stop_id !== null
          ) {
            yield* ledger.release(dispatchId, yield* unsentWakes(row.value));
          }
          return "engine-unavailable" as const;
        }),
      );

    /** The answer was lost: counted, and the dispatch fails once the bound is reached. */
    const undecided = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* current(dispatchId);
          if (Option.isNone(row) || row.value.status !== "intended") return "settled" as const;
          const answers = row.value.indeterminate_answers + 1;
          if (answers >= MAX_INDETERMINATE_ANSWERS) {
            yield* ledger.fail(dispatchId, "unresolved", yield* sentWakes(row.value, "unresolved"));
            return "settled" as const;
          }
          const next = DateTime.addDuration(yield* DateTime.now, recoveryBackoff(answers));
          yield* sql`
            UPDATE dispatches SET indeterminate_answers = ${answers},
              next_attempt_at = ${timeText(next)}
            WHERE id = ${dispatchId}
          `.pipe(Effect.orDie);
          return "scheduled" as const;
        }),
      );

    /**
     * Staging failed: tried again with backoff, and after the bound the
     * dispatch fails. Nothing was sent by this send, so a first send fails as
     * `rejected`; a recovery, whose key went out before, as `unresolved`.
     */
    const stagingFailed = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* current(dispatchId);
          if (Option.isNone(row) || row.value.status !== "intended") return "settled" as const;
          const failures = row.value.staging_failures + 1;
          if (failures >= MAX_STAGING_FAILURES) {
            if (row.value.attempts === 0) {
              yield* ledger.fail(dispatchId, "rejected", yield* sentWakes(row.value, "rejected"));
            } else {
              yield* ledger.fail(
                dispatchId,
                "unresolved",
                yield* sentWakes(row.value, "unresolved"),
              );
            }
            return "settled" as const;
          }
          const next = DateTime.addDuration(yield* DateTime.now, recoveryBackoff(failures));
          yield* sql`
            UPDATE dispatches SET staging_failures = ${failures}, next_attempt_at = ${timeText(next)}
            WHERE id = ${dispatchId}
          `.pipe(Effect.orDie);
          return "scheduled" as const;
        }),
      );

    const copyToWorkspace = Effect.fn("Sender.copyToWorkspace")(function* (
      botId: BotId,
      attachment: { readonly id: AttachmentId; readonly name: string },
      source: string,
    ) {
      const target = path.join(layout.workspace(botId), inboxPath(attachment));
      if (yield* fs.exists(target)) return;
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.copyFile(source, target);
    });

    /**
     * Each file staged and still usable, staging again those whose staged copy
     * expired, and copied into the bot's workspace where its envelope names it.
     */
    const stage = Effect.fn("Sender.stage")(function* (row: DispatchRow) {
      const now = yield* DateTime.now;
      const staged: Array<DispatchAttachment> = [];
      for (const file of yield* files(row.id).pipe(Effect.orDie)) {
        const stored = yield* attachments.open(file.attachment_id);
        // A file the store no longer has cannot be sent, now or later.
        if (Option.isNone(stored)) return { _tag: "failed" } satisfies Staging;
        const { attachment } = stored.value;
        const copied = yield* copyToWorkspace(row.bot_id, attachment, stored.value.path).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Copying a dispatched file into the workspace failed", error).pipe(
              Effect.as(false),
            ),
          ),
        );
        if (!copied) return { _tag: "failed" } satisfies Staging;
        let stagedId = file.engine_attachment_id;
        if (
          stagedId === null ||
          file.usable_until === null ||
          DateTime.isLessThan(file.usable_until, now)
        ) {
          const fresh = yield* engine
            .stageAttachment({
              name: attachment.name,
              mediaType: attachment.mediaType,
              size: attachment.size,
              path: stored.value.path,
            })
            .pipe(
              Effect.map((value) => ({ _tag: "ok", value }) as const),
              Effect.catchTags({
                EngineUnavailable: () => Effect.succeed({ _tag: "unavailable" } as const),
                EngineIncompatible: () => Effect.succeed({ _tag: "unavailable" } as const),
                EngineIndeterminate: () => Effect.succeed({ _tag: "failed" } as const),
              }),
            );
          if (fresh._tag !== "ok") return fresh satisfies Staging;
          yield* sql`
            UPDATE dispatch_attachments
            SET engine_attachment_id = ${fresh.value.id},
              usable_until = ${timeText(fresh.value.usableUntil)}
            WHERE dispatch_id = ${row.id} AND position = ${file.position}
          `.pipe(Effect.orDie);
          stagedId = fresh.value.id;
        }
        staged.push({
          stagedId,
          name: attachment.name,
          mediaType: attachment.mediaType,
          size: attachment.size,
        });
      }
      return { _tag: "staged", files: staged } satisfies Staging;
    });

    const inputOf = (
      row: DispatchRow,
      sessionId: SessionId,
      staged: ReadonlyArray<DispatchAttachment>,
    ) =>
      ({
        key: keyOf(row.id),
        sessionId,
        text: row.envelope,
        attachments: staged,
        delivery:
          row.delivery === "steer" && row.steer_turn_id !== null
            ? { _tag: "steer", turnId: row.steer_turn_id }
            : { _tag: "start", freshContext: row.fresh_context },
      }) satisfies DispatchInput;

    /**
     * The send's claim: the attempt is counted only if the dispatch is still
     * what was read, and still sendable. Whether it was claimed.
     */
    const claim = Effect.fn("Sender.claim")(function* (row: DispatchRow) {
      const at = timeText(yield* DateTime.now);
      const claimed = yield* sql<{ readonly attempts: number }>`
        UPDATE dispatches SET attempts = attempts + 1, updated_at = ${at}
        WHERE id = ${row.id} AND status = 'intended' AND attempts = ${row.attempts}
          AND (
            (
              fenced_by_stop_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM stop_targets t
                WHERE t.session_id = dispatches.session_id AND t.stopped_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM sessions s WHERE s.id = dispatches.session_id
                  AND (s.retired_at IS NOT NULL OR s.lost_at IS NOT NULL)
              )
            )
            OR (fenced_by_stop_id IS NOT NULL AND attempts > 0)
          )
        RETURNING attempts
      `.pipe(Effect.orDie);
      return claimed.length > 0;
    });

    const sendInGate = Effect.fn("Sender.sendInGate")(function* (dispatchId: DispatchRowId) {
      const found = yield* ledger.find(dispatchId);
      if (Option.isNone(found) || found.value.status !== "intended") return "settled" as const;
      const row = found.value;
      const session = yield* sessionState(row.session_id).pipe(Effect.orDie);
      const fenced = row.fenced_by_stop_id !== null;
      // A fenced dispatch never sent was released with its fence; a Stop of
      // the session holds every other one.
      if (fenced ? row.attempts === 0 : session.stop_unsettled) return "settled" as const;
      const firstSend = row.attempts === 0;

      // Ends with no answer: its session is gone, or the day's bound passed.
      const expired = DateTime.isLessThan(
        DateTime.addDuration(row.created_at, RECOVERY_WINDOW),
        yield* DateTime.now,
      );
      if (session.gone || session.engine_session_id === null || (!firstSend && expired)) {
        if (firstSend) yield* releaseUnsent(row.id);
        else yield* failSent(row.id, "unresolved");
        return "settled" as const;
      }
      const sessionId = session.engine_session_id;

      const staging = yield* stage(row);
      if (staging._tag === "unavailable") return "engine-unavailable" as const;
      if (staging._tag === "failed") return yield* stagingFailed(row.id);
      const input = inputOf(row, sessionId, staging.files);

      if (!(yield* claim(row))) return "settled" as const;

      if (firstSend) {
        return yield* engine.dispatch(input).pipe(
          Effect.flatMap((disposition) =>
            transaction(ledger.accept(row.id, disposition)).pipe(Effect.as("settled" as const)),
          ),
          Effect.catchTags({
            // Refused before anything was sent.
            SessionBusy: () => releaseUnsent(row.id).pipe(Effect.as("settled" as const)),
            SessionNotFound: () =>
              transaction(Effect.andThen(sessionLost(row.session_id), releaseUnsent(row.id))).pipe(
                Effect.as("settled" as const),
              ),
            DispatchRejected: () =>
              failSent(row.id, "rejected").pipe(Effect.as("settled" as const)),
            EngineUnavailable: () => notSent(row.id),
            EngineIncompatible: () => notSent(row.id),
            EngineIndeterminate: () => undecided(row.id),
          }),
        );
      }
      return yield* engine.redispatch(input).pipe(
        Effect.flatMap(() =>
          transaction(ledger.accept(row.id, null)).pipe(Effect.as("settled" as const)),
        ),
        Effect.catchTags({
          DispatchRejected: () => failSent(row.id, "rejected").pipe(Effect.as("settled" as const)),
          // While the engine is unreachable the recovery waits, and counts nothing.
          EngineUnavailable: () => notSent(row.id),
          EngineIncompatible: () => notSent(row.id),
          EngineIndeterminate: () => undecided(row.id),
        }),
      );
    });

    const send = Effect.fn("Sender.send")(function* (dispatchId: DispatchRowId) {
      const found = yield* ledger.find(dispatchId);
      if (Option.isNone(found)) return "settled" as const;
      // Nothing is sent into a session before its events are followed and
      // their first snapshot or cursor is committed.
      if (!(yield* observer.ready(found.value.session_id))) return "engine-unavailable" as const;
      const result = yield* gate.run(found.value.session_id)(sendInGate(dispatchId));
      // The session's state changed, or a Stop may now proceed.
      yield* signals.dispatch.fire;
      yield* signals.stops.fire;
      if (result === "scheduled") yield* signals.recovery.fire;
      return result;
    });

    return Sender.of({ send });
  }),
);
