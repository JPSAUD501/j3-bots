// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, MemoryPath, type MemoryScope } from "@j3-bots/contracts";
import {
  type BotInstructionsInput,
  renderBotInstructions,
  renderSystemFile,
} from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ConnectorStore } from "../connectors/ConnectorStore.ts";
import { EngineState } from "../engine/EngineState.ts";
import { SYSTEM_PROMPT_FILE, WORKSPACE_ENTRIES } from "../home/entries.ts";
import { Layout, type PrivateLocationExposed } from "../Layout.ts";
import { MemoryFiles } from "../memory/MemoryFiles.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { BotStore } from "./BotStore.ts";

/** The pinned note of a bot's memory and of the shared memory: in front of the bot on every turn. */
export const PINNED_FILE = {
  bot: MemoryPath.make("profile.md"),
  shared: MemoryPath.make("user.md"),
} as const;

const { generated, instructions: AGENTS_FILE, memory: MEMORY, skills, files } = WORKSPACE_ENTRIES;
/** Folders the server writes in a workspace. */
const SERVER_FOLDERS = [generated, `${MEMORY}/log`] as const;
/** Folders that are the bot's own: created once, then the bot's to change, links included. */
const BOT_FOLDERS = [skills, files] as const;

/**
 * A bot's workspace folder and the files J3 Bots generates in it
 * (`docs/prompts/architecture.md#layers`): `.j3/system.md` holds the base
 * prompt, the profile and the pinned memory, which Claude Code appends to its
 * system prompt; `AGENTS.md` holds the profile and pinned memory, which Codex
 * reads from the session's folder. Both are rewritten from the database and
 * the memory files whenever one of their inputs changes (the bot's connectors
 * among them, whose rules only a bot with one gets), and reach the bot when
 * its session next starts its provider.
 */
export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * Creates the folders, if missing, and writes the generated files. A
     * folder or file that has left private state is skipped with a warning.
     */
    readonly provision: (botId: BotId) => Effect.Effect<void>;
    /** Rewrites the generated files of one bot. Does nothing for a bot that no longer exists. */
    readonly render: (botId: BotId) => Effect.Effect<void>;
    /** Rewrites the generated files of every bot, after a change they all share. */
    readonly renderAll: Effect.Effect<void>;
    /**
     * What deleting a bot removes: its memory and generated files, or with
     * `everything`, the whole workspace including the files it produced.
     */
    readonly remove: (botId: BotId, everything: boolean) => Effect.Effect<void>;
  }
>()("@j3-bots/server/bots/Workspaces") {}

export const layer = Layer.effect(
  Workspaces,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* Layout;
    const bots = yield* BotStore;
    const settings = yield* SettingsStore;
    const engineState = yield* EngineState;
    const memory = yield* MemoryFiles;
    const connectors = yield* ConnectorStore;
    const writing = yield* Semaphore.make(1);

    const pinnedText = (document: Option.Option<{ readonly text: string }>) =>
      Option.match(document, { onNone: () => "", onSome: ({ text }) => text });

    /**
     * A write refused because its location left private state (see
     * `docs/architecture/security.md`): logged and skipped, so one tampered
     * workspace never stops the others.
     */
    const skipExposed = (error: PrivateLocationExposed) =>
      Effect.logWarning(`${error.message} It was skipped.`);

    const writeFile = (target: string, text: string) =>
      layout
        .writeFile(target, text)
        .pipe(Effect.catchTags({ PrivateLocationExposed: skipExposed, PlatformError: Effect.die }));

    /** Creates `folder` if missing, unless it has left private state. */
    const makeFolder = (folder: string) =>
      layout.writable(folder).pipe(
        Effect.flatMap((checked) => fs.makeDirectory(checked, { recursive: true })),
        Effect.catchTags({ PrivateLocationExposed: skipExposed, PlatformError: Effect.die }),
      );

    const render = Effect.fn("Workspaces.render")(function* (botId: BotId) {
      const stored = yield* bots.find(botId);
      if (Option.isNone(stored)) return;
      const { bot } = stored.value;
      const now = yield* settings.get;
      // Paths are J3 Bots' own constants, but the bot's tools may have made
      // one a link out of its folder: then that note is left out.
      const pinned = (scope: MemoryScope, file: MemoryPath) =>
        memory.read(scope, file).pipe(
          Effect.catchTag("Invalid", () =>
            Effect.logWarning("A pinned note leads out of its memory folder; it was left out", {
              botId,
              file,
            }).pipe(Effect.as(Option.none())),
          ),
        );
      const pinnedBot = yield* pinned({ _tag: "bot", botId }, PINNED_FILE.bot);
      const pinnedShared = yield* pinned({ _tag: "shared" }, PINNED_FILE.shared);
      const input: BotInstructionsInput = {
        operator: { name: now.operatorName, timeZone: now.timeZone },
        profile: {
          name: bot.profile.name,
          title: bot.profile.title,
          job: bot.profile.job,
          primary: bot.primary,
        },
        runtime: yield* engineState.labels(bot.model),
        pinned: { shared: pinnedText(pinnedShared), bot: pinnedText(pinnedBot) },
        // Its rules go only to a bot whose browser switch is on: its bridge
        // lists the browser's tools to that bot alone (`ToolLists`).
        browser: bot.browser,
        // Granted, whatever its status: one that needs a sign-in comes back
        // without a new session, and its rules must already be there.
        connectors: (yield* connectors.all).some(
          ({ grant }) => grant._tag === "all-bots" || grant.ids.includes(botId),
        ),
      };
      const workspace = stored.value.workspacePath;
      yield* writing.withPermits(1)(
        Effect.all([
          writeFile(path.join(workspace, SYSTEM_PROMPT_FILE), renderSystemFile(input)),
          writeFile(path.join(workspace, AGENTS_FILE), renderBotInstructions(input)),
        ]),
      );
    });

    const provision = Effect.fn("Workspaces.provision")(function* (botId: BotId) {
      const workspace = yield* layout.writable(layout.workspace(botId)).pipe(
        Effect.asSome,
        Effect.catchTag("PrivateLocationExposed", (error) =>
          skipExposed(error).pipe(Effect.as(Option.none<string>())),
        ),
      );
      if (Option.isNone(workspace)) return;
      for (const folder of [
        ...SERVER_FOLDERS.map((name) => path.join(workspace.value, name)),
        layout.sharedMemory,
        layout.sharedSkills,
      ]) {
        yield* makeFolder(folder);
      }
      for (const name of BOT_FOLDERS) {
        const folder = path.join(workspace.value, name);
        if (Option.isNone(yield* fs.lstat(folder).pipe(Effect.option))) yield* makeFolder(folder);
      }
      // Where the workspace really is, kept from the first provisioning, which
      // comes before the bot's first turn: the bot can later replace its
      // folder with a link, and what it attaches is read against this.
      yield* bots.setWorkspaceRoot(botId, yield* fs.realPath(workspace.value).pipe(Effect.orDie));
      yield* render(botId);
    });

    const remove = Effect.fn("Workspaces.remove")(function* (botId: BotId, everything: boolean) {
      const workspace = layout.workspace(botId);
      const targets = everything
        ? [workspace]
        : [
            layout.botMemory(botId),
            path.join(workspace, generated),
            path.join(workspace, AGENTS_FILE),
          ];
      // A link at a target is removed, not followed; a link above one would
      // lead the removal elsewhere, so its folder is checked first.
      for (const target of targets) {
        yield* layout
          .writable(path.dirname(target))
          .pipe(
            Effect.andThen(fs.remove(target, { recursive: true, force: true })),
            Effect.catchTags({ PrivateLocationExposed: skipExposed, PlatformError: Effect.die }),
          );
      }
    });

    return Workspaces.of({
      provision,
      render,
      renderAll: bots.list.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(all, ({ bot }) => render(bot.id), { discard: true }),
        ),
      ),
      remove,
    });
  }),
);
