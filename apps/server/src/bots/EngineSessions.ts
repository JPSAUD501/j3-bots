// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type ModelChoice, type PermissionMode, ProviderId } from "@j3-bots/contracts";
import {
  Engine,
  type EngineDown,
  IdempotencyKey,
  type ModelUnavailable,
  type OpenRejected,
  SessionId,
  type SessionNotFound,
} from "@j3-bots/engine-t3";
import { PROMPT_VERSION } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { conversation, SessionRowId } from "../turns/model.ts";
import { notices } from "../turns/notices.ts";
import { SessionGate } from "../turns/SessionGate.ts";
import { sessionWork } from "../turns/sessionWork.ts";
import { Signals } from "../turns/Signals.ts";
import { BotStore } from "./BotStore.ts";
import { Workspaces } from "./Workspaces.ts";

const SessionRow = Schema.Struct({
  id: SessionRowId,
  bot_id: BotId,
  engine_session_id: Schema.NullOr(SessionId),
  provider_id: ProviderId,
  open_refusals: Schema.Int,
});

/**
 * The key a session is opened under: its id, and once the engine refused to
 * open it, its id with the count of refusals. The engine keeps a refusal for
 * its key, so a key it refused is never sent again.
 */
const openingKey = (session: typeof SessionRow.Type) =>
  IdempotencyKey.make(
    session.open_refusals === 0 ? session.id : `${session.id}:${session.open_refusals}`,
  );

/** A live session's alignment with its bot's settings. */
const Alignment = Schema.Struct({
  engine_session_id: Schema.NullOr(SessionId),
  provider_id: ProviderId,
  settings_pending: Schema.Int,
});

/**
 * How many times the bot's model or permission mode changed, and the count at
 * which the engine refused its permission mode, if it did.
 */
const Revision = Schema.Struct({
  settings_revision: Schema.Int,
  mode_refused_revision: Schema.NullOr(Schema.Int),
});

/** The bot's settings revision, and whether the engine refused its permission mode at it. */
const revisionState = (row: typeof Revision.Type) => ({
  revision: row.settings_revision,
  modeRefused: row.mode_refused_revision === row.settings_revision,
});

/**
 * What the engine is asked to bring a session to, the changes that covers,
 * and the bot's settings revision they were read at.
 */
interface Pending {
  readonly sessionId: SessionId;
  readonly model: ModelChoice;
  readonly permissionMode: PermissionMode;
  readonly changes: number;
  readonly revision: number;
}

/**
 * What became of bringing a bot's main session to the bot's settings.
 *
 * - `aligned`: it runs them, or there is nothing to align now (no session
 *   opened, or one being replaced).
 * - `turn-running`: a turn runs there, and a change could end it, so it waits
 *   for that turn's end, which nudges the rotator.
 * - `background-work`: the engine will not apply it while background work
 *   runs in the session, which it would end; the bot's conversation is told
 *   once per change.
 * - `mode-refused`: the engine refuses the bot's permission mode, to open the
 *   session in or to change it to, until the bot's settings change. The
 *   session is neither opened nor aligned again until then, and the bot's
 *   conversation is told once.
 */
export type Alignment = "aligned" | "turn-running" | "background-work" | "mode-refused";

/**
 * The bot's main session whose gate a settings change holds
 * (`EngineSessions.inMainSessionGate`), or none when it had none.
 */
export interface HeldMainSession {
  readonly botId: BotId;
  readonly rowId: string | null;
}

/**
 * The bot's main session is no longer the one whose gate the change holds:
 * replaced, or written meanwhile. The change is made again in the gate of the
 * one it has now.
 */
export class MainSessionMoved extends Schema.TaggedError<MainSessionMoved>()(
  "MainSessionMoved",
  {},
) {}

/** A bot session as the server knows it. */
export interface BotSession {
  readonly id: SessionRowId;
  readonly botId: BotId;
}

/**
 * Each bot's place in the engine: its project, and its main session
 * (`docs/architecture/server.md`, Sessions). The session's id is J3 Bots' own,
 * written before the engine is asked for it and used as that request's key, so
 * a retried opening never makes a second engine session. An opening the engine
 * refused spends its key: the row counts the refusal, and the next opening
 * goes under a fresh key (`openingKey`). The row is written in
 * the transaction that reads the bot's settings, and names the provider they
 * chose: a session never changes provider, and one whose bot moved on is
 * replaced (`turns/Rotations.ts`), never opened on the provider it no longer
 * has.
 *
 * The bot's saved settings are what its session runs with. A session row
 * counts the changes of its bot's model or permission mode it was not brought
 * to yet (`settings_pending`): a new row starts at one, since an opening
 * retried under its key answers with the settings of its first attempt, and a
 * change adds one in the transaction that saves it. The dispatcher plans
 * nothing into a session above zero, the sender sends nothing into it and a
 * held engine queue is not resumed there, so no turn starts there with
 * settings the operator replaced. A change is saved in the session's gate, so
 * a send already claimed reaches the engine before it, or is refused after.
 * Aligning sends the bot's settings as they stand, in the session's gate,
 * once no turn runs there, and sets the count back to zero only if no change
 * committed meanwhile.
 *
 * Opening and aligning are reconciled rather than done once: after a bot is
 * created or changed, and by the rotator, with backoff, for every live bot
 * whose main session is missing, unopened or not aligned, so a bot whose
 * session could not be opened or aligned gets it once the engine takes it.
 * A permission mode the engine refuses is refused until the bot's settings
 * change, as under an administrator's policy on the engine's machine: the bot
 * records the settings revision it was refused at (`mode_refused_revision`),
 * and its session is neither opened nor aligned at that revision again.
 */
export class EngineSessions extends Context.Service<
  EngineSessions,
  {
    /**
     * Gives the bot its workspace, project and main session, whichever are
     * missing, and brings the session to the bot's settings.
     */
    readonly provision: (
      botId: BotId,
    ) => Effect.Effect<Alignment, EngineDown | ModelUnavailable | OpenRejected | SessionNotFound>;
    /**
     * Brings the bot's opened main session to the bot's settings, for a bot
     * whose workspace, project and session are in place and only an alignment
     * is due.
     */
    readonly align: (
      botId: BotId,
    ) => Effect.Effect<Alignment, EngineDown | ModelUnavailable | SessionNotFound>;
    /**
     * Runs `change`, which saves a new model or permission mode of the bot,
     * in the gate of the bot's main session, so it never commits while a send
     * into that session is on its way to the engine. `change` calls
     * `settingsChanged` in its transaction; when the bot's main session moved
     * meanwhile, it runs again in the gate of the one it has now.
     */
    readonly inMainSessionGate: <A, E, R>(
      botId: BotId,
      change: (held: HeldMainSession) => Effect.Effect<A, E | MainSessionMoved, R>,
    ) => Effect.Effect<A, Exclude<E, MainSessionMoved>, R>;
    /**
     * Records that the bot's model or permission mode changed: its main
     * session takes no work until the rotator aligned it, and a side session
     * with nothing sent yet none until the routine runner replaced it
     * (`settings_revision`). Runs
     * in the caller's transaction, the one that saves the change, inside
     * `inMainSessionGate`, whose session it checks is still the bot's.
     */
    readonly settingsChanged: (held: HeldMainSession) => Effect.Effect<void, MainSessionMoved>;
    /**
     * Tells the bot's conversation that its main session could not be opened
     * or aligned, once until an alignment succeeds again.
     */
    readonly notReady: (botId: BotId) => Effect.Effect<void>;
    /** Removes the bot's project, and every session in it, from the engine. */
    readonly removeProject: (botId: BotId) => Effect.Effect<void, EngineDown>;
    /**
     * Runs `effect` with no provisioning of any bot alongside it. A bot's
     * deletion removes its project and its rows within it, so the rotator
     * cannot give the engine a project for a bot that is going.
     */
    readonly withoutProvisioning: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** The session an engine session id belongs to, if it is a live one of a bot. */
    readonly ofEngineSession: (sessionId: SessionId) => Effect.Effect<Option.Option<BotSession>>;
  }
>()("@j3-bots/server/bots/EngineSessions") {}

export const layer = Layer.effect(
  EngineSessions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const engine = yield* Engine;
    const bots = yield* BotStore;
    const workspaces = yield* Workspaces;
    const ids = yield* Ids;
    const signals = yield* Signals;
    const gate = yield* SessionGate;
    const workOf = sessionWork(sql);
    const { notify } = notices(sql, yield* Entries);
    const changes = yield* ChangeLog;
    // One provisioning at a time: a bot's creation and the rotator may both
    // find its session missing.
    const provisioning = yield* Semaphore.make(1);

    const mainSession = SqlSchema.findOneOption({
      Request: BotId,
      Result: SessionRow,
      execute: (botId) => sql`
        SELECT id, bot_id, engine_session_id, provider_id, open_refusals FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
      `,
    });

    const revisionOf = SqlSchema.findOne({
      Request: BotId,
      Result: Revision,
      execute: (botId) => sql`
        SELECT settings_revision, mode_refused_revision FROM bots WHERE id = ${botId}
      `,
    });

    const byEngineSession = SqlSchema.findOneOption({
      Request: SessionId,
      Result: SessionRow,
      execute: (sessionId) => sql`
        SELECT id, bot_id, engine_session_id, provider_id, open_refusals FROM sessions
        WHERE engine_session_id = ${sessionId} AND retired_at IS NULL
      `,
    });

    /**
     * The bot's settings, their revision, whether the engine refused its
     * permission mode at that revision, and its main session row, read
     * together: the row is written now if the bot has none, on the provider
     * those settings chose.
     */
    const selection = Effect.fn("EngineSessions.selection")(
      function* (botId: BotId) {
        const found = yield* bots.find(botId);
        if (Option.isNone(found)) return null;
        const { bot } = found.value;
        const { revision, modeRefused } = revisionState(yield* revisionOf(botId));
        const existing = yield* mainSession(botId);
        if (Option.isSome(existing)) {
          return { bot, revision, modeRefused, session: existing.value };
        }
        const id = SessionRowId.make(yield* ids.make("session"));
        yield* sql`
        INSERT INTO sessions (
          id, bot_id, purpose, prompt_version, provider_id, settings_pending, created_at
        ) VALUES (
          ${id}, ${botId}, 'main', ${PROMPT_VERSION}, ${bot.model.providerId}, 1,
          ${timeText(yield* DateTime.now)}
        )
      `;
        return {
          bot,
          revision,
          modeRefused,
          session: {
            id,
            bot_id: botId,
            engine_session_id: null,
            provider_id: bot.model.providerId,
            open_refusals: 0,
          },
        };
      },
      transaction,
      Effect.orDie,
    );

    const mainRowId = (botId: BotId) =>
      mainSession(botId).pipe(
        Effect.orDie,
        Effect.map((row) => (Option.isSome(row) ? row.value.id : null)),
      );

    const settingsChanged = Effect.fn("EngineSessions.settingsChanged")(function* (
      held: HeldMainSession,
    ) {
      const rowId = yield* mainRowId(held.botId);
      if (rowId !== held.rowId) return yield* new MainSessionMoved();
      // Every side session of the bot is now behind it: a first send's claim
      // refuses one from now on, also a send claimed before this committed
      // and given back unsent, and the routine runner replaces it with one
      // opened with the new settings. One whose send was claimed and not
      // given back runs its turn with the settings it started with, as a
      // running turn does.
      yield* sql`
        UPDATE bots SET settings_revision = settings_revision + 1 WHERE id = ${held.botId}
      `.pipe(Effect.orDie);
      yield* sql.afterCommit(signals.routines.fire);
      if (rowId === null) return;
      // A new change is told of again if it waits for background work.
      yield* sql`
        UPDATE sessions SET settings_pending = settings_pending + 1, settings_held = 0
        WHERE id = ${rowId}
      `.pipe(Effect.orDie);
      // The rotator aligns it.
      yield* sql.afterCommit(signals.rotations.fire);
    });

    const isMoved = Schema.is(MainSessionMoved);

    const inMainSessionGate = <A, E, R>(
      botId: BotId,
      change: (held: HeldMainSession) => Effect.Effect<A, E | MainSessionMoved, R>,
    ): Effect.Effect<A, Exclude<E, MainSessionMoved>, R> =>
      Effect.gen(function* () {
        for (;;) {
          const held: HeldMainSession = { botId, rowId: yield* mainRowId(botId) };
          const attempt = held.rowId === null ? change(held) : gate.run(held.rowId)(change(held));
          const done = yield* attempt.pipe(
            Effect.asSome,
            Effect.catchIf(isMoved, () => Effect.succeedNone),
          );
          if (Option.isSome(done)) return done.value;
        }
      });

    const alignment = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Alignment,
      execute: (id) => sql`
        SELECT engine_session_id, provider_id, settings_pending FROM sessions
        WHERE id = ${id} AND retired_at IS NULL AND lost_at IS NULL
      `,
    });

    /**
     * The session's pending changes and the bot's settings as they stand, read
     * together; `null` when there is nothing to align: no changes pending, not
     * opened yet, gone, or on a provider the bot left; `mode-refused` when the
     * engine refused the bot's permission mode at its settings as they stand.
     */
    const pending = Effect.fn("EngineSessions.pending")(
      function* (botId: BotId, rowId: string) {
        const found = yield* bots.find(botId);
        const row = yield* alignment(rowId);
        if (Option.isNone(found) || Option.isNone(row)) return null;
        const { bot } = found.value;
        const session = row.value;
        const { revision, modeRefused } = revisionState(yield* revisionOf(botId));
        if (
          session.settings_pending === 0 ||
          session.engine_session_id === null ||
          session.provider_id !== bot.model.providerId
        ) {
          return null;
        }
        if (modeRefused) return "mode-refused" as const;
        return {
          sessionId: session.engine_session_id,
          model: bot.model,
          permissionMode: bot.permissionMode,
          changes: session.settings_pending,
          revision,
        } satisfies Pending;
      },
      transaction,
      Effect.orDie,
    );

    /**
     * Records that the session's settings wait for background work there,
     * which the roster shows, and tells the bot's conversation, once per
     * change.
     */
    const heldByBackgroundWork = Effect.fn("EngineSessions.heldByBackgroundWork")(
      function* (botId: BotId, rowId: string) {
        const held = yield* sql`
          UPDATE sessions SET settings_held = 1
          WHERE id = ${rowId} AND settings_pending > 0 AND settings_held = 0
          RETURNING id
        `;
        if (held.length === 0) return;
        yield* notify(botId, conversation, { _tag: "settings-held" }, null);
        yield* changes.touch({ _tag: "bot", botId });
      },
      transaction,
      Effect.orDie,
    );

    /**
     * Records that the engine refuses the bot's permission mode at the
     * settings revision `revision`, and tells the bot's conversation, once
     * per revision. A change committed since that revision was read is
     * recorded nothing for: the rotator, which the change nudged, tries it.
     */
    const modeRefused = Effect.fn("EngineSessions.modeRefused")(
      function* (botId: BotId, revision: number) {
        const refused = yield* sql`
          UPDATE bots SET mode_refused_revision = ${revision}
          WHERE id = ${botId} AND settings_revision = ${revision}
            AND mode_refused_revision IS NOT ${revision}
          RETURNING id
        `;
        if (refused.length === 0) return;
        yield* notify(botId, conversation, { _tag: "permission-mode-refused" }, null);
      },
      transaction,
      Effect.orDie,
    );

    /**
     * Marks the session aligned, unless a change committed since `pending`
     * were read. A hold by background work ends with it.
     */
    const aligned = Effect.fn("EngineSessions.aligned")(
      function* (botId: BotId, rowId: string, pending: number) {
        const [row] = yield* sql<{ readonly held: number }>`
          SELECT settings_held AS held FROM sessions
          WHERE id = ${rowId} AND settings_pending = ${pending}
        `;
        if (row === undefined) return false;
        yield* sql`UPDATE sessions SET settings_pending = 0, settings_held = 0 WHERE id = ${rowId}`;
        if (row.held === 1) yield* changes.touch({ _tag: "bot", botId });
        // Ready: a later run of failures is told again.
        yield* sql`UPDATE bots SET unready_told = 0 WHERE id = ${botId} AND unready_told = 1`;
        return true;
      },
      transaction,
      Effect.orDie,
    );

    /**
     * Brings the bot's opened main session to the bot's settings, if it has
     * changes it was not brought to and still runs on the bot's provider: a
     * session on another provider is being replaced, and the one that
     * replaces it opens with the bot's settings. In the session's gate, so it
     * never crosses a send, and two alignments never cross either: one that
     * read older settings could otherwise reach the engine after a newer one.
     *
     * Not while a turn runs there: a change can replace the provider session,
     * which ends the turn (`Engine.configureSession`), and the turn keeps the
     * settings it started with. Its end nudges the rotator, which aligns then.
     */
    const align = Effect.fn("EngineSessions.align")(function* (botId: BotId) {
      const session = yield* mainSession(botId).pipe(Effect.orDie);
      if (Option.isNone(session)) return "aligned" as const;
      const rowId = session.value.id;
      return yield* gate.run(rowId)(
        Effect.gen(function* () {
          for (;;) {
            const due = yield* pending(botId, rowId);
            if (due === null) return "aligned" as const;
            // Asked again only once the bot's settings change.
            if (due === "mode-refused") return due;
            const work = yield* workOf(rowId);
            if (work.admitted !== null || work.runningTurns > 0) {
              return "turn-running" as const;
            }
            const refused = yield* engine
              .configureSession({
                sessionId: due.sessionId,
                model: due.model,
                permissionMode: due.permissionMode,
              })
              .pipe(
                Effect.as(null),
                Effect.catchTags({
                  // One the engine started on its own, not seen here yet.
                  SessionBusy: () => Effect.succeed("turn-running" as const),
                  BackgroundWorkRunning: () => Effect.succeed("background-work" as const),
                  PermissionModeRefused: () => Effect.succeed("mode-refused" as const),
                }),
              );
            if (refused === "background-work") yield* heldByBackgroundWork(botId, rowId);
            if (refused === "mode-refused") yield* modeRefused(botId, due.revision);
            if (refused !== null) return refused;
            if (yield* aligned(botId, rowId, due.changes)) {
              // A wake waiting for the session is dispatched now, and a
              // held queue resumed.
              yield* signals.dispatch.fire;
              yield* signals.resumes.fire;
              return "aligned" as const;
            }
          }
        }),
      );
    });

    /** Counts a refused opening of the session, which its next key carries. */
    const openingRefused = (session: typeof SessionRow.Type) =>
      sql`
        UPDATE sessions SET open_refusals = open_refusals + 1
        WHERE id = ${session.id} AND engine_session_id IS NULL
          AND open_refusals = ${session.open_refusals}
      `.pipe(Effect.orDie, Effect.asVoid);

    const provision = Effect.fn("EngineSessions.provision")(function* (botId: BotId) {
      const found = yield* bots.find(botId);
      if (Option.isNone(found)) return "aligned" as const;
      const { bot, workspacePath, engineProjectId } = found.value;
      yield* workspaces.provision(botId);
      // Asked every time: it answers with the project the workspace already has.
      const projectId = yield* engine.ensureProject({ workspacePath, title: bot.profile.name });
      if (Option.getOrNull(engineProjectId) !== projectId) {
        yield* bots.setEngineProject(botId, projectId);
      }
      const selected = yield* selection(botId);
      if (selected === null) return "aligned" as const;
      const { session } = selected;
      const settings = selected.bot;
      // The bot moved to another provider since the row was written: the
      // rotator replaces the row, which never opens.
      if (session.provider_id !== settings.model.providerId) return "aligned" as const;
      // Opened, or aligned, again only once the bot's settings change.
      if (selected.modeRefused) return "mode-refused" as const;
      if (session.engine_session_id === null) {
        const opened = yield* engine
          .openSession({
            key: openingKey(session),
            projectId,
            title: "Main",
            model: settings.model,
            permissionMode: settings.permissionMode,
          })
          .pipe(
            // The key is spent: the next opening takes a fresh one.
            Effect.tapErrorTag("OpenRejected", () => openingRefused(session)),
            Effect.asSome,
            // The engine keeps nothing for the key: it opens under it once
            // the bot's settings changed.
            Effect.catchTag("PermissionModeRefused", () => Effect.succeedNone),
          );
        if (Option.isNone(opened)) {
          yield* modeRefused(botId, selected.revision);
          return "mode-refused" as const;
        }
        // Recorded before it is aligned, which it takes no work until.
        yield* sql`UPDATE sessions SET engine_session_id = ${opened.value} WHERE id = ${session.id}`.pipe(
          Effect.orDie,
        );
      }
      return yield* align(botId);
    }, provisioning.withPermits(1));

    /** An alignment on its own, which no provisioning crosses either. */
    const alignAlone = Effect.fn("EngineSessions.alignAlone")(function* (botId: BotId) {
      return yield* align(botId);
    }, provisioning.withPermits(1));

    const notReady = Effect.fn("EngineSessions.notReady")(
      function* (botId: BotId) {
        const told = yield* sql`
          UPDATE bots SET unready_told = 1 WHERE id = ${botId} AND unready_told = 0 RETURNING id
        `;
        if (told.length > 0)
          yield* notify(botId, conversation, { _tag: "session-not-ready" }, null);
      },
      transaction,
      Effect.orDie,
    );

    const removeProject = Effect.fn("EngineSessions.removeProject")(function* (botId: BotId) {
      const found = yield* bots.find(botId);
      if (Option.isNone(found)) return;
      if (Option.isSome(found.value.engineProjectId)) {
        yield* engine.removeProject(found.value.engineProjectId.value);
      }
    });

    const ofEngineSession = Effect.fn("EngineSessions.ofEngineSession")(function* (
      sessionId: SessionId,
    ) {
      const row = yield* byEngineSession(sessionId);
      return Option.map(row, (found): BotSession => ({ id: found.id, botId: found.bot_id }));
    }, Effect.orDie);

    return EngineSessions.of({
      provision,
      align: alignAlone,
      inMainSessionGate,
      settingsChanged,
      notReady,
      removeProject,
      withoutProvisioning: provisioning.withPermits(1),
      ofEngineSession,
    });
  }),
);
