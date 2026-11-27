// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Avatar,
  type Bot,
  type BotState,
  BotId,
  EffortLevel,
  type ModelChoice,
  ModelId,
  PermissionMode,
  ProviderId,
  type Profile,
  SectionId,
  type SuggestedReply,
} from "@j3-bots/contracts";
import { EngineProjectId } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, Time, timeText } from "../persistence/columns.ts";
import { BotStates } from "../turns/BotStates.ts";
import { SuggestedReplies } from "../turns/SuggestedReplies.ts";

const BotRow = Schema.Struct({
  id: BotId,
  name: Schema.String,
  title: Schema.String,
  avatar_shape: Schema.String,
  avatar_color: Schema.String,
  job: Schema.String,
  provider_id: ProviderId,
  model_id: ModelId,
  effort: Schema.NullOr(EffortLevel),
  permission_mode: PermissionMode,
  is_primary: Flag,
  pinned: Flag,
  hidden: Flag,
  made_by_bot_id: Schema.NullOr(BotId),
  made_by: Schema.NullOr(Schema.Literals(["operator", "bot"])),
  visibility_by_operator: Flag,
  browser: Flag,
  section_id: Schema.NullOr(SectionId),
  workspace_path: Schema.String,
  workspace_root: Schema.NullOr(Schema.String),
  engine_project_id: Schema.NullOr(EngineProjectId),
  created_at: Time,
});

/** A bot as the server keeps it: what clients see, and where it lives. */
export interface StoredBot {
  readonly bot: Bot;
  readonly workspacePath: string;
  /**
   * The workspace's real path when it was first provisioned, before the bot
   * ran: what a file the bot names is read against. Never resolved again from
   * `workspacePath`, which the bot can replace with a link.
   */
  readonly workspaceRoot: Option.Option<string>;
  readonly engineProjectId: Option.Option<EngineProjectId>;
  /** The bot whose `create_bot` made it, while that bot exists. */
  readonly madeBy: BotId | null;
  /** The operator chose whether it shows: no bot changes it (decision 0050). */
  readonly visibilityByOperator: boolean;
}

const toStored = (
  row: typeof BotRow.Type,
  state: BotState,
  settingsHeld: boolean,
  forceStop: boolean,
  opening: boolean,
  suggestedReply: SuggestedReply | null,
): StoredBot => ({
  bot: {
    id: row.id,
    profile: {
      name: row.name,
      title: row.title,
      avatar: { shape: row.avatar_shape, color: row.avatar_color },
      job: row.job,
    },
    ...(row.made_by === null ? {} : { madeBy: { by: row.made_by, botId: row.made_by_bot_id } }),
    model: { providerId: row.provider_id, modelId: row.model_id },
    effort: row.effort,
    permissionMode: row.permission_mode,
    primary: row.is_primary,
    pinned: row.pinned,
    hidden: row.hidden,
    browser: row.browser,
    sectionId: row.section_id,
    state,
    settingsHeld,
    forceStop,
    opening,
    suggestedReply,
    createdAt: row.created_at,
  },
  workspacePath: row.workspace_path,
  workspaceRoot: Option.fromNullishOr(row.workspace_root),
  engineProjectId: Option.fromNullishOr(row.engine_project_id),
  madeBy: row.made_by_bot_id,
  visibilityByOperator: row.visibility_by_operator,
});

/**
 * Who chose a bot's model, or its permission mode: the operator, or the
 * server, for a bot created without one. Until its hello is sent, a bot on the
 * server's model follows the server's default model, and the default
 * permission mode of that model when the server chose its mode too
 * (`Bots.adoptDefaults`).
 */
export type Chooser = "operator" | "server";

/** Everything a new bot is created with. */
export interface NewBot {
  readonly id: BotId;
  readonly profile: Profile;
  readonly model: ModelChoice;
  readonly modelChooser: Chooser;
  readonly permissionMode: PermissionMode;
  readonly permissionModeChooser: Chooser;
  readonly primary: boolean;
  readonly hidden: boolean;
  /** Whether it may use the engine's browser. */
  readonly browser: boolean;
  /**
   * The bot whose `create_bot` makes it, whose choice its visibility then is;
   * null for the operator's, whose choice it is.
   */
  readonly madeBy: BotId | null;
  readonly workspacePath: string;
  readonly at: DateTime.Utc;
}

/** The fields of a bot an update may change. */
export interface BotChanges {
  readonly profile?: Partial<Profile>;
  readonly model?: ModelChoice;
  /** A level of the bot's model, or null for the harness's default (`Bot.effort`). */
  readonly effort?: EffortLevel | null;
  readonly permissionMode?: PermissionMode;
  readonly primary?: boolean;
  readonly pinned?: boolean;
  /** Recorded as the operator's choice when they make the change (decision 0050). */
  readonly hidden?: boolean;
  readonly browser?: boolean;
  /** The section the bot moves into, or null for none. It must exist. */
  readonly sectionId?: SectionId | null;
}

const SELECT = `
  SELECT id, name, title, avatar_shape, avatar_color, job, provider_id, model_id, effort,
    permission_mode, is_primary, pinned, hidden, made_by_bot_id, made_by, visibility_by_operator,
    browser,
    section_id, workspace_path, workspace_root, engine_project_id, created_at
  FROM bots
`;

/**
 * The `bots` table. Writes run inside the caller's transaction; the domain
 * rules (one primary bot, defaults, deletion) are `Bots`'.
 */
export class BotStore extends Context.Service<
  BotStore,
  {
    readonly find: (id: BotId) => Effect.Effect<Option.Option<StoredBot>>;
    /** Every bot, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<StoredBot>>;
    /** The avatars bots use now, to pick a free one for a new bot. */
    readonly avatars: Effect.Effect<ReadonlyArray<Avatar>>;
    /** The bot and its conversation. */
    readonly insert: (bot: NewBot) => Effect.Effect<void>;
    /**
     * A new model or permission mode is recorded as `chooser`'s choice, and
     * whether it is hidden as the operator's when `chooser` is the operator.
     */
    readonly update: (
      id: BotId,
      changes: BotChanges,
      at: DateTime.Utc,
      chooser: Chooser,
    ) => Effect.Effect<void>;
    /** Shows or hides it for a bot, leaving whose choice its visibility is as it was. */
    readonly setHidden: (id: BotId, hidden: boolean, at: DateTime.Utc) => Effect.Effect<void>;
    /** Makes no bot primary; the caller then makes one primary, in the same transaction. */
    readonly clearPrimary: (at: DateTime.Utc) => Effect.Effect<ReadonlyArray<BotId>>;
    readonly setEngineProject: (id: BotId, projectId: EngineProjectId) => Effect.Effect<void>;
    /** Records the workspace's real path, once: a later call leaves the first one. */
    readonly setWorkspaceRoot: (id: BotId, root: string) => Effect.Effect<void>;
    /**
     * Deletes the row, and with it everything the database cascades from it:
     * its wakes explicitly, before its dispatches. Call it in a transaction.
     */
    readonly remove: (id: BotId) => Effect.Effect<void>;
  }
>()("@j3-bots/server/bots/BotStore") {}

export const layer = Layer.effect(
  BotStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const states = yield* BotStates;
    const suggestedReplies = yield* SuggestedReplies;

    const findRow = SqlSchema.findOneOption({
      Request: BotId,
      Result: BotRow,
      execute: (id) => sql`${sql.literal(SELECT)} WHERE id = ${id}`,
    });
    const listRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: BotRow,
      execute: () => sql`${sql.literal(SELECT)} ORDER BY created_at, id`,
    });
    const avatarRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ shape: Schema.String, color: Schema.String }),
      execute: () => sql`SELECT avatar_shape AS shape, avatar_color AS color FROM bots`,
    });
    const primaryRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: BotId }),
      execute: () => sql`SELECT id FROM bots WHERE is_primary = 1`,
    });

    const insert = Effect.fn("BotStore.insert")(function* (bot: NewBot) {
      const at = timeText(bot.at);
      yield* sql`
        INSERT INTO bots (
          id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
          model_by_server, permission_mode, permission_mode_by_server, is_primary, hidden,
          browser, made_by_bot_id, made_by, visibility_by_operator, workspace_path, created_at,
          updated_at
        ) VALUES (
          ${bot.id}, ${bot.profile.name}, ${bot.profile.title}, ${bot.profile.avatar.shape},
          ${bot.profile.avatar.color}, ${bot.profile.job}, ${bot.model.providerId},
          ${bot.model.modelId}, ${bot.modelChooser === "server" ? 1 : 0}, ${bot.permissionMode},
          ${bot.permissionModeChooser === "server" ? 1 : 0}, ${bot.primary ? 1 : 0},
          ${bot.hidden ? 1 : 0}, ${bot.browser ? 1 : 0}, ${bot.madeBy}, ${bot.madeBy === null ? "operator" : "bot"},
          ${bot.madeBy === null ? 1 : 0},
          ${bot.workspacePath}, ${at}, ${at}
        )
      `;
      yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES (${bot.id}, ${at})`;
    }, Effect.orDie);

    const update = Effect.fn("BotStore.update")(function* (
      id: BotId,
      changes: BotChanges,
      at: DateTime.Utc,
      chooser: Chooser,
    ) {
      const columns: Record<string, string | number | null> = { updated_at: timeText(at) };
      const { profile } = changes;
      if (profile?.name !== undefined) columns["name"] = profile.name;
      if (profile?.title !== undefined) columns["title"] = profile.title;
      if (profile?.job !== undefined) columns["job"] = profile.job;
      if (profile?.avatar !== undefined) {
        columns["avatar_shape"] = profile.avatar.shape;
        columns["avatar_color"] = profile.avatar.color;
      }
      if (changes.model !== undefined) {
        columns["provider_id"] = changes.model.providerId;
        columns["model_id"] = changes.model.modelId;
        columns["model_by_server"] = chooser === "server" ? 1 : 0;
      }
      if (changes.effort !== undefined) columns["effort"] = changes.effort;
      if (changes.permissionMode !== undefined) {
        columns["permission_mode"] = changes.permissionMode;
        columns["permission_mode_by_server"] = chooser === "server" ? 1 : 0;
      }
      if (changes.primary !== undefined) columns["is_primary"] = changes.primary ? 1 : 0;
      if (changes.pinned !== undefined) columns["pinned"] = changes.pinned ? 1 : 0;
      if (changes.hidden !== undefined) {
        columns["hidden"] = changes.hidden ? 1 : 0;
        if (chooser === "operator") columns["visibility_by_operator"] = 1;
      }
      if (changes.browser !== undefined) columns["browser"] = changes.browser ? 1 : 0;
      if (changes.sectionId !== undefined) columns["section_id"] = changes.sectionId;
      // A browser taken away is withdrawn from the bot's project
      // (`EngineSessions`), counted before the switch is written.
      if (changes.browser === false) {
        yield* sql`
          UPDATE bots SET browser_withdrawals = browser_withdrawals + 1 WHERE id = ${id} AND browser = 1
        `;
      }
      yield* sql`UPDATE bots SET ${sql.update(columns)} WHERE id = ${id}`;
    }, Effect.orDie);

    const setHidden = Effect.fn("BotStore.setHidden")(function* (
      id: BotId,
      hidden: boolean,
      at: DateTime.Utc,
    ) {
      yield* sql`
        UPDATE bots SET hidden = ${hidden ? 1 : 0}, updated_at = ${timeText(at)} WHERE id = ${id}
      `;
    }, Effect.orDie);

    const clearPrimary = Effect.fn("BotStore.clearPrimary")(function* (at: DateTime.Utc) {
      const previous = yield* primaryRows(undefined);
      yield* sql`
        UPDATE bots SET is_primary = 0, updated_at = ${timeText(at)} WHERE is_primary = 1
      `;
      return previous.map((row) => row.id);
    }, Effect.orDie);

    const withState = (row: typeof BotRow.Type) =>
      Effect.all([
        states.of(row.id),
        states.settingsHeld(row.id),
        states.forceStop(row.id),
        states.opening(row.id),
        suggestedReplies.of(row.id),
      ]).pipe(
        Effect.map(([state, held, forceStop, opening, suggestedReply]) =>
          toStored(row, state, held, forceStop, opening, suggestedReply),
        ),
      );

    const find = Effect.fn("BotStore.find")(function* (id: BotId) {
      const row = yield* findRow(id);
      return Option.isNone(row) ? Option.none() : Option.some(yield* withState(row.value));
    }, Effect.orDie);

    const setEngineProject = Effect.fn("BotStore.setEngineProject")(function* (
      id: BotId,
      projectId: EngineProjectId,
    ) {
      yield* sql`UPDATE bots SET engine_project_id = ${projectId} WHERE id = ${id}`;
    }, Effect.orDie);

    const setWorkspaceRoot = Effect.fn("BotStore.setWorkspaceRoot")(function* (
      id: BotId,
      root: string,
    ) {
      yield* sql`UPDATE bots SET workspace_root = ${root} WHERE id = ${id} AND workspace_root IS NULL`;
    }, Effect.orDie);

    // The wakes go first: a wake that reached a dispatch must keep it, so the
    // cascade to the bot's dispatches would be refused while one remains.
    const remove = Effect.fn("BotStore.remove")(function* (id: BotId) {
      yield* sql`DELETE FROM wakes WHERE bot_id = ${id}`;
      yield* sql`DELETE FROM bots WHERE id = ${id}`;
    }, Effect.orDie);

    return BotStore.of({
      find,
      list: listRows(undefined).pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, withState)),
      ),
      avatars: avatarRows(undefined).pipe(Effect.orDie),
      insert,
      update,
      setHidden,
      clearPrimary,
      setEngineProject,
      setWorkspaceRoot,
      remove,
    });
  }),
);
