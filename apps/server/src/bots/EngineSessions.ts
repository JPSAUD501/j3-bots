// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type ModelChoice, type PermissionMode, type ProviderId } from "@j3-bots/contracts";
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
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Ids } from "../Ids.ts";
import { timeText } from "../persistence/columns.ts";
import { BotStore } from "./BotStore.ts";
import { Workspaces } from "./Workspaces.ts";

const SessionRow = Schema.Struct({
  id: Schema.String,
  bot_id: BotId,
  engine_session_id: Schema.NullOr(SessionId),
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
 * a retried opening never makes a second engine session.
 *
 * Opening is reconciled rather than done once: after a bot is created, and for
 * every bot each time the engine becomes ready, so a bot created while the
 * engine was down gets its session when it comes back.
 */
export class EngineSessions extends Context.Service<
  EngineSessions,
  {
    /** Gives the bot its workspace, project and main session, whichever are missing. */
    readonly provision: (
      botId: BotId,
    ) => Effect.Effect<void, EngineDown | ProjectNotFound | ModelUnavailable>;
    /** Applies a new model or permission mode to the bot's main session. */
    readonly configure: (
      botId: BotId,
      changes: { readonly model?: ModelChoice; readonly permissionMode?: PermissionMode },
    ) => Effect.Effect<void, EngineDown | SessionNotFound | ModelUnavailable>;
    /** Removes the bot's project, and every session in it, from the engine. */
    readonly removeProject: (botId: BotId) => Effect.Effect<void, EngineDown>;
    /** The session an engine session id belongs to, if it is a live one of a bot. */
    readonly ofEngineSession: (sessionId: SessionId) => Effect.Effect<Option.Option<BotSession>>;
  }
>()("@j3-bots/server/bots/EngineSessions") {}

export const layer = Layer.effect(
  EngineSessions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* Engine;
    const bots = yield* BotStore;
    const workspaces = yield* Workspaces;
    const ids = yield* Ids;
    // One provisioning at a time: a bot's creation and a reconciliation may
    // both find its session missing.
    const provisioning = yield* Semaphore.make(1);

    const mainSession = SqlSchema.findOneOption({
      Request: BotId,
      Result: SessionRow,
      execute: (botId) => sql`
        SELECT id, bot_id, engine_session_id FROM sessions
        WHERE bot_id = ${botId} AND purpose = 'main' AND retired_at IS NULL
      `,
    });

    const byEngineSession = SqlSchema.findOneOption({
      Request: SessionId,
      Result: SessionRow,
      execute: (sessionId) => sql`
        SELECT id, bot_id, engine_session_id FROM sessions
        WHERE engine_session_id = ${sessionId} AND retired_at IS NULL
      `,
    });

    /** The bot's main session row, written now if it has none, on the bot's provider. */
    const ensureMainRow = Effect.fn("EngineSessions.ensureMainRow")(function* (
      botId: BotId,
      providerId: ProviderId,
    ) {
      const existing = yield* mainSession(botId);
      if (Option.isSome(existing)) return existing.value;
      const id = yield* ids.make("session");
      yield* sql`
        INSERT INTO sessions (id, bot_id, purpose, prompt_version, provider_id, created_at)
        VALUES (
          ${id}, ${botId}, 'main', ${PROMPT_VERSION}, ${providerId},
          ${timeText(yield* DateTime.now)}
        )
      `;
      return { id, bot_id: botId, engine_session_id: null };
    }, Effect.orDie);

    const provision = Effect.fn("EngineSessions.provision")(function* (botId: BotId) {
      const found = yield* bots.find(botId);
      if (Option.isNone(found)) return;
      const { bot, workspacePath, engineProjectId } = found.value;
      yield* workspaces.provision(botId);
      const session = yield* ensureMainRow(botId, bot.model.providerId);
      // Asked every time: it answers with the project the workspace already has.
      const projectId = yield* engine.ensureProject({ workspacePath, title: bot.profile.name });
      if (Option.getOrNull(engineProjectId) !== projectId) {
        yield* bots.setEngineProject(botId, projectId);
      }
      if (session.engine_session_id !== null) return;
      const sessionId = yield* engine.openSession({
        key: IdempotencyKey.make(session.id),
        projectId,
        title: "Main",
        model: bot.model,
        permissionMode: bot.permissionMode,
      });
      yield* sql`UPDATE sessions SET engine_session_id = ${sessionId} WHERE id = ${session.id}`.pipe(
        Effect.orDie,
      );
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

    const reconcile = Effect.gen(function* () {
      for (const { bot } of yield* bots.list) {
        yield* provision(bot.id).pipe(
          Effect.catch((error) =>
            Effect.logWarning("A bot's engine session could not be opened", {
              botId: bot.id,
              error: error._tag,
            }),
          ),
        );
      }
    });

    // Each time the engine becomes ready, every bot gets what it is missing.
    yield* engine.status.pipe(
      Stream.map((status) => status.state._tag === "ready"),
      Stream.changes,
      Stream.filter((ready) => ready),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped,
    );

    return EngineSessions.of({ provision, configure, removeProject, ofEngineSession });
  }),
);
