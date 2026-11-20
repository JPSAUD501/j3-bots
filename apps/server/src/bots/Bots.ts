// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Avatar,
  Bot,
  type BotId,
  BotId as BotIdSchema,
  type CommandError,
  type CommandId,
  Conflict,
  Invalid,
  type ModelChoice,
  NotFound,
  type PermissionMode,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Attachments } from "../attachments/Attachments.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Ids } from "../Ids.ts";
import { Layout } from "../Layout.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { freeAvatar } from "./avatars.ts";
import { type BotChanges, BotStore } from "./BotStore.ts";
import { EngineSessions } from "./EngineSessions.ts";
import { Workspaces } from "./Workspaces.ts";

/** What a new bot is given; what is left out takes the server's default. */
export interface BotDraft {
  readonly name: string;
  readonly title?: string;
  readonly avatar?: Avatar;
  readonly job?: string;
  readonly model?: ModelChoice;
  readonly permissionMode?: PermissionMode;
  readonly primary?: boolean;
}

/**
 * Bots: creating, changing and deleting them, with what each of those means
 * for the bot's workspace, its engine project and its rooms.
 */
export class Bots extends Context.Service<
  Bots,
  {
    readonly create: (input: {
      readonly commandId: CommandId;
      readonly draft: BotDraft;
    }) => Effect.Effect<Bot, CommandError>;
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly changes: BotChanges;
    }) => Effect.Effect<Bot, CommandError>;
    /**
     * Retires the bot's engine project first, so nothing runs for a bot that no
     * longer exists, then removes the bot as `docs/architecture/server.md`
     * (Deleting a bot) describes. Fails with `Conflict("engine-unavailable")`,
     * changing nothing, while the engine cannot take the removal.
     */
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly deleteFiles: boolean;
    }) => Effect.Effect<void, CommandError>;
  }
>()("@j3-bots/server/bots/Bots") {}

export const layer = Layer.effect(
  Bots,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* BotStore;
    const rooms = yield* Rooms;
    const attachments = yield* Attachments;
    const sessions = yield* EngineSessions;
    const engineState = yield* EngineState;
    const workspaces = yield* Workspaces;
    const receipts = yield* CommandReceipts;
    const changes = yield* ChangeLog;
    const layout = yield* Layout;
    const ids = yield* Ids;

    const require = Effect.fn("Bots.require")(function* (botId: BotId) {
      const found = yield* store.find(botId);
      if (Option.isNone(found)) return yield* new NotFound({ resource: "bot" });
      return found.value;
    });

    /** A model the engine offers now. */
    const checkModel = Effect.fn("Bots.checkModel")(function* (model: ModelChoice) {
      const { providers } = yield* engineState.current;
      const offered = providers.some(
        (provider) =>
          provider.id === model.providerId &&
          provider.models.some((candidate) => candidate.id === model.modelId),
      );
      if (!offered) return yield* new Invalid({ reason: "model" });
    });

    /** Makes `botId` the one primary bot, telling subscribers about the one it replaces. */
    const makePrimary = Effect.fn("Bots.makePrimary")(function* (at: DateTime.Utc) {
      for (const previous of yield* store.clearPrimary(at)) {
        yield* changes.touch({ _tag: "bot", botId: previous });
      }
    });

    /**
     * Opens the bot's engine session now if it can. A failure leaves it for
     * the reconciliation that runs each time the engine is ready.
     */
    const provision = (botId: BotId) =>
      sessions.provision(botId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("A new bot's engine session will be opened later", {
            botId,
            error: error._tag,
          }),
        ),
      );

    const create = Effect.fn("Bots.create")(function* (input: {
      readonly commandId: CommandId;
      readonly draft: BotDraft;
    }) {
      const { draft } = input;
      const bot = yield* receipts.once({
        commandId: input.commandId,
        method: "bot.create",
        payload: input.draft,
        result: Bot,
        apply: Effect.gen(function* () {
          const model = draft.model ?? Option.getOrNull(yield* engineState.defaultModel);
          if (model === null) return yield* new Invalid({ reason: "model" });
          yield* checkModel(model);
          const at = yield* DateTime.now;
          const id = BotIdSchema.make(yield* ids.make("bot"));
          if (draft.primary === true) yield* makePrimary(at);
          yield* store.insert({
            id,
            profile: {
              name: draft.name,
              title: draft.title ?? "",
              avatar: draft.avatar ?? freeAvatar(yield* store.avatars),
              job: draft.job ?? "",
            },
            model,
            permissionMode:
              draft.permissionMode ?? (yield* engineState.defaultPermissionMode(model)),
            primary: draft.primary === true,
            workspacePath: layout.workspace(id),
            at,
          });
          yield* changes.touch({ _tag: "bot", botId: id });
          return (yield* require(id).pipe(Effect.orDie)).bot;
        }),
      });
      // Also after a retry: a creation that crashed before this point finishes now.
      yield* provision(bot.id);
      return bot;
    });

    const update = Effect.fn("Bots.update")(function* (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly changes: BotChanges;
    }) {
      const { changes: change } = input;
      const before = yield* require(input.botId);
      const bot = yield* receipts.once({
        commandId: input.commandId,
        method: "bot.update",
        payload: input,
        result: Bot,
        apply: Effect.gen(function* () {
          if (change.model !== undefined) yield* checkModel(change.model);
          const at = yield* DateTime.now;
          if (change.primary === true && !before.bot.primary) yield* makePrimary(at);
          yield* store.update(input.botId, change, at);
          yield* changes.touch({ _tag: "bot", botId: input.botId });
          return (yield* require(input.botId).pipe(Effect.orDie)).bot;
        }),
      });
      if (change.profile !== undefined || change.model !== undefined) {
        yield* workspaces.render(bot.id);
      }
      if (change.model !== undefined || change.permissionMode !== undefined) {
        // Rotating the session when the provider changes is the wake
        // pipeline's (`docs/architecture/server.md`, Sessions); until then the
        // main session takes the new settings from its next turn.
        yield* sessions
          .configure(bot.id, {
            ...(change.model === undefined ? {} : { model: change.model }),
            ...(change.permissionMode === undefined
              ? {}
              : { permissionMode: change.permissionMode }),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("A bot's engine session keeps its previous settings", {
                botId: bot.id,
                error: error._tag,
              }),
            ),
          );
      }
      return bot;
    });

    const remove = Effect.fn("Bots.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly deleteFiles: boolean;
    }) {
      // Outside the transaction, which an engine call must not hold open, and
      // first: removing a project already gone succeeds, so a deletion that
      // fails after it is retried whole, while a project left behind by a
      // deletion that committed first would never be removed. A retry after
      // the deletion finds no bot here and gets the receipt.
      if (Option.isSome(yield* store.find(input.botId))) {
        yield* sessions
          .removeProject(input.botId)
          .pipe(Effect.catch(() => new Conflict({ reason: "engine-unavailable" })));
      }
      yield* receipts.once({
        commandId: input.commandId,
        method: "bot.delete",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          yield* require(input.botId);
          yield* rooms.releaseBot(input.botId);
          const carried = yield* attachments.ofTarget({ _tag: "conversation", botId: input.botId });
          yield* store.remove(input.botId);
          yield* attachments.purge(carried);
          yield* changes.touch({ _tag: "bot", botId: input.botId });
          yield* sql.afterCommit(workspaces.remove(input.botId, input.deleteFiles));
        }),
      });
    });

    return Bots.of({ create, update, remove });
  }),
);
