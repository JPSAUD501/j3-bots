// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type ModelChoice, type PermissionMode, ProviderId } from "@j3-bots/contracts";
import {
  Engine,
  type EngineDown,
  IdempotencyKey,
  type ModelUnavailable,
  type ProjectNotFound,
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
import { Ids } from "../Ids.ts";
import { timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { SessionGate } from "../turns/SessionGate.ts";
import { Signals } from "../turns/Signals.ts";
import { BotStore } from "./BotStore.ts";
import { Workspaces } from "./Workspaces.ts";

const SessionRow = Schema.Struct({
  id: Schema.String,
  bot_id: BotId,
  engine_session_id: Schema.NullOr(SessionId),
  provider_id: ProviderId,
});

/** A live session's alignment with its bot's settings. */
const Alignment = Schema.Struct({
  engine_session_id: Schema.NullOr(SessionId),
  provider_id: ProviderId,
  settings_pending: Schema.Int,
});

/** What the engine is asked to bring a session to, and the changes that covers. */
interface Pending {
  readonly sessionId: SessionId;
  readonly model: ModelChoice;
  readonly permissionMode: PermissionMode;
  readonly changes: number;
}

/** A bot session as the server knows it. */
export interface BotSession {
  readonly id: string;
  readonly botId: BotId;
}

/**
 * Each bot's place in the engine: its project, and its main session
 * (`docs/architecture/server.md`, Sessions). The session's id is J3 Bots' own,
 * written before the engine is asked for it and used as that request's key, so
 * a retried opening never makes a second engine session. The row is written in
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
 * settings the operator replaced. Aligning sends the
 * bot's settings as they stand, in the session's gate, and sets the count back
 * to zero only if no change committed meanwhile.
 *
 * Opening and aligning are reconciled rather than done once: after a bot is
 * created or changed, and by the rotator, with backoff, for every live bot
 * whose main session is missing, unopened or not aligned, so a bot whose
 * session could not be opened or aligned gets it once the engine takes it.
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
    ) => Effect.Effect<void, EngineDown | ProjectNotFound | ModelUnavailable | SessionNotFound>;
    /**
     * Records that the bot's model or permission mode changed: its main
     * session takes no work until the rotator aligned it. Runs in the
     * caller's transaction, the one that saves the change.
     */
    readonly settingsChanged: (botId: BotId) => Effect.Effect<void>;
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
    // One provisioning at a time: a bot's creation and the rotator may both
    // find its session missing.
    const provisioning = yield* Semaphore.make(1);

    const mainSession = SqlSchema.findOneOption({
      Request: BotId,
      Result: SessionRow,
      execute: (botId) => sql`
        SELECT id, bot_id, engine_session_id, provider_id FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
      `,
    });

    const byEngineSession = SqlSchema.findOneOption({
      Request: SessionId,
      Result: SessionRow,
      execute: (sessionId) => sql`
        SELECT id, bot_id, engine_session_id, provider_id FROM sessions
        WHERE engine_session_id = ${sessionId} AND retired_at IS NULL
      `,
    });

    /**
     * The bot's settings and its main session row, read together: the row is
     * written now if the bot has none, on the provider those settings chose.
     */
    const selection = Effect.fn("EngineSessions.selection")(
      function* (botId: BotId) {
        const found = yield* bots.find(botId);
        if (Option.isNone(found)) return null;
        const { bot } = found.value;
        const existing = yield* mainSession(botId);
        if (Option.isSome(existing)) return { bot, session: existing.value };
        const id = yield* ids.make("session");
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
          session: {
            id,
            bot_id: botId,
            engine_session_id: null,
            provider_id: bot.model.providerId,
          },
        };
      },
      transaction,
      Effect.orDie,
    );

    const settingsChanged = Effect.fn("EngineSessions.settingsChanged")(function* (botId: BotId) {
      const marked = yield* sql`
        UPDATE sessions SET settings_pending = settings_pending + 1
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
        RETURNING id
      `;
      // The rotator aligns it.
      if (marked.length > 0) yield* sql.afterCommit(signals.rotations.fire);
    }, Effect.orDie);

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
     * opened yet, gone, or on a provider the bot left.
     */
    const pending = Effect.fn("EngineSessions.pending")(
      function* (botId: BotId, rowId: string) {
        const found = yield* bots.find(botId);
        const row = yield* alignment(rowId);
        if (Option.isNone(found) || Option.isNone(row)) return null;
        const { bot } = found.value;
        const session = row.value;
        if (
          session.settings_pending === 0 ||
          session.engine_session_id === null ||
          session.provider_id !== bot.model.providerId
        ) {
          return null;
        }
        return {
          sessionId: session.engine_session_id,
          model: bot.model,
          permissionMode: bot.permissionMode,
          changes: session.settings_pending,
        } satisfies Pending;
      },
      transaction,
      Effect.orDie,
    );

    /** Marks the session aligned, unless a change committed since `changes` were read. */
    const aligned = Effect.fn("EngineSessions.aligned")(function* (rowId: string, changes: number) {
      const cleared = yield* sql`
        UPDATE sessions SET settings_pending = 0
        WHERE id = ${rowId} AND settings_pending = ${changes}
        RETURNING id
      `;
      return cleared.length > 0;
    }, Effect.orDie);

    /**
     * Brings the bot's opened main session to the bot's settings, if it has
     * changes it was not brought to and still runs on the bot's provider: a
     * session on another provider is being replaced, and the one that
     * replaces it opens with the bot's settings. In the session's gate, so it
     * never crosses a send, and two alignments never cross either: one that
     * read older settings could otherwise reach the engine after a newer one.
     */
    const align = Effect.fn("EngineSessions.align")(function* (botId: BotId) {
      const session = yield* mainSession(botId).pipe(Effect.orDie);
      if (Option.isNone(session)) return;
      const rowId = session.value.id;
      yield* gate.run(rowId)(
        Effect.gen(function* () {
          for (;;) {
            const due = yield* pending(botId, rowId);
            if (due === null) return;
            yield* engine.configureSession({
              sessionId: due.sessionId,
              model: due.model,
              permissionMode: due.permissionMode,
            });
            if (yield* aligned(rowId, due.changes)) {
              // A wake waiting for the session is dispatched now, and a
              // held queue resumed.
              yield* signals.dispatch.fire;
              yield* signals.resumes.fire;
              return;
            }
          }
        }),
      );
    });

    const provision = Effect.fn("EngineSessions.provision")(function* (botId: BotId) {
      const found = yield* bots.find(botId);
      if (Option.isNone(found)) return;
      const { bot, workspacePath, engineProjectId } = found.value;
      yield* workspaces.provision(botId);
      // Asked every time: it answers with the project the workspace already has.
      const projectId = yield* engine.ensureProject({ workspacePath, title: bot.profile.name });
      if (Option.getOrNull(engineProjectId) !== projectId) {
        yield* bots.setEngineProject(botId, projectId);
      }
      const selected = yield* selection(botId);
      if (selected === null) return;
      const { session } = selected;
      const settings = selected.bot;
      // The bot moved to another provider since the row was written: the
      // rotator replaces the row, which never opens.
      if (session.provider_id !== settings.model.providerId) return;
      if (session.engine_session_id === null) {
        const sessionId = yield* engine.openSession({
          key: IdempotencyKey.make(session.id),
          projectId,
          title: "Main",
          model: settings.model,
          permissionMode: settings.permissionMode,
        });
        // Recorded before it is aligned, which it takes no work until.
        yield* sql`UPDATE sessions SET engine_session_id = ${sessionId} WHERE id = ${session.id}`.pipe(
          Effect.orDie,
        );
      }
      yield* align(botId);
    }, provisioning.withPermits(1));

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
      settingsChanged,
      removeProject,
      withoutProvisioning: provisioning.withPermits(1),
      ofEngineSession,
    });
  }),
);
