// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Avatar,
  type Bot,
  type BotState,
  BotId,
  type ModelChoice,
  ModelId,
  PermissionMode,
  ProviderId,
  type Profile,
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

const BotRow = Schema.Struct({
  id: BotId,
  name: Schema.String,
  title: Schema.String,
  avatar_shape: Schema.String,
  avatar_color: Schema.String,
  job: Schema.String,
  provider_id: ProviderId,
  model_id: ModelId,
  permission_mode: PermissionMode,
  is_primary: Flag,
  pinned: Flag,
  hidden: Flag,
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
}

const toStored = (row: typeof BotRow.Type, state: BotState, settingsHeld: boolean): StoredBot => ({
  bot: {
    id: row.id,
    profile: {
      name: row.name,
      title: row.title,
      avatar: { shape: row.avatar_shape, color: row.avatar_color },
      job: row.job,
    },
    model: { providerId: row.provider_id, modelId: row.model_id },
    permissionMode: row.permission_mode,
    primary: row.is_primary,
    pinned: row.pinned,
    hidden: row.hidden,
    state,
    settingsHeld,
    createdAt: row.created_at,
  },
  workspacePath: row.workspace_path,
  workspaceRoot: Option.fromNullishOr(row.workspace_root),
  engineProjectId: Option.fromNullishOr(row.engine_project_id),
});

/** Everything a new bot is created with. */
export interface NewBot {
  readonly id: BotId;
  readonly profile: Profile;
  readonly model: ModelChoice;
  readonly permissionMode: PermissionMode;
  readonly primary: boolean;
  readonly workspacePath: string;
  readonly at: DateTime.Utc;
}

/** The fields of a bot an update may change. */
export interface BotChanges {
  readonly profile?: Partial<Profile>;
  readonly model?: ModelChoice;
  readonly permissionMode?: PermissionMode;
  readonly primary?: boolean;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

const SELECT = `
  SELECT id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
    permission_mode, is_primary, pinned, hidden, workspace_path, workspace_root, engine_project_id,
    created_at
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
    readonly update: (id: BotId, changes: BotChanges, at: DateTime.Utc) => Effect.Effect<void>;
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
          permission_mode, is_primary, workspace_path, created_at, updated_at
        ) VALUES (
          ${bot.id}, ${bot.profile.name}, ${bot.profile.title}, ${bot.profile.avatar.shape},
          ${bot.profile.avatar.color}, ${bot.profile.job}, ${bot.model.providerId},
          ${bot.model.modelId}, ${bot.permissionMode}, ${bot.primary ? 1 : 0},
          ${bot.workspacePath}, ${at}, ${at}
        )
      `;
      yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES (${bot.id}, ${at})`;
    }, Effect.orDie);

    const update = Effect.fn("BotStore.update")(function* (
      id: BotId,
      changes: BotChanges,
      at: DateTime.Utc,
    ) {
      const columns: Record<string, string | number> = { updated_at: timeText(at) };
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
      }
      if (changes.permissionMode !== undefined) columns["permission_mode"] = changes.permissionMode;
      if (changes.primary !== undefined) columns["is_primary"] = changes.primary ? 1 : 0;
      if (changes.pinned !== undefined) columns["pinned"] = changes.pinned ? 1 : 0;
      if (changes.hidden !== undefined) columns["hidden"] = changes.hidden ? 1 : 0;
      yield* sql`UPDATE bots SET ${sql.update(columns)} WHERE id = ${id}`.pipe(Effect.orDie);
    });

    const clearPrimary = Effect.fn("BotStore.clearPrimary")(function* (at: DateTime.Utc) {
      const previous = yield* primaryRows(undefined);
      yield* sql`
        UPDATE bots SET is_primary = 0, updated_at = ${timeText(at)} WHERE is_primary = 1
      `;
      return previous.map((row) => row.id);
    }, Effect.orDie);

    const withState = (row: typeof BotRow.Type) =>
      Effect.zipWith(states.of(row.id), states.settingsHeld(row.id), (state, held) =>
        toStored(row, state, held),
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
      clearPrimary,
      setEngineProject,
      setWorkspaceRoot,
      remove,
    });
  }),
);
