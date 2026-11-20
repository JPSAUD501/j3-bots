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
import { BotStore } from "./BotStore.ts";
import { Workspaces } from "./Workspaces.ts";

const SessionRow = Schema.Struct({
  id: Schema.String,
  bot_id: BotId,
  engine_session_id: Schema.NullOr(SessionId),
  provider_id: ProviderId,
});

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
 * Opening is reconciled rather than done once: after a bot is created, and by
 * the rotator for every live bot without an opened main session, so a bot
 * whose session could not be opened gets it once the engine takes it.
 */
export class EngineSessions extends Context.Service<
  EngineSessions,
  {
    /** Gives the bot its workspace, project and main session, whichever are missing. */
    readonly provision: (
      botId: BotId,
    ) => Effect.Effect<void, EngineDown | ProjectNotFound | ModelUnavailable>;
    /**
     * Applies a new model or permission mode to the bot's main session, when
     * it runs on the model's provider: a session on another provider is being
     * replaced, and the one that replaces it opens with the bot's settings.
     */
    readonly configure: (
      botId: BotId,
      changes: { readonly model?: ModelChoice; readonly permissionMode?: PermissionMode },
    ) => Effect.Effect<void, EngineDown | SessionNotFound | ModelUnavailable>;
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
        INSERT INTO sessions (id, bot_id, purpose, prompt_version, provider_id, created_at)
        VALUES (
          ${id}, ${botId}, 'main', ${PROMPT_VERSION}, ${bot.model.providerId},
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
      if (selected === null || selected.session.engine_session_id !== null) return;
      const { session } = selected;
      // The bot moved to another provider since the row was written: the
      // rotator replaces the row, which never opens.
      if (session.provider_id !== selected.bot.model.providerId) return;
      const sessionId = yield* engine.openSession({
        key: IdempotencyKey.make(session.id),
        projectId,
        title: "Main",
        model: selected.bot.model,
        permissionMode: selected.bot.permissionMode,
      });
      /**
       * Brings the session to the bot's settings as they stand, if it is
       * still on their provider, and answers what it applied.
       */
      const align = Effect.fnUntraced(function* () {
        const now = yield* bots.find(botId);
        if (Option.isNone(now) || now.value.bot.model.providerId !== session.provider_id) {
          return null;
        }
        const { model, permissionMode } = now.value.bot;
        yield* engine
          .configureSession({ sessionId, model, permissionMode })
          // Lost meanwhile: the rotator replaces it, with the bot's settings.
          .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
        return { model, permissionMode };
      });
      // Before the session takes work: a retried opening answers with the
      // session the engine opened first, with the settings of that attempt,
      // and the bot's may have changed since.
      const applied = yield* align();
      yield* sql`UPDATE sessions SET engine_session_id = ${sessionId} WHERE id = ${session.id}`.pipe(
        Effect.orDie,
      );
      // A change that committed after that found the session unopened, and
      // left it to this.
      const now = yield* bots.find(botId);
      if (
        applied !== null &&
        Option.isSome(now) &&
        (now.value.bot.model.modelId !== applied.model.modelId ||
          now.value.bot.permissionMode !== applied.permissionMode)
      ) {
        yield* align();
      }
    }, provisioning.withPermits(1));

    const configure = Effect.fn("EngineSessions.configure")(function* (
      botId: BotId,
      changes: { readonly model?: ModelChoice; readonly permissionMode?: PermissionMode },
    ) {
      const session = yield* mainSession(botId).pipe(Effect.orDie);
      if (Option.isNone(session) || session.value.engine_session_id === null) {
        // Not opened yet: it opens with the bot's current settings.
        return;
      }
      if (changes.model !== undefined && changes.model.providerId !== session.value.provider_id) {
        return;
      }
      yield* engine.configureSession({ sessionId: session.value.engine_session_id, ...changes });
    });

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
      configure,
      removeProject,
      withoutProvisioning: provisioning.withPermits(1),
      ofEngineSession,
    });
  }),
);
