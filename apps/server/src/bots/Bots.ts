// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Avatar,
  AvatarChoice,
  Bot,
  type BotId,
  BotId as BotIdSchema,
  type BotTemplate,
  type CommandError,
  CommandId,
  defaultPermissionMode,
  type EffortLevel,
  type EngineStatus,
  Conflict,
  Invalid,
  type ModelChoice,
  modelEfforts,
  NotFound,
  type PermissionMode,
  ProviderId,
  type RoutineTrigger,
  templatePermissionMode,
  type TemplateTrigger,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Attachments } from "../attachments/Attachments.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { defaultModelIn, EngineState, providerReady } from "../engine/EngineState.ts";
import { Ids } from "../Ids.ts";
import { WORKSPACE_ENTRIES } from "../home/entries.ts";
import { Layout } from "../Layout.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Sections } from "../sections/Sections.ts";
import { Routines } from "../routines/Routines.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { Ledger } from "../turns/Ledger.ts";
import { rotationRequests } from "../turns/rotationRequests.ts";
import { Signals } from "../turns/Signals.ts";
import { Stops } from "../turns/Stops.ts";
import { conversation, type MadeIn } from "../turns/model.ts";
import { openingUnsentSql } from "../turns/openings.ts";
import { Wakes } from "../turns/Wakes.ts";
import { freeAvatar } from "@j3-bots/design-tokens/names";
import { type BotChanges, BotStore, type Chooser, type StoredBot } from "./BotStore.ts";
import { EngineSessions } from "./EngineSessions.ts";
import { SKILL_FILE } from "./Templates.ts";
import { Workspaces } from "./Workspaces.ts";
import {
  type Shown,
  visibilityCommand,
  VisibilityRefused,
  visibilityRefusal,
} from "../roster/visibility.ts";

/** What a new bot is given; what is left out takes the server's default. */
export interface BotDraft {
  readonly name: string;
  readonly title?: string;
  readonly avatar?: Avatar;
  readonly job?: string;
  readonly model?: ModelChoice;
  readonly permissionMode?: PermissionMode;
  readonly primary?: boolean;
  /** Among the hidden conversations from the start; visible when left out. */
  readonly hidden?: boolean;
}

/** What a template brings to a new bot, and what the operator chose for it. */
export interface FromTemplate {
  readonly template: BotTemplate;
  /** The operator's pick; left out, the template's where the engine offers it, or the default. */
  readonly model?: ModelChoice;
  /** The operator's pick; left out, `templatePermissionMode`. */
  readonly permissionMode?: PermissionMode;
  readonly hidden?: boolean;
}

const isAvatarChoice = Schema.is(AvatarChoice);

/** Whether the engine offers `model` now. */
const offered = (status: EngineStatus, model: ModelChoice) =>
  status.providers.some(
    (provider) =>
      provider.id === model.providerId &&
      provider.models.some((candidate) => candidate.id === model.modelId),
  );

/** Whether the engine reports `effort` as a level of `model` now. */
const effortOffered = (status: EngineStatus, model: ModelChoice, effort: EffortLevel) =>
  (modelEfforts(status, model) ?? []).some((choice) => choice.id === effort);

/**
 * `change` as it is saved for `bot`: a new model that the bot's effort is not
 * a level of, with no effort of its own, takes the bot back to the harness's
 * default effort, so the bot never keeps a level its model lacks.
 */
const withEffortFallback = (status: EngineStatus, bot: Bot, change: BotChanges): BotChanges =>
  change.model !== undefined &&
  change.effort === undefined &&
  bot.effort !== null &&
  !effortOffered(status, change.model, bot.effort)
    ? { ...change, effort: null }
    : change;

/**
 * A bot that another bot's `create_bot` makes, in the turn that called it
 * (`turns/Speech.ts`).
 */
export interface MadeBy<E> {
  /** The bot that calls it, whose model the new bot takes (`Bots.create`). */
  readonly maker: BotId;
  /** That turn: the bot's hello waits for it to end (`WakePayload`, `first-run`). */
  readonly turn: MadeIn;
  /**
   * Runs in the transaction that saves the bot, once it has its id and before
   * the bot is written: a failure saves nothing, and leaves no workspace behind.
   */
  readonly claim: (botId: BotId) => Effect.Effect<void, E>;
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
     * its conversation, then opens its main session if the engine can. A bot
     * another bot makes (`madeBy`) is saved with that bot's claim on its turn,
     * and, when its draft names no model, runs on its maker's: the same
     * provider and model, while the engine offers that model and its provider
     * is ready. Otherwise it takes the default, as any bot created without a
     * model does. Its visibility is the operator's choice, or its maker's for
     * one another bot makes (decision 0050).
     */
    readonly create: <E = never>(input: {
      readonly commandId: CommandId;
      readonly draft: BotDraft;
      readonly madeBy?: MadeBy<E>;
    }) => Effect.Effect<Bot, CommandError | E>;
    /**
     * Creates a bot from a template as `create` creates one, in the same
     * transaction as the template's routines, each created paused, and its
     * skills, written to the new workspace's `skills/<name>/SKILL.md`. The
     * template reaches nothing else: the bot is never primary, and its
     * routines run in the operator's time zone. A creation that fails, at any
     * step, removes the workspace it started, skills included.
     */
    readonly createFromTemplate: (input: {
      readonly commandId: CommandId;
      readonly from: FromTemplate;
    }) => Effect.Effect<Bot, CommandError>;
    /**
     * Succeeds once the change is saved. A model of another provider stops
     * the bot's work in progress, then replaces its main session, with a
     * digest of the conversation. Another model of the same provider, an
     * effort, or a permission mode, is applied to the session by the rotator
     * before its next turn, once a turn running there has ended: the session
     * takes no work until the engine has it, retried while the engine is
     * unavailable, and held while it runs background work the change would
     * end, which the bot's conversation is told (`EngineSessions`). A new
     * model the bot's effort is not a level of takes it back to the default
     * effort.
     */
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly changes: BotChanges;
    }) => Effect.Effect<Bot, CommandError>;
    /**
     * A bot's `set_visibility` for a bot: shows or hides it as `caller` asks,
     * when `visibilityRefusal` lets it, decided in the transaction that saves
     * it, so a choice the operator just made wins. Whose choice the
     * visibility is stays as it was.
     */
    readonly showOrHide: (input: {
      readonly commandId: CommandId;
      readonly caller: BotId;
      readonly botId: BotId;
      readonly hidden: boolean;
    }) => Effect.Effect<Shown, CommandError | VisibilityRefused>;
    /**
     * Moves each bot still waiting for its hello to go out (not yet with the
     * engine), whose model the server chose and whose provider is not ready,
     * to the server's default model once that model's provider is ready, the
     * way the operator's change of provider moves it, its hello and the
     * operator's messages held behind it kept. A model the operator chose is
     * never moved. Each move is decided again in the transaction that saves
     * it, from the engine's status then. Run whenever a provider's state or
     * whether it lists models changes, and after a bot is created, for it
     * alone (`only`); one pass at a time.
     */
    readonly adoptDefaults: (only?: BotId) => Effect.Effect<void>;
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
    const sections = yield* Sections;
    const attachments = yield* Attachments;
    const sessions = yield* EngineSessions;
    const engineState = yield* EngineState;
    const workspaces = yield* Workspaces;
    const receipts = yield* CommandReceipts;
    const changes = yield* ChangeLog;
    const layout = yield* Layout;
    const ids = yield* Ids;
    const routines = yield* Routines;
    const settingsStore = yield* SettingsStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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
    const checkModel = Effect.fn("Bots.checkModel")(function* (
      status: EngineStatus,
      model: ModelChoice,
    ) {
      if (!offered(status, model)) return yield* new Invalid({ reason: "model" });
    });

    /** A level the engine reports for `model` now; the model's own check says why not. */
    const checkEffort = Effect.fn("Bots.checkEffort")(function* (
      status: EngineStatus,
      model: ModelChoice,
      effort: EffortLevel,
    ) {
      if (!effortOffered(status, model, effort)) return yield* new Invalid({ reason: "model" });
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
     * The bots whose hello the engine does not have yet (`openingUnsentSql`)
     * and whose model the server chose, read where `b` is the bot's row.
     */
    const waitingOnServerModelSql = sql`
      b.model_by_server = 1 AND ${openingUnsentSql(sql, { botId: sql.literal("b.id") })}
    `;

    /** Those bots, or that one alone, the ones created first first. */
    const waitingOnServerModel = SqlSchema.findAll({
      Request: Schema.NullOr(BotIdSchema),
      Result: Schema.Struct({ id: BotIdSchema }),
      execute: (only) => sql`
        SELECT b.id FROM bots b
        WHERE ${waitingOnServerModelSql} ${only === null ? sql`` : sql`AND b.id = ${only}`}
        ORDER BY b.rowid
      `,
    });

    const serverChoices = SqlSchema.findOneOption({
      Request: BotIdSchema,
      Result: Schema.Struct({
        waiting: Schema.BooleanFromBit,
        permission_mode_by_server: Schema.BooleanFromBit,
      }),
      execute: (botId) => sql`
        SELECT ${waitingOnServerModelSql} AS waiting, b.permission_mode_by_server
        FROM bots b WHERE b.id = ${botId}
      `,
    });

    /**
     * Where the server moves a bot that waits on the model it chose, decided
     * from one engine status: nowhere while the bot's own provider is ready,
     * or while no other provider's default model is ready to take it.
     * Otherwise to that model, and to its default permission mode when the
     * server chose the bot's permission mode too.
     */
    const moveIn = (
      status: EngineStatus,
      bot: Bot,
      permissionModeByServer: boolean,
    ): Option.Option<BotChanges> => {
      if (providerReady(status, bot.model.providerId)) return Option.none();
      const fallback = defaultModelIn(status);
      if (
        Option.isNone(fallback) ||
        fallback.value.providerId === bot.model.providerId ||
        !providerReady(status, fallback.value.providerId)
      ) {
        return Option.none();
      }
      return Option.some(
        permissionModeByServer
          ? {
              model: fallback.value,
              permissionMode: defaultPermissionMode(status, fallback.value),
            }
          : { model: fallback.value },
      );
    };

    /**
     * Saves a change, decided in its transaction (`decide`) from the bot as it
     * is then and one engine status read there: a change that no longer
     * applies saves nothing. A new model or permission mode is recorded as
     * `chooser`'s choice.
     */
    const applyChange = Effect.fn("Bots.change")(function* (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      /** What the command's receipt records it was asked. */
      readonly payload: unknown;
      /** Whether it may change the model, its effort, the permission mode or the browser. */
      readonly settings: boolean;
      /** Whether it may change what the bot's instructions say: its profile, model or browser switch. */
      readonly instructions: boolean;
      readonly chooser: Chooser;
      readonly decide: (
        before: StoredBot,
        status: EngineStatus,
      ) => Effect.Effect<Option.Option<BotChanges>>;
    }) {
      /** Saves the change; `settingsChanged` records a new model, effort, permission mode or browser. */
      const save = <F>(settingsChanged: Effect.Effect<void, F>) =>
        receipts.once({
          commandId: input.commandId,
          method: "bot.update",
          payload: input.payload,
          result: Bot,
          apply: Effect.gen(function* () {
            const before = yield* require(input.botId);
            const status = yield* engineState.current;
            const decided = yield* input.decide(before, status);
            if (Option.isNone(decided)) return before.bot;
            const change = withEffortFallback(status, before.bot, decided.value);
            if (change.model !== undefined) yield* checkModel(status, change.model);
            if (change.effort !== undefined && change.effort !== null) {
              yield* checkEffort(status, change.model ?? before.bot.model, change.effort);
            }
            if (change.sectionId !== undefined && change.sectionId !== null) {
              yield* sections.require(change.sectionId);
            }
            const at = yield* DateTime.now;
            if (change.primary === true && !before.bot.primary) yield* makePrimary(at);
            yield* store.update(input.botId, change, at, input.chooser);
            yield* settingsChanged;
            // Compared with the provider the bot's live main session runs on, in
            // this transaction: an earlier change may not have reached it yet.
            // Moving to another provider stops the work in progress before the
            // session is replaced, but leaves a hello the bot has not sent yet,
            // and the operator's messages waiting behind it, to run on the new
            // one. Moving back before that keeps the session.
            let stopped = false;
            if (change.model !== undefined) {
              const live = yield* liveMainProvider(input.botId);
              if (Option.isSome(live) && live.value !== change.model.providerId) {
                yield* stops.record(input.botId, { _tag: "bot" }, { keepOpening: true });
                stopped = true;
                yield* requestBotRotation(input.botId, "provider-changed");
              } else if (Option.isSome(live)) {
                yield* providerRestored(input.botId);
              }
            }
            // Taking the browser away stops the work in progress the same way,
            // so no turn goes on with it, nor one the engine would start
            // behind it on the same credential; the alignment then withdraws
            // it from every thread of the bot's project.
            if (change.browser === false && before.bot.browser && !stopped) {
              yield* stops.record(input.botId, { _tag: "bot" }, { keepOpening: true });
            }
            yield* changes.touch({ _tag: "bot", botId: input.botId });
            return (yield* require(input.botId).pipe(Effect.orDie)).bot;
          }),
        });
      // A new model, permission mode or browser is saved in the gate of the
      // bot's main session, so no send claimed before it reaches the engine
      // after it.
      const bot = input.settings
        ? yield* sessions.inMainSessionGate(input.botId, (held) =>
            save(sessions.settingsChanged(held)),
          )
        : yield* save(Effect.void);
      if (input.instructions) yield* workspaces.render(bot.id);
      return bot;
    });

    const update = (input: {
      readonly commandId: CommandId;
      readonly botId: BotId;
      readonly changes: BotChanges;
    }) =>
      applyChange({
        commandId: input.commandId,
        botId: input.botId,
        payload: input,
        settings:
          input.changes.model !== undefined ||
          input.changes.effort !== undefined ||
          input.changes.permissionMode !== undefined ||
          input.changes.browser !== undefined,
        // The browser's rules come and go with its switch.
        instructions:
          input.changes.profile !== undefined ||
          input.changes.model !== undefined ||
          input.changes.browser !== undefined,
        chooser: "operator",
        decide: () => Effect.succeedSome(input.changes),
      });

    /**
     * The server's move of one bot, decided in the transaction that saves it
     * (`moveIn`): only while the bot still waits on the model the server
     * chose, so the operator's own choice, saved first, wins, and from the
     * engine's status then, whatever it was when the pass began.
     */
    const moveToDefault = Effect.fn("Bots.moveToDefault")(function* (botId: BotId) {
      const commandId = CommandId.make(yield* ids.make("default-model"));
      yield* applyChange({
        commandId,
        botId,
        payload: { commandId, botId },
        settings: true,
        instructions: true,
        chooser: "server",
        decide: (before, status) =>
          serverChoices(botId).pipe(
            Effect.orDie,
            Effect.map((choices) =>
              Option.isSome(choices) && choices.value.waiting
                ? moveIn(status, before.bot, choices.value.permission_mode_by_server)
                : Option.none(),
            ),
          ),
      });
    });

    const adoptPermit = yield* Semaphore.make(1);

    const adoptDefaults = (only?: BotId) =>
      adoptPermit.withPermits(1)(
        Effect.gen(function* () {
          // A first look, so a pass with nothing to move takes no gate. Each
          // move decides again for itself.
          const status = yield* engineState.current;
          for (const bot of yield* waitingOnServerModel(only ?? null).pipe(Effect.orDie)) {
            const found = yield* store.find(bot.id);
            if (Option.isNone(found) || Option.isNone(moveIn(status, found.value.bot, false))) {
              continue;
            }
            yield* moveToDefault(bot.id).pipe(
              // Deleted, or its new model no longer offered, since the first look.
              Effect.catch((error) =>
                Effect.logInfo("A bot stays on its model").pipe(
                  Effect.annotateLogs({ botId: bot.id, reason: error._tag }),
                ),
              ),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("A new bot could not move to the default model", cause).pipe(
                    Effect.annotateLogs({ botId: bot.id }),
                  ),
              ),
            );
          }
        }).pipe(Effect.withSpan("Bots.adoptDefaults")),
      );

    /**
     * Saves a new bot, and what `furnish` adds to it in the same transaction,
     * under one receipt. `draft` is decided there, from the engine's status
     * then; a model it leaves out is `serverModel`'s, and a permission mode
     * `permissionMode`'s, for the model the bot gets. A bot another bot makes
     * (`madeBy`) is claimed on its maker's turn before it is saved, so a maker
     * deleted meanwhile, whose turn went with it, saves nothing; its hello
     * waits for that turn to end.
     */
    const insert = <E>(input: {
      readonly commandId: CommandId;
      readonly method: "bot.create" | "bot.createFromTemplate";
      readonly payload: unknown;
      readonly draft: (status: EngineStatus) => BotDraft;
      /** The model the server chooses for a draft that names none, or none to choose. */
      readonly serverModel: (status: EngineStatus) => Effect.Effect<Option.Option<ModelChoice>>;
      readonly permissionMode: (status: EngineStatus, model: ModelChoice) => PermissionMode;
      /** Who a permission mode is recorded as chosen by. */
      readonly permissionModeChooser: (draft: BotDraft) => Chooser;
      readonly furnish: (botId: BotId) => Effect.Effect<void, CommandError>;
      /** The bot whose `create_bot` makes it, in that turn, or null for the operator's. */
      readonly madeBy: MadeBy<E> | null;
      /** It is made from a template, which its first wake tells it. */
      readonly fromTemplate: boolean;
    }): Effect.Effect<Bot, CommandError | E> =>
      Effect.gen(function* () {
        // The bot being saved, once it has an id: a creation that fails leaves
        // no workspace behind, whatever had begun to fill it.
        const started = yield* Ref.make(Option.none<BotId>());
        const bot = yield* receipts
          .once({
            commandId: input.commandId,
            method: input.method,
            payload: input.payload,
            result: Bot,
            apply: Effect.gen(function* () {
              const status = yield* engineState.current;
              const draft = input.draft(status);
              const model = draft.model ?? Option.getOrNull(yield* input.serverModel(status));
              if (model === null) return yield* new Invalid({ reason: "model" });
              yield* checkModel(status, model);
              const at = yield* DateTime.now;
              const id = BotIdSchema.make(yield* ids.make("bot"));
              yield* Ref.set(started, Option.some(id));
              if (input.madeBy !== null) yield* input.madeBy.claim(id);
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
                permissionMode: draft.permissionMode ?? input.permissionMode(status, model),
                permissionModeChooser: input.permissionModeChooser(draft),
                primary: draft.primary === true,
                hidden: draft.hidden === true,
                madeBy: input.madeBy?.maker ?? null,
                workspacePath: layout.workspace(id),
                at,
              });
              yield* input.furnish(id);
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
                  payload: {
                    _tag: "first-run",
                    ...(input.madeBy === null ? {} : { madeIn: input.madeBy.turn }),
                    ...(input.fromTemplate ? { fromTemplate: true } : {}),
                  },
                  sourceEntryId: null,
                  hops: 0,
                  retryOf: null,
                  cause: { _tag: "operator" },
                },
              ]);
              yield* changes.touch({ _tag: "bot", botId: id });
              return (yield* require(id).pipe(Effect.orDie)).bot;
            }),
          })
          .pipe(
            Effect.onError(() =>
              Ref.get(started).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: (id) => fs.remove(layout.workspace(id), { recursive: true }),
                  }),
                ),
                Effect.ignore,
              ),
            ),
          );
        // Also after a retry: a creation that crashed before this point finishes now.
        yield* provision(bot.id);
        // A provider may have become ready while the bot was saved, after the
        // default was read. Only this bot: the others' moves are not this
        // command's, and nothing of one fails it.
        yield* adoptDefaults(bot.id).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logWarning("A new bot could not move to the default model", cause),
          ),
        );
        return bot;
      }).pipe(Effect.withSpan("Bots.insert"));

    /**
     * The model of a bot `maker` makes: `maker`'s own, while the engine
     * offers it and its provider is ready, so a team runs where the bot that
     * made it does; otherwise the default.
     */
    const makerModel = Effect.fn("Bots.makerModel")(function* (status: EngineStatus, maker: BotId) {
      const found = yield* store.find(maker);
      if (Option.isSome(found)) {
        const { model } = found.value.bot;
        if (offered(status, model) && providerReady(status, model.providerId)) {
          return Option.some(model);
        }
      }
      return defaultModelIn(status);
    });

    const create = <E = never>(input: {
      readonly commandId: CommandId;
      readonly draft: BotDraft;
      readonly madeBy?: MadeBy<E>;
    }) =>
      insert<E>({
        commandId: input.commandId,
        method: "bot.create",
        payload: input.draft,
        draft: () => input.draft,
        serverModel: (status) =>
          input.madeBy === undefined
            ? Effect.succeed(defaultModelIn(status))
            : makerModel(status, input.madeBy.maker),
        permissionMode: defaultPermissionMode,
        permissionModeChooser: (draft) =>
          draft.permissionMode === undefined ? "server" : "operator",
        furnish: () => Effect.void,
        madeBy: input.madeBy ?? null,
        fromTemplate: false,
      });

    /** A template's trigger as the operator's routine runs it: a schedule in their time zone. */
    const triggerOf = Effect.fnUntraced(function* (trigger: TemplateTrigger) {
      if (trigger._tag === "webhook") return trigger satisfies RoutineTrigger;
      const { timeZone } = yield* settingsStore.get;
      return { _tag: "schedule", cron: trigger.cron, timeZone } satisfies RoutineTrigger;
    });

    /**
     * The template's routines, paused, then its skills, last, so a routine the
     * server refuses writes none. A creation that fails after the skills were
     * written removes them with the workspace (`insert`).
     */
    const furnishFrom = (template: BotTemplate) =>
      Effect.fnUntraced(function* (botId: BotId) {
        for (const routine of template.routines) {
          yield* routines.create({
            commandId: null,
            botId,
            draft: {
              name: routine.name,
              instruction: routine.instruction,
              trigger: yield* triggerOf(routine.trigger),
              enabled: false,
            },
            author: { _tag: "operator" },
          });
        }
        const workspace = layout.workspace(botId);
        const skills = path.join(workspace, WORKSPACE_ENTRIES.skills);
        yield* Effect.forEach(
          template.skills,
          (skill) => layout.writeFile(path.join(skills, skill.name, SKILL_FILE), skill.text),
          { discard: true },
        ).pipe(
          Effect.catchTags({
            PrivateLocationExposed: () => new Conflict({ reason: "private-location" }),
            PlatformError: Effect.die,
          }),
        );
      });

    const createFromTemplate = (input: {
      readonly commandId: CommandId;
      readonly from: FromTemplate;
    }) => {
      const { template, model, permissionMode, hidden } = input.from;
      return insert<never>({
        commandId: input.commandId,
        method: "bot.createFromTemplate",
        payload: input.from,
        draft: (status) => {
          const chosen = model ?? (offered(status, template.model) ? template.model : undefined);
          const { avatar } = template.profile;
          return {
            name: template.profile.name,
            title: template.profile.title,
            job: template.profile.job,
            ...(isAvatarChoice(avatar) ? { avatar } : {}),
            ...(chosen === undefined ? {} : { model: chosen }),
            ...(permissionMode === undefined ? {} : { permissionMode }),
            ...(hidden === undefined ? {} : { hidden }),
          };
        },
        serverModel: (status) => Effect.succeed(defaultModelIn(status)),
        permissionMode: (status, botModel) =>
          templatePermissionMode(template.permissionMode, defaultPermissionMode(status, botModel)),
        // What the operator saw before creating it: a later move to the default model keeps it.
        permissionModeChooser: () => "operator",
        furnish: furnishFrom(template),
        madeBy: null,
        fromTemplate: true,
      });
    };

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

    const showOrHide = Effect.fn("Bots.showOrHide")(function* (input: {
      readonly commandId: CommandId;
      readonly caller: BotId;
      readonly botId: BotId;
      readonly hidden: boolean;
    }) {
      return yield* receipts.once({
        commandId: input.commandId,
        ...visibilityCommand({ caller: input.caller, id: input.botId, hidden: input.hidden }),
        apply: Effect.gen(function* () {
          const target = yield* require(input.botId);
          const caller = yield* require(input.caller);
          const refusal = visibilityRefusal(
            { id: caller.bot.id, primary: caller.bot.primary },
            {
              name: target.bot.profile.name,
              primary: target.bot.primary,
              madeBy: target.madeBy,
              byOperator: target.visibilityByOperator,
            },
          );
          if (refusal !== undefined) return yield* refusal;
          if (target.bot.hidden !== input.hidden) {
            yield* store.setHidden(input.botId, input.hidden, yield* DateTime.now);
            yield* changes.touch({ _tag: "bot", botId: input.botId });
          }
          return { id: input.botId, hidden: input.hidden };
        }),
      });
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

    return Bots.of({
      create,
      createFromTemplate,
      update,
      showOrHide,
      adoptDefaults,
      freshStart,
      remove,
    });
  }),
);
