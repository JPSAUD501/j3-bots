// SPDX-License-Identifier: AGPL-3.0-or-later
import { AttachmentId, type BotId, ProviderId, RoomId } from "@j3-bots/contracts";
import {
  type DispatchAttachment,
  type DispatchDisposition,
  type DispatchInput,
  Engine,
  EngineAttachmentId,
  type PermissionModeRefused,
  SessionId,
  TurnId,
} from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
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
import { EngineState } from "../engine/EngineState.ts";
import { Entries } from "../entries/Entries.ts";
import { Layout } from "../Layout.ts";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { recordRunFailure } from "../routines/runFailure.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { admission } from "./admission.ts";
import { type DispatchRow, keyOf, Ledger } from "./Ledger.ts";
import {
  busyBackoff,
  DispatchRowId,
  MAX_INDETERMINATE_ANSWERS,
  MAX_STAGING_FAILURES,
  RECOVERY_WINDOW,
  recoveryBackoff,
  type WakeFailure,
} from "./model.ts";
import { inboxPath } from "./inbox.ts";
import { modeRefusals } from "./modeRefusals.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { automatedSql, providerLimit } from "./providerLimit.ts";
import { DEFECT_RETRY } from "./reconciler.ts";
import { SendPause } from "./SendPause.ts";
import { SessionGate } from "./SessionGate.ts";
import { sessionLoss } from "./sessionRecords.ts";
import { Signals } from "./Signals.ts";
import { roomLiveSql } from "./roomLive.ts";
import { stopHoldsSql, stopTargets } from "./stopTargets.ts";
import { WorkSteps } from "./WorkSteps.ts";

/** What a send did. */
export type SendResult =
  /** The dispatch moved on: it has an answer, or it was released or failed. */
  | "settled"
  /**
   * No answer yet: it is tried again at `next_attempt_at`, by the dispatcher
   * when it was never sent, by the recovery when it was.
   */
  | "scheduled"
  /**
   * Nothing to do now: it is settled, not due before its deadline, held by a
   * Stop whose confirmation nudges the workers, or another send took it.
   */
  | "none"
  /** Its session cannot take it yet: a later pass tries again. */
  | "skipped"
  /** Nothing was sent: the engine cannot take commands. Try again once it is ready. */
  | "engine-unavailable";

/**
 * The worker a send is made for: the dispatcher makes every first send, under
 * the turn budget, and the recovery every send of a key already sent.
 */
export type SendOwner = "dispatcher" | "recovery";

const FileRow = Schema.Struct({
  position: Schema.Int,
  attachment_id: AttachmentId,
  engine_attachment_id: Schema.NullOr(EngineAttachmentId),
  usable_until: Schema.NullOr(Time),
});

const SessionState = Schema.Struct({
  main: Schema.BooleanFromBit,
  engine_session_id: Schema.NullOr(SessionId),
  admitted_turn_id: Schema.NullOr(TurnId),
  lost: Schema.BooleanFromBit,
  gone: Schema.BooleanFromBit,
  unaligned: Schema.BooleanFromBit,
});

/** How staging a dispatch's files went. */
type Staging =
  | { readonly _tag: "staged"; readonly files: ReadonlyArray<DispatchAttachment> }
  /** The engine cannot take commands: nothing was staged, and nothing counts. */
  | { readonly _tag: "unavailable" }
  /** It failed, and may not next time. */
  | { readonly _tag: "failed" }
  /**
   * The dispatch is no longer to be sent as it was read: it was settled
   * meanwhile, or its room start's bot left the room. Nothing more was copied.
   */
  | { readonly _tag: "withdrawn" };

/**
 * Sends one dispatch to the engine, through its session's gate
 * (`docs/architecture/server.md`, 3. A dispatch is written before the engine
 * is called). A dispatch with no recorded attempt was never sent, so its send
 * is the first (`dispatch`, with the adapter's local checks); any other is a
 * recovery (`redispatch`, the same key and input with none).
 *
 * The attempt is claimed durably, after staging and right before the call, by
 * one conditional update: still undecided and unchanged since it was read,
 * and either a recovery of a key already sent, fenced or not, or a first send
 * of an unfenced dispatch into a live session no Stop holds. That claim is
 * what makes a send a send: a Stop recorded before it fences the dispatch,
 * which is then never sent; one recorded after it finds the attempt, and the
 * recovery learns its answer. Every answer is recorded against the dispatch
 * as it stands then, so a fence that landed during the call decides where its
 * wakes go.
 *
 * A dispatch whose session is gone, or whose recovery passed its bound, is
 * settled before anything waits on the session's events; one whose session's
 * events are not known yet is skipped. Neither holds up another session's
 * sends. A defect counts against the dispatch's bounds like the failure it
 * stands for, so a send that keeps failing ends visibly.
 */
export class Sender extends Context.Service<
  Sender,
  {
    /**
     * Sends a dispatch if it is due and still `owner`'s: a first send unless
     * a Stop fenced it or a Stop of its session is unsettled, a recovery of a
     * key already sent in any case. A defect is counted against the dispatch,
     * or at least defers it, so a broken dispatch never holds up the others.
     */
    readonly send: (dispatchId: DispatchRowId, owner: SendOwner) => Effect.Effect<SendResult>;
    /**
     * The last resort for a dispatch that cannot be read: its deadline moves
     * later, and nothing else of it is read or written.
     */
    readonly postpone: (dispatchId: DispatchRowId) => Effect.Effect<void>;
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
    const pause = yield* SendPause;
    const signals = yield* Signals;
    const observer = yield* Observer;
    const attachments = yield* Attachments;
    const layout = yield* Layout;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targets = stopTargets(sql);
    const { admitsStart } = admission(sql, yield* SettingsStore);
    const limitOf = providerLimit(sql, yield* EngineState);
    const entries = yield* Entries;
    const readiness = yield* Readiness;
    const { sessionLost } = sessionLoss(sql, entries, ledger, yield* WorkSteps, signals);
    const refusals = modeRefusals(sql, entries, readiness, signals);
    const runFailed = recordRunFailure(sql);

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
        SELECT s.purpose = 'main' AS main, s.engine_session_id, s.admitted_turn_id,
          s.lost_at IS NOT NULL AS lost,
          (s.retired_at IS NOT NULL OR s.lost_at IS NOT NULL) AS gone,
          s.settings_pending > 0 AS unaligned
        FROM sessions s WHERE s.id = ${sessionId}
      `,
    });

    /**
     * Whether an unsettled Stop of the dispatch's session holds its first
     * send (`stopHoldsSql`), read where `dispatches` is the dispatch's row.
     */
    const stopHolds = sql`(CASE WHEN dispatches.delivery = 'steer'
      THEN ${stopHoldsSql(sql, sql`dispatches.session_id`, sql`dispatches.audience_room_id`)}
      ELSE ${stopHoldsSql(sql, sql`dispatches.session_id`, null)}
    END)`;

    const heldByStop = (dispatchId: DispatchRowId) =>
      sql<{ readonly id: string }>`
        SELECT id FROM dispatches WHERE id = ${dispatchId} AND ${stopHolds}
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /** The engine certainly applied nothing: the wakes wait again, unless the operator stopped them. */
    const unsentWakes = (row: DispatchRow) => targets.wakesAfter(row, { _tag: "unsent" });

    /**
     * It may have been sent, and will not be delivered: the wakes fail with
     * the real reason, visibly and retryable, unless the operator stopped
     * them. They never wait again.
     */
    const sentWakes = (row: DispatchRow, reason: WakeFailure) =>
      targets.wakesAfter(row, { _tag: "failed", reason });

    const releaseUnsent = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* ledger.find(dispatchId);
          if (Option.isNone(row)) return;
          yield* ledger.release(dispatchId, yield* unsentWakes(row.value));
        }),
      );

    /**
     * The adapter saw a turn the server has not applied yet: nothing is
     * planned into the session before a short deadline, which its next
     * applied event clears. A deadline rather than a mark, so a turn whose
     * last event committed before this never strands the session.
     */
    const refusedBusy = (dispatchId: DispatchRowId, sessionId: string) =>
      transaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const [row] = yield* sql<{ readonly busy_refusals: number }>`
            SELECT busy_refusals FROM sessions WHERE id = ${sessionId}
          `.pipe(Effect.orDie);
          const refusals = (row?.busy_refusals ?? 0) + 1;
          const until = DateTime.addDuration(now, busyBackoff(refusals));
          yield* sql`
            UPDATE sessions SET busy_refusals = ${refusals}, busy_until = ${timeText(until)}
            WHERE id = ${sessionId}
          `.pipe(Effect.orDie);
          yield* releaseUnsent(dispatchId);
        }),
      );

    /**
     * The engine took the key. If its session was lost while the call was on
     * its way, nothing will ever report the turn: it fails as `unresolved`.
     * One the engine took in its bot's main session ran in the bot's
     * permission mode, so a later refusal of that mode is told again.
     */
    const accepted = (row: DispatchRow, disposition: DispatchDisposition | null) =>
      transaction(
        Effect.gen(function* () {
          yield* ledger.accept(row.id, disposition);
          const session = yield* sessionState(row.session_id).pipe(Effect.orDie);
          if (session.lost) {
            yield* ledger.abandon(row.id, yield* sentWakes(row, "unresolved"));
          }
          if (session.main) yield* refusals.accepted(row.bot_id);
          return "settled" as const;
        }),
      );

    /**
     * The engine refuses to run the dispatch's turn in its session's
     * permission mode, as under a policy installed after the session was
     * opened in it, and holds no receipt for its key: nothing of it was ever
     * applied, under this send or an earlier one (`PermissionModeRefused`).
     *
     * In the bot's main session it is released, so its wakes wait again,
     * unless the operator stopped them, and the bot records the refusal at
     * its settings revision, which the session, aligned and in its gate, runs:
     * the dispatcher plans nothing into the session until the bot's settings
     * change or the engine is ready again, and the bot's conversation is told
     * once, as for a refused opening (`modeRefusals`). The wakes then go in a
     * new dispatch, under a key of its own, so the message is delivered once.
     *
     * In a side session the routine's attempt fails as one whose session the
     * engine refused to open does: `unresolved`, which its run tries again
     * after its delay in a fresh side session, with the refusal named in the
     * run's history.
     */
    const modeRefused = (row: DispatchRow, refusal: PermissionModeRefused, generation: number) =>
      transaction(
        Effect.gen(function* () {
          const [bot] = yield* sql<{ readonly settings_revision: number }>`
            SELECT settings_revision FROM bots WHERE id = ${row.bot_id}
          `.pipe(Effect.orDie);
          const session = yield* sessionState(row.session_id).pipe(Effect.orDie);
          if (session.main) {
            yield* releaseUnsent(row.id);
            if (bot !== undefined) {
              yield* refusals.refused(row.bot_id, bot.settings_revision, refusal, generation);
            }
          } else {
            yield* runFailed(row.id, {
              _tag: "permission-mode-refused",
              permissionMode: refusal.permissionMode,
              allowed: refusal.allowed,
            });
            yield* failSent(row.id, "unresolved");
            yield* sql.afterCommit(signals.routines.fire);
          }
          return "settled" as const;
        }),
      );

    const failSent = (dispatchId: DispatchRowId, reason: "rejected" | "unresolved") =>
      transaction(
        Effect.gen(function* () {
          const row = yield* ledger.find(dispatchId);
          if (Option.isNone(row)) return;
          yield* ledger.fail(dispatchId, reason, yield* sentWakes(row.value, reason));
        }),
      );

    /**
     * Whether the dispatch's session is a side session written before its
     * bot's model or permission mode last changed: a first send there is
     * refused, and the routine runner replaces the session
     * (`EngineSessions.settingsChanged`).
     */
    const behindItsBot = sql`
      SELECT 1 FROM sessions s JOIN bots b ON b.id = s.bot_id
      WHERE s.id = dispatches.session_id AND s.settings_revision < b.settings_revision
    `;

    /**
     * The claimed attempt was never sent: it is given back, and a fenced
     * dispatch is released. A first send given back into a side session its
     * bot's settings moved past meanwhile is the routine runner's to replace.
     */
    const notSent = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE dispatches SET attempts = attempts - 1
            WHERE id = ${dispatchId} AND status = 'intended' AND attempts > 0
          `.pipe(Effect.orDie);
          const behind = yield* sql`
            SELECT 1 FROM dispatches
            WHERE id = ${dispatchId} AND attempts = 0 AND EXISTS (${behindItsBot})
          `.pipe(Effect.orDie);
          if (behind.length > 0) yield* sql.afterCommit(signals.routines.fire);
          const row = yield* ledger.find(dispatchId);
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

    /**
     * The answer was lost, or the send failed unexpectedly once the attempt
     * was claimed: counted, and the dispatch fails once the bound is reached,
     * or at once when its session is gone, since no answer can come.
     */
    const undecided = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* ledger.find(dispatchId);
          if (Option.isNone(row) || row.value.status !== "intended") return "settled" as const;
          const session = yield* sessionState(row.value.session_id).pipe(Effect.orDie);
          const answers = row.value.indeterminate_answers + 1;
          if (session.gone || answers >= MAX_INDETERMINATE_ANSWERS) {
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
     * Staging failed, or the send failed unexpectedly before its attempt was
     * claimed: tried again with backoff, and after the bound the dispatch
     * fails. Nothing was sent by this send, so a first send fails as
     * `rejected`; a recovery, whose key went out before, as `unresolved`.
     * A session that is gone settles it at once.
     */
    const stagingFailed = (dispatchId: DispatchRowId) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* ledger.find(dispatchId);
          if (Option.isNone(row) || row.value.status !== "intended") return "settled" as const;
          const session = yield* sessionState(row.value.session_id).pipe(Effect.orDie);
          if (session.gone) {
            if (row.value.attempts === 0) {
              yield* ledger.release(dispatchId, yield* unsentWakes(row.value));
            } else {
              yield* ledger.fail(
                dispatchId,
                "unresolved",
                yield* sentWakes(row.value, "unresolved"),
              );
            }
            return "settled" as const;
          }
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

    /**
     * Copies an operator's file into the bot's `files/inbox/`, replacing
     * whatever is at its place. `files/` is the bot's, links included, so the
     * copy goes through the home's containment check like every private
     * write: it never follows a link out of private state.
     */
    const copyToWorkspace = Effect.fn("Sender.copyToWorkspace")(function* (
      botId: BotId,
      attachment: { readonly id: AttachmentId; readonly name: string },
      source: string,
    ) {
      const target = path.join(layout.workspace(botId), inboxPath(attachment));
      yield* layout.writeFile(target, yield* fs.readFile(source));
    });

    /**
     * Whether a dispatch never sent is still to be sent as it was read: still
     * undecided and unsent, and, for a room start, its bot still a member of
     * the room, as the claim requires.
     */
    const stillUnsent = SqlSchema.findOne({
      Request: DispatchRowId,
      Result: Schema.Struct({ due: Schema.BooleanFromBit }),
      execute: (id) => sql`
        SELECT EXISTS (
          SELECT 1 FROM dispatches sw_dispatch
          WHERE sw_dispatch.id = ${id} AND sw_dispatch.status = 'intended'
            AND sw_dispatch.attempts = 0
            AND (
              sw_dispatch.delivery <> 'start' OR sw_dispatch.audience_room_id IS NULL
              OR EXISTS (
                SELECT 1 FROM room_members sw_member
                WHERE sw_member.room_id = sw_dispatch.audience_room_id
                  AND sw_member.bot_id = sw_dispatch.bot_id
              )
            )
        ) AS due
      `,
    });

    /**
     * Each file staged and still usable, staging again those whose staged copy
     * expired. Before the first send, each is copied into the bot's workspace
     * where its envelope names it, once the durable row shows the dispatch is
     * still to be sent: a member that left the room while an earlier file
     * staged, or a dispatch settled meanwhile, is given nothing more. A resend
     * carries the same envelope, which the engine applies at most once, so it
     * copies nothing: what the bot made of its inbox since is its own.
     */
    const stage = Effect.fn("Sender.stage")(function* (row: DispatchRow) {
      const now = yield* DateTime.now;
      const staged: Array<DispatchAttachment> = [];
      for (const file of yield* files(row.id).pipe(Effect.orDie)) {
        const stored = yield* attachments.open(file.attachment_id);
        // A file the store no longer has cannot be sent, now or later.
        if (Option.isNone(stored)) return { _tag: "failed" } satisfies Staging;
        const { attachment } = stored.value;
        if (row.attempts === 0) {
          const still = yield* stillUnsent(row.id).pipe(Effect.orDie);
          if (!still.due) return { _tag: "withdrawn" } satisfies Staging;
          const copied = yield* copyToWorkspace(row.bot_id, attachment, stored.value.path).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Copying a dispatched file into the workspace failed", error).pipe(
                Effect.as(false),
              ),
            ),
          );
          if (!copied) return { _tag: "failed" } satisfies Staging;
        }
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
     * Whether a room start's bot is still a member, and whether anything else
     * of the room is live.
     */
    const roomStart = SqlSchema.findOne({
      Request: Schema.Struct({ dispatchId: DispatchRowId, roomId: RoomId }),
      Result: Schema.Struct({ member: Schema.BooleanFromBit, live: Schema.BooleanFromBit }),
      execute: ({ dispatchId, roomId }) => sql`
        SELECT
          EXISTS (
            SELECT 1 FROM room_members rs_member JOIN dispatches rs_dispatch
              ON rs_dispatch.bot_id = rs_member.bot_id
            WHERE rs_member.room_id = ${roomId} AND rs_dispatch.id = ${dispatchId}
          ) AS member,
          ${roomLiveSql(sql, sql`${roomId}`, sql`${dispatchId}`)} AS live
      `,
    });

    /**
     * Whether the dispatch is automated work its provider's usage limit holds
     * now (`automatedSql`), and whether it goes into its bot's main session.
     */
    const automatedStart = SqlSchema.findOne({
      Request: DispatchRowId,
      Result: Schema.Struct({
        automated: Schema.BooleanFromBit,
        provider_id: ProviderId,
        main: Schema.BooleanFromBit,
      }),
      execute: (id) => sql`
        SELECT ${automatedSql(sql, sql.literal("ls_dispatch.id"))} AS automated,
          ls_session.provider_id, ls_session.purpose = 'main' AS main
        FROM dispatches ls_dispatch
        JOIN sessions ls_session ON ls_session.id = ls_dispatch.session_id
        WHERE ls_dispatch.id = ${id}
      `,
    });

    /**
     * What becomes of a first start that cannot be sent now, because no turn
     * slot is free for its session or because it is automated work its
     * provider's usage limit holds: it is sent (`send`), stays unsent for the
     * dispatcher's next pass (`wait`), or is released (`release`). A room
     * start is released either way: unsent, it would hold the room for
     * nothing. So is one in the bot's main session the limit holds: unsent,
     * it would keep the session busy, and the operator's word, which the
     * limit never holds, would wait behind it until the reset. Its wakes
     * wait as pending wakes, which the planner holds until then. A routine's
     * start, in a side session, holds nothing else, and waits.
     */
    const startHold = Effect.fn("Sender.startHold")(function* (row: DispatchRow) {
      if (!(yield* admitsStart(row.session_id))) {
        return row.audience_room_id === null ? ("wait" as const) : ("release" as const);
      }
      const start = yield* automatedStart(row.id).pipe(Effect.orDie);
      if (!start.automated || Option.isNone(yield* limitOf(start.provider_id))) {
        return "send" as const;
      }
      return start.main ? ("release" as const) : ("wait" as const);
    });

    /**
     * The send's claim: the attempt is counted only if the dispatch is still
     * what was read, and still this send's to make. A recovery owns every key
     * already sent, fenced or not; a first send needs an unfenced dispatch in
     * a live session no Stop holds, and a first start a turn slot, by the
     * budget as it stands now: it may have changed while the files staged.
     * A first start of automated work its provider's usage limit holds now,
     * which may have been reached while the files staged, is held too. A held
     * start stays unsent, for the dispatcher's next pass, or is released
     * (`startHold`): a room start's wakes are planned again in the room's
     * order, and those of a main session's start the limit holds wait for the
     * reset without holding back the operator's word.
     * A first room start needs its bot still a member and nothing else of the
     * room live (`roomLiveSql`), as planning did: another member's turn the
     * engine resumed after a usage limit's reset may have started since. One
     * that finds otherwise is released: its wakes are planned again with the
     * room as it is then, or cancelled for a bot that left it.
     * A first steer needs the turn it was planned for to be still the
     * admitted one: if that turn ended while the files staged, the engine
     * would start a turn with it, outside the budget, so it is released and
     * its wakes go through a start's admission. A first send that carries a
     * teammate message the recipient read meanwhile, as an operator's Retry
     * written before the original landed, is released too: what is left of
     * the read message goes no more (`Ledger.settleRead`), and the rest is
     * planned again without it.
     */
    const claim = (row: DispatchRow) =>
      transaction(
        Effect.gen(function* () {
          /** Back to planning: its wakes wait again, unless a Stop holds them. */
          const releaseFirst = Effect.gen(function* () {
            const current = yield* ledger.find(row.id);
            if (Option.isNone(current) || current.value.attempts > 0) return "refused" as const;
            const released = yield* ledger.release(row.id, yield* unsentWakes(current.value));
            return released ? ("released" as const) : ("refused" as const);
          });
          if (row.attempts === 0 && (yield* ledger.carriesRead(row.id))) {
            const released = yield* releaseFirst;
            if (released === "released") yield* ledger.settleRead(row.bot_id);
            return released;
          }
          if (row.attempts === 0 && row.delivery === "start") {
            const hold = yield* startHold(row);
            if (hold === "release") return yield* releaseFirst;
            if (hold === "wait") return "refused" as const;
            if (row.audience_room_id !== null) {
              const room = yield* roomStart({
                dispatchId: row.id,
                roomId: row.audience_room_id,
              }).pipe(Effect.orDie);
              if (!room.member || room.live) return yield* releaseFirst;
            }
          }
          if (row.attempts === 0 && row.delivery === "steer") {
            const session = yield* sessionState(row.session_id).pipe(Effect.orDie);
            if (session.admitted_turn_id !== row.steer_turn_id) return yield* releaseFirst;
          }
          const at = timeText(yield* DateTime.now);
          const claimed = yield* sql<{ readonly attempts: number }>`
            UPDATE dispatches SET attempts = attempts + 1, updated_at = ${at}
            WHERE id = ${row.id} AND status = 'intended' AND attempts = ${row.attempts}
              AND NOT EXISTS (
                SELECT 1 FROM sessions s
                WHERE s.id = dispatches.session_id AND s.settings_pending > 0
              )
              AND (
                attempts > 0
                OR (
                  fenced_by_stop_id IS NULL
                  AND NOT ${stopHolds}
                  AND NOT EXISTS (
                    SELECT 1 FROM sessions s WHERE s.id = dispatches.session_id
                      AND (s.retired_at IS NOT NULL OR s.lost_at IS NOT NULL)
                  )
                  AND NOT EXISTS (${behindItsBot})
                )
              )
            RETURNING attempts
          `;
          return claimed.length > 0 ? ("claimed" as const) : ("refused" as const);
        }),
      ).pipe(Effect.withSpan("Sender.claim"));

    /**
     * The last resort when a defect could not be counted: one write that only
     * moves the deadline of a dispatch still undecided, and reads nothing of
     * it, so it is looked at again later and never at once.
     */
    const postpone = Effect.fn("Sender.postpone")(function* (dispatchId: DispatchRowId) {
      const next = DateTime.addDuration(yield* DateTime.now, DEFECT_RETRY);
      yield* sql`
        UPDATE dispatches SET next_attempt_at = ${timeText(next)}
        WHERE id = ${dispatchId} AND status = 'intended'
      `.pipe(Effect.orDie);
    });

    /** A send that could only postpone its dispatch: its owner looks again at the new deadline. */
    const postponed = (dispatchId: DispatchRowId) =>
      postpone(dispatchId).pipe(Effect.as<SendResult>("scheduled"));

    /**
     * A defect is logged, and the dispatch goes through `then`, which counts
     * it. When `then` fails as well, the dispatch is only postponed.
     */
    const countDefect =
      (what: string, dispatchId: DispatchRowId, then: Effect.Effect<SendResult>) =>
      <A>(effect: Effect.Effect<A>): Effect.Effect<A | SendResult> =>
        effect.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.andThen(
                Effect.logError(what, cause),
                then.pipe(
                  Effect.catchCauseIf(
                    (again) => !Cause.hasInterruptsOnly(again),
                    (again) =>
                      Effect.andThen(
                        Effect.logError("A dispatch's defect could not be counted", again),
                        postponed(dispatchId),
                      ),
                  ),
                ),
              ),
          ),
        );

    /**
     * Everything before the call, read inside the gate: whether the dispatch
     * is still due, the settling of one whose session is gone or whose bound
     * passed, the session's readiness, the staging and the claim. What to call
     * the engine with once the attempt is claimed, or what the send did.
     */
    const prepare = Effect.fn("Sender.prepare")(function* (
      dispatchId: DispatchRowId,
      owner: SendOwner,
    ) {
      const found = yield* ledger.find(dispatchId);
      if (Option.isNone(found) || found.value.status !== "intended") return "none" as const;
      const row = found.value;
      const now = yield* DateTime.now;
      // Read again in the gate: another pass may have sent it meanwhile, or
      // given back the attempt it claimed, which makes the dispatch the
      // dispatcher's again.
      const firstSend = row.attempts === 0;
      if (firstSend !== (owner === "dispatcher")) return "none" as const;
      if (row.next_attempt_at !== null && DateTime.isGreaterThan(row.next_attempt_at, now)) {
        return "none" as const;
      }
      const session = yield* sessionState(row.session_id).pipe(Effect.orDie);
      // A fenced dispatch never sent was released with its fence; a Stop of
      // the session holds every other first send, but the operator's steer
      // into a turn a room's Stop waits for (`stopHoldsSql`). A key already
      // sent is the recovery's in any case.
      if (firstSend && (row.fenced_by_stop_id !== null || (yield* heldByStop(row.id)))) {
        return "none" as const;
      }

      // Ends with no answer: its session is gone, or the day's bound passed.
      // Settled before anything waits on the session's events.
      const expired = DateTime.isLessThan(
        DateTime.addDuration(row.created_at, RECOVERY_WINDOW),
        now,
      );
      if (session.gone || session.engine_session_id === null || (!firstSend && expired)) {
        if (firstSend) yield* releaseUnsent(row.id);
        else yield* failSent(row.id, "unresolved");
        return "settled" as const;
      }
      const sessionId = session.engine_session_id;

      // Nothing goes into a session its bot's settings have not reached yet,
      // not even a resend, which the engine would start as a turn if it never
      // had the key. Its alignment nudges the workers.
      if (session.unaligned) return "skipped" as const;

      // Nothing new is sent into a session before its events are followed
      // and known from a committed cursor or snapshot; the event that makes
      // it ready nudges the workers. A resend needs no observation: its key
      // makes the engine apply it once, whatever the server knows yet.
      if (firstSend) {
        yield* observer.watch(row.session_id);
        if (!(yield* observer.ready(row.session_id))) return "skipped" as const;
      }

      // A steer goes only into the turn it was planned for: once that turn is
      // no longer the admitted one, its wakes wait for the next dispatch.
      if (firstSend && row.delivery === "steer" && session.admitted_turn_id !== row.steer_turn_id) {
        yield* releaseUnsent(row.id);
        return "settled" as const;
      }

      // A room start that cannot be sent when it is due, for want of a turn
      // slot or held by a usage limit, holds the room for nothing, and a main
      // session's start the limit holds keeps the operator's word waiting:
      // it is released before anything is staged (`startHold`), so the
      // room's order is read again and the operator's word may go first. Its
      // wakes wait, as pending wakes, for what held it.
      if (firstSend && row.delivery === "start" && (yield* startHold(row)) === "release") {
        yield* releaseUnsent(row.id);
        return "settled" as const;
      }

      const staging = yield* stage(row);
      if (staging._tag === "unavailable") return "engine-unavailable" as const;
      if (staging._tag === "failed") return yield* stagingFailed(row.id);
      if (staging._tag === "withdrawn") {
        yield* releaseUnsent(row.id);
        return "settled" as const;
      }
      const input = inputOf(row, sessionId, staging.files);

      const claimed = yield* claim(row);
      if (claimed === "released") return "settled" as const;
      if (claimed === "refused") return "none" as const;
      return { row, input, firstSend };
    });

    /** The call, once the attempt is claimed, and its answer recorded. */
    const call = Effect.fn("Sender.call")(function* (
      row: DispatchRow,
      input: DispatchInput,
      firstSend: boolean,
    ) {
      // An answer from an engine that was unready since is stale (`modeRefusals`).
      const generation = yield* readiness.generation;
      if (firstSend) {
        return yield* engine.dispatch(input).pipe(
          Effect.flatMap((disposition) => accepted(row, disposition)),
          Effect.catchTags({
            // Refused before anything was sent.
            SessionBusy: () =>
              refusedBusy(row.id, row.session_id).pipe(Effect.as("settled" as const)),
            SessionNotFound: () =>
              transaction(Effect.andThen(sessionLost(row.session_id), releaseUnsent(row.id))).pipe(
                Effect.as("settled" as const),
              ),
            DispatchRejected: () =>
              failSent(row.id, "rejected").pipe(Effect.as("settled" as const)),
            PermissionModeRefused: (refusal) => modeRefused(row, refusal, generation),
            EngineUnavailable: () => notSent(row.id),
            EngineIncompatible: () => notSent(row.id),
            EngineIndeterminate: () => undecided(row.id),
          }),
        );
      }
      return yield* engine.redispatch(input).pipe(
        Effect.flatMap(() => accepted(row, null)),
        Effect.catchTags({
          DispatchRejected: () => failSent(row.id, "rejected").pipe(Effect.as("settled" as const)),
          PermissionModeRefused: (refusal) => modeRefused(row, refusal, generation),
          // While the engine is unreachable the recovery waits, and counts nothing.
          EngineUnavailable: () => notSent(row.id),
          EngineIncompatible: () => notSent(row.id),
          EngineIndeterminate: () => undecided(row.id),
        }),
      );
    });

    /**
     * One send, inside the gate. A defect counts against the dispatch's
     * bounds, never retried at once: before the claim nothing was sent, so it
     * counts as a staging failure; after it the key may be in the engine, so
     * it counts as an undecided answer.
     */
    const sendInGate = Effect.fn("Sender.sendInGate")(function* (
      dispatchId: DispatchRowId,
      owner: SendOwner,
    ) {
      const prepared = yield* prepare(dispatchId, owner).pipe(
        countDefect(
          "A dispatch could not be prepared; it is tried again later",
          dispatchId,
          stagingFailed(dispatchId),
        ),
      );
      if (typeof prepared === "string") return prepared;
      return yield* call(prepared.row, prepared.input, prepared.firstSend).pipe(
        countDefect(
          "A dispatch's send failed; it is recovered later",
          dispatchId,
          undecided(dispatchId),
        ),
      );
    });

    const sessionOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ session_id: Schema.String }),
      execute: (id) => sql`
        SELECT session_id FROM dispatches WHERE id = ${id} AND status = 'intended'
      `,
    });

    const attemptsOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ attempts: Schema.Int }),
      execute: (id) => sql`SELECT attempts FROM dispatches WHERE id = ${id}`,
    });

    /**
     * The whole send. A defect outside what the gate counts, such as a row
     * that cannot be read, defers the dispatch durably like any other.
     */
    const sendOnce = (dispatchId: DispatchRowId, owner: SendOwner) =>
      Effect.gen(function* () {
        const found = yield* sessionOf(dispatchId).pipe(Effect.orDie);
        if (Option.isNone(found)) return "none";
        return yield* gate.run(found.value.session_id)(sendInGate(dispatchId, owner));
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.andThen(
              Effect.logError("A dispatch could not be sent; it is tried again later", cause),
              postponed(dispatchId),
            ),
        ),
      );

    const send = Effect.fn("Sender.send")(function* (dispatchId: DispatchRowId, owner: SendOwner) {
      // A first send waits out a pause (`SendPause`); a key already sent is
      // work the engine may have, which a pause counts anyway.
      const result = yield* owner === "dispatcher"
        ? pause.sending(sendOnce(dispatchId, owner))
        : sendOnce(dispatchId, owner);
      // Only a change wakes anyone: the session may take its next wake, a
      // Stop may proceed, or the dispatch's owner has a new deadline: the
      // dispatcher for one never sent, the recovery for a claimed one.
      if (result === "settled") {
        yield* signals.dispatch.fire;
        yield* signals.stops.fire;
      } else if (result === "scheduled") {
        const after = yield* attemptsOf(dispatchId).pipe(Effect.orDie);
        const claimed = Option.isSome(after) && after.value.attempts > 0;
        yield* (claimed ? signals.recovery : signals.dispatch).fire;
      }
      return result;
    });

    return Sender.of({ send, postpone });
  }),
);
