// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Avatar,
  Bot,
  type BotId,
  BotId as BotIdSchema,
  type CommandError,
  CommandId,
  Conflict,
  Invalid,
  type ModelChoice,
  NotFound,
  type PermissionMode,
  ProviderId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Attachments } from "../attachments/Attachments.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { EngineState } from "../engine/EngineState.ts";
import { Ids } from "../Ids.ts";
import { Layout } from "../Layout.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Ledger } from "../turns/Ledger.ts";
import { rotationRequests } from "../turns/rotationRequests.ts";
import { Signals } from "../turns/Signals.ts";
import { Stops } from "../turns/Stops.ts";
import { conversation } from "../turns/model.ts";
import { Wakes } from "../turns/Wakes.ts";
import { freeAvatar } from "./avatars.ts";
import { type BotChanges, BotStore, type ModelChooser } from "./BotStore.ts";
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
    /**
     * Saves the bot with a `first-run` system wake, so its first turn opens
     * its conversation, then opens its main session if the engine can.
     */
    readonly create: (input: {
      readonly commandId: CommandId;
      readonly draft: BotDraft;
    }) => Effect.Effect<Bot, CommandError>;
    /**
     * Succeeds once the change is saved. A model of another provider stops
     * the bot's work in progress, then replaces its main session, with a
     * digest of the conversation. Another model of the same provider, or a
     * permission mode, is applied to the session by the rotator before its
     * next turn, once a turn running there has ended: the session takes no
     * work until the engine has it, retried while the engine is unavailable,
     * and held while it runs background work the change would end, which the
     * bot's conversation is told (`EngineSessions`).
     */
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly changes: BotChanges;
    }) => Effect.Effect<Bot, CommandError>;
    /**
     * Moves each bot still waiting for its hello to go out (not yet with the
     * engine), whose model the server chose and whose provider is not ready,
     * to the server's default model once that model's provider is ready, the
     * way the operator's change of provider moves it, its hello and the
     * operator's messages held behind it kept. A model the operator chose is
     * never moved. Run whenever a provider's state changes and after a bot is
     * created; one pass at a time.
     */
    readonly adoptDefaults: Effect.Effect<void>;
    /**
     * Stops the bot's work in progress, then replaces its main session with
     * a fresh one, which gets no digest of the conversation. Its memory files
     * stay.
     */
    readonly freshStart: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
    }) => Effect.Effect<void, CommandError>;
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
    const signals = yield* Signals;
    const stops = yield* Stops;
    const wakes = yield* Wakes;
    const ledger = yield* Ledger;
    const { requestBotRotation, providerRestored, forgetConversation } = rotationRequests(
      sql,
      signals,
    );

    /** The provider of the bot's live main session, if it has one. */
    const liveMainProvider = (botId: BotId) =>
      SqlSchema.findOneOption({
        Request: BotIdSchema,
        Result: Schema.Struct({ provider_id: ProviderId }),
        execute: (id) => sql`
          SELECT provider_id FROM sessions
          WHERE bot_id = ${id} AND purpose = 'main' AND retired_at IS NULL
        `,
      })(botId).pipe(Effect.orDie, Effect.map(Option.map((row) => row.provider_id)));

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
     * Opens the bot's engine session now if it can. A failure leaves it to
     * the rotator, which opens every live bot's missing main session.
     */
    const provision = (botId: BotId) =>
      sessions.provision(botId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("A new bot's engine session will be opened later", {
            botId,
            error: error._tag,
          }).pipe(Effect.andThen(signals.rotations.fire)),
        ),
      );

    /**
     * The bots whose hello the engine does not have yet (its `first-run`
     * wake waits, or is in a dispatch never sent) and whose model the server
     * chose.
     */
    const waitingOnServerModelSql = sql`
      b.model_by_server = 1 AND EXISTS (
        SELECT 1 FROM wakes w LEFT JOIN dispatches d ON d.id = w.dispatch_id
        WHERE w.bot_id = b.id AND json_extract(w.payload_json, '$._tag') = 'first-run'
          AND (
            w.status = 'pending'
            OR (w.status = 'dispatched' AND d.status = 'intended' AND d.attempts = 0)
          )
      )
    `;

    const waitingOnServerModel = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: BotIdSchema, provider_id: ProviderId }),
      execute: () => sql`SELECT b.id, b.provider_id FROM bots b WHERE ${waitingOnServerModelSql}`,
    });

    const waitsOnServerModel = (botId: BotId) =>
      sql`SELECT 1 FROM bots b WHERE b.id = ${botId} AND ${waitingOnServerModelSql}`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      );

    /**
     * Saves a change, the server's own only while the bot still waits on the
     * model it chose (`waitsOnServerModel`): one that finds it otherwise, the
     * operator having chosen a model or the hello gone out meanwhile, changes
     * nothing.
     */
    const applyChange = Effect.fn("Bots.change")(function* (
      input: {
        readonly commandId: CommandId;
        readonly botId: BotId;
        readonly changes: BotChanges;
      },
      chooser: ModelChooser,
    ) {
      const { changes: change } = input;
      /** Saves the change; `settingsChanged` records a new model or permission mode. */
      const save = <E>(settingsChanged: Effect.Effect<void, E>) =>
        receipts.once({
          commandId: input.commandId,
          method: "bot.update",
          payload: input,
          result: Bot,
          apply: Effect.gen(function* () {
            const before = yield* require(input.botId);
            if (chooser === "server" && !(yield* waitsOnServerModel(input.botId))) {
              return before.bot;
            }
            if (change.model !== undefined) yield* checkModel(change.model);
            const at = yield* DateTime.now;
            if (change.primary === true && !before.bot.primary) yield* makePrimary(at);
            yield* store.update(input.botId, change, at, chooser);
            yield* settingsChanged;
            // Compared with the provider the bot's live main session runs on, in
            // this transaction: an earlier change may not have reached it yet.
            // Moving to another provider stops the work in progress before the
            // session is replaced, but leaves a hello the bot has not sent yet,
            // and the operator's messages waiting behind it, to run on the new
            // one. Moving back before that keeps the session.
            if (change.model !== undefined) {
              const live = yield* liveMainProvider(input.botId);
              if (Option.isSome(live) && live.value !== change.model.providerId) {
                yield* stops.record(input.botId, { _tag: "bot" }, { keepOpening: true });
                yield* requestBotRotation(input.botId, "provider-changed");
              } else if (Option.isSome(live)) {
                yield* providerRestored(input.botId);
              }
            }
            yield* changes.touch({ _tag: "bot", botId: input.botId });
            return (yield* require(input.botId).pipe(Effect.orDie)).bot;
          }),
        });
      // A new model or permission mode is saved in the gate of the bot's main
      // session, so no send claimed before it reaches the engine after it.
      const bot =
        change.model !== undefined || change.permissionMode !== undefined
          ? yield* sessions.inMainSessionGate(input.botId, (held) =>
              save(sessions.settingsChanged(held)),
            )
          : yield* save(Effect.void);
      if (change.profile !== undefined || change.model !== undefined) {
        yield* workspaces.render(bot.id);
      }
      return bot;
    });

    const update = (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly changes: BotChanges;
    }) => applyChange(input, "operator");

    const adoptPermit = yield* Semaphore.make(1);

    const adoptDefaults = adoptPermit.withPermits(1)(
      Effect.gen(function* () {
        const fallback = yield* engineState.defaultModel;
        if (Option.isNone(fallback)) return;
        const { providers } = yield* engineState.current;
        const ready = (providerId: string) =>
          providers.some((p) => p.id === providerId && p.status._tag === "ready");
        if (!ready(fallback.value.providerId)) return;
        for (const bot of yield* waitingOnServerModel(undefined).pipe(Effect.orDie)) {
          if (bot.provider_id === fallback.value.providerId || ready(bot.provider_id)) continue;
          const commandId = CommandId.make(yield* ids.make("default-model"));
          yield* applyChange(
            { commandId, botId: bot.id, changes: { model: fallback.value } },
            "server",
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("A new bot could not move to the default model", {
                botId: bot.id,
                error: error._tag,
              }),
            ),
          );
        }
      }).pipe(Effect.withSpan("Bots.adoptDefaults")),
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
            modelChooser: draft.model === undefined ? "server" : "operator",
            permissionMode:
              draft.permissionMode ?? (yield* engineState.defaultPermissionMode(model)),
            primary: draft.primary === true,
            workspacePath: layout.workspace(id),
            at,
          });
          // The bot opens its conversation: its first turn is this wake's,
          // written once, with the bot, and dispatched like any other. Its
          // cause is the operator's, as the creation is, also when the primary
          // bot's `create_bot` carried their word: it follows from no
          // dispatch's work, so no Stop of earlier work can drop it unwritten.
          yield* wakes.record([
            {
              botId: id,
              kind: "system",
              audience: conversation,
              payload: { _tag: "first-run" },
              sourceEntryId: null,
              hops: 0,
              retryOf: null,
              cause: { _tag: "operator" },
            },
          ]);
          yield* changes.touch({ _tag: "bot", botId: id });
          return (yield* require(id).pipe(Effect.orDie)).bot;
        }),
      });
      // Also after a retry: a creation that crashed before this point finishes now.
      yield* provision(bot.id);
      // A provider may have become ready while the bot was saved, after the
      // default was read.
      yield* adoptDefaults;
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
      // the deletion finds no bot here and gets the receipt. No provisioning
      // runs from the removal to the commit, or the rotator could open the
      // bot's session again in a project made anew.
      yield* sessions.withoutProvisioning(
        Effect.gen(function* () {
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
              // What teammates sent it and it never read will not reach it:
              // their cards say so before its wakes and inbox go.
              yield* ledger.recipientRemoved(input.botId);
              const carried = yield* attachments.ofTarget({
                _tag: "conversation",
                botId: input.botId,
              });
              yield* store.remove(input.botId);
              yield* attachments.purge(carried);
              yield* changes.touch({ _tag: "bot", botId: input.botId });
              yield* sql.afterCommit(workspaces.remove(input.botId, input.deleteFiles));
            }),
          });
        }),
      );
    });

    const freshStart = Effect.fn("Bots.freshStart")(function* (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "bot.freshStart",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          yield* require(input.botId);
          // A clean slate: the work in progress stops, and nothing of the
          // conversation so far reaches the new session or its successors.
          yield* stops.record(input.botId, { _tag: "bot" });
          yield* forgetConversation(input.botId);
          yield* requestBotRotation(input.botId, "fresh-start");
        }),
      });
    });

    return Bots.of({ create, update, adoptDefaults, freshStart, remove });
  }),
);
