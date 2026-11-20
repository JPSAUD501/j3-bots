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
import { Layout } from "../Layout.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { type DispatchRow, keyOf, Ledger, type WakesAfter } from "./Ledger.ts";
import { MAX_INDETERMINATE_ANSWERS, RECOVERY_WINDOW, recoveryBackoff } from "./model.ts";
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
  /** Sent, and the answer was lost: the recovery tries again at `next_attempt_at`. */
  | "undecided";

const FileRow = Schema.Struct({
  position: Schema.Int,
  attachment_id: AttachmentId,
  engine_attachment_id: Schema.NullOr(EngineAttachmentId),
  usable_until: Schema.NullOr(Time),
});

const SessionState = Schema.Struct({
  engine_session_id: Schema.NullOr(SessionId),
  retired: Schema.BooleanFromBit,
  stop_unsettled: Schema.BooleanFromBit,
});

/**
 * Sends one dispatch to the engine, through its session's gate
 * (`docs/architecture/server.md`, 3. A dispatch is written before the engine
 * is called). A dispatch with no recorded attempt was never sent, so its send
 * is the first (`dispatch`, with the adapter's local checks); any other is a
 * recovery (`redispatch`, the same key and input with none). The attempt is
 * counted durably before the call, so a crash during it leaves a dispatch the
 * server recovers, never one it sends again as new.
 */
export class Sender extends Context.Service<
  Sender,
  {
    /**
     * `deliver` sends a dispatch for delivery, unless a Stop fenced it or a
     * Stop of its session is unsettled. `settle` recovers a fenced dispatch
     * whose answer was lost, only to learn the answer for its key before the
     * Stop's round (step 2 of a Stop).
     */
    readonly send: (dispatchId: string, purpose: "deliver" | "settle") => Effect.Effect<SendResult>;
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
    const attachments = yield* Attachments;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

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
        SELECT s.engine_session_id, s.retired_at IS NOT NULL AS retired,
          EXISTS (
            SELECT 1 FROM stop_targets t WHERE t.session_id = s.id AND t.stopped_at IS NULL
          ) AS stop_unsettled
        FROM sessions s WHERE s.id = ${sessionId}
      `,
    });

    /** What a fenced dispatch's wakes become when it ends undelivered. */
    const fencedWakes = Effect.fn("Sender.fencedWakes")(function* (row: DispatchRow) {
      if (row.fenced_by_stop_id === null) return { _tag: "failed", reason: "rejected" } as const;
      const [stop] = yield* sql<{ readonly scope: "bot" | "room" }>`
        SELECT scope FROM stops WHERE id = ${row.fenced_by_stop_id}
      `.pipe(Effect.orDie);
      // A room's Stop did not stop private work: those wakes may go again.
      return stop?.scope === "room" && row.audience === "conversation"
        ? ({ _tag: "pending" } as const)
        : ({ _tag: "cancelled" } as const);
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
        if (Option.isNone(stored)) return yield* Effect.die("A dispatched file is stored");
        const { attachment } = stored.value;
        yield* copyToWorkspace(row.bot_id, attachment, stored.value.path);
        let stagedId = file.engine_attachment_id;
        if (
          stagedId === null ||
          file.usable_until === null ||
          DateTime.isLessThan(file.usable_until, now)
        ) {
          const fresh = yield* engine.stageAttachment({
            name: attachment.name,
            mediaType: attachment.mediaType,
            size: attachment.size,
            path: stored.value.path,
          });
          yield* sql`
            UPDATE dispatch_attachments
            SET engine_attachment_id = ${fresh.id}, usable_until = ${timeText(fresh.usableUntil)}
            WHERE dispatch_id = ${row.id} AND position = ${file.position}
          `.pipe(Effect.orDie);
          stagedId = fresh.id;
        }
        staged.push({
          stagedId,
          name: attachment.name,
          mediaType: attachment.mediaType,
          size: attachment.size,
        });
      }
      return staged;
    });

    const copyToWorkspace = Effect.fn("Sender.copyToWorkspace")(function* (
      botId: BotId,
      attachment: { readonly id: AttachmentId; readonly name: string },
      source: string,
    ) {
      const target = path.join(layout.workspace(botId), inboxPath(attachment));
      if (yield* fs.exists(target)) return;
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.copyFile(source, target);
    }, Effect.orDie);

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

    /** The send's answer was lost: count it, and fail the dispatch once the bound is reached. */
    const undecided = Effect.fn("Sender.undecided")(function* (row: DispatchRow) {
      const answers = row.indeterminate_answers + 1;
      const next = DateTime.addDuration(yield* DateTime.now, recoveryBackoff(answers));
      return yield* transaction(
        Effect.gen(function* () {
          if (answers >= MAX_INDETERMINATE_ANSWERS) {
            yield* ledger.fail(row.id, "unresolved", yield* unresolvedWakes(row));
            return "settled" as const;
          }
          yield* sql`
            UPDATE dispatches SET indeterminate_answers = ${answers},
              next_attempt_at = ${timeText(next)}
            WHERE id = ${row.id}
          `;
          return "undecided" as const;
        }),
      ).pipe(Effect.orDie);
    });

    const unresolvedWakes = (row: DispatchRow) =>
      row.fenced_by_stop_id === null
        ? Effect.succeed<WakesAfter>({ _tag: "failed", reason: "unresolved" })
        : fencedWakes(row);

    const sendInGate = Effect.fn("Sender.sendInGate")(function* (
      dispatchId: string,
      purpose: "deliver" | "settle",
    ) {
      const found = yield* ledger.find(dispatchId);
      if (Option.isNone(found) || found.value.status !== "intended") return "settled" as const;
      const row = found.value;
      const session = yield* sessionState(row.session_id).pipe(Effect.orDie);
      const fenced = row.fenced_by_stop_id !== null;
      if (purpose === "deliver" && (fenced || session.stop_unsettled)) return "settled" as const;
      if (purpose === "settle" && (!fenced || row.attempts === 0)) return "settled" as const;
      const firstSend = row.attempts === 0;

      // Ends with no answer: its session is gone, or the day's bound passed.
      const expired = DateTime.isLessThan(
        DateTime.addDuration(row.created_at, RECOVERY_WINDOW),
        yield* DateTime.now,
      );
      if (session.retired || session.engine_session_id === null || (!firstSend && expired)) {
        yield* transaction(
          firstSend
            ? ledger.release(row.id, { _tag: "pending" })
            : Effect.flatMap(unresolvedWakes(row), (wakes) =>
                ledger.fail(row.id, "unresolved", wakes),
              ),
        );
        return "settled" as const;
      }
      const sessionId = session.engine_session_id;

      const staged = yield* stage(row).pipe(Effect.option);
      if (Option.isNone(staged)) return "engine-unavailable" as const;
      const input = inputOf(row, sessionId, staged.value);

      yield* sql`UPDATE dispatches SET attempts = attempts + 1 WHERE id = ${row.id}`.pipe(
        Effect.orDie,
      );

      if (firstSend) {
        return yield* engine.dispatch(input).pipe(
          Effect.flatMap((disposition) =>
            transaction(ledger.accept(row.id, disposition)).pipe(Effect.as("settled" as const)),
          ),
          Effect.catchTags({
            SessionBusy: () =>
              transaction(ledger.release(row.id, { _tag: "pending" })).pipe(
                Effect.as("settled" as const),
              ),
            // The session is gone: its wakes wait for the bot's next one.
            SessionNotFound: () =>
              transaction(ledger.release(row.id, { _tag: "pending" })).pipe(
                Effect.as("settled" as const),
              ),
            DispatchRejected: () =>
              transaction(
                Effect.flatMap(
                  fenced
                    ? fencedWakes(row)
                    : Effect.succeed<WakesAfter>({ _tag: "failed", reason: "rejected" }),
                  (wakes) => ledger.fail(row.id, "rejected", wakes),
                ),
              ).pipe(Effect.as("settled" as const)),
            // Not sent: the attempt did not happen.
            EngineUnavailable: () => notSent(row.id),
            EngineIncompatible: () => notSent(row.id),
            EngineIndeterminate: () => undecided(row),
          }),
        );
      }
      return yield* engine.redispatch(input).pipe(
        Effect.flatMap(() =>
          transaction(ledger.accept(row.id, null)).pipe(Effect.as("settled" as const)),
        ),
        Effect.catchTags({
          DispatchRejected: () =>
            transaction(
              Effect.flatMap(
                fenced
                  ? fencedWakes(row)
                  : Effect.succeed<WakesAfter>({ _tag: "failed", reason: "rejected" }),
                (wakes) => ledger.fail(row.id, "rejected", wakes),
              ),
            ).pipe(Effect.as("settled" as const)),
          // While the engine is unreachable the recovery waits, and counts nothing.
          EngineUnavailable: () => Effect.succeed("engine-unavailable" as const),
          EngineIncompatible: () => Effect.succeed("engine-unavailable" as const),
          EngineIndeterminate: () => undecided(row),
        }),
      );
    });

    const notSent = (dispatchId: string) =>
      sql`UPDATE dispatches SET attempts = attempts - 1 WHERE id = ${dispatchId}`.pipe(
        Effect.orDie,
        Effect.as("engine-unavailable" as const),
      );

    const send = Effect.fn("Sender.send")(function* (
      dispatchId: string,
      purpose: "deliver" | "settle",
    ) {
      const found = yield* ledger.find(dispatchId);
      if (Option.isNone(found)) return "settled" as const;
      const result = yield* gate.run(found.value.session_id)(sendInGate(dispatchId, purpose));
      // The session's state changed, or a Stop may now proceed.
      yield* signals.dispatch.fire;
      yield* signals.stops.fire;
      if (result === "undecided") yield* signals.recovery.fire;
      return result;
    });

    return Sender.of({ send });
  }),
);
