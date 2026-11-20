// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BotId, MemoryPath } from "@j3-bots/contracts";
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
import { EngineState } from "../engine/EngineState.ts";
import { SYSTEM_PROMPT_FILE, WORKSPACE_ENTRIES } from "../home/entries.ts";
import { Layout } from "../Layout.ts";
import { MemoryFiles } from "../memory/MemoryFiles.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { BotStore } from "./BotStore.ts";

/** The pinned note of a bot's memory and of the shared memory: in front of the bot on every turn. */
export const PINNED_FILE = {
  bot: MemoryPath.make("profile.md"),
  shared: MemoryPath.make("user.md"),
} as const;

/** What bots call the operator until the operator gives a name. */
const UNNAMED_OPERATOR = "your user";

const { generated, instructions: AGENTS_FILE, memory: MEMORY, skills, files } = WORKSPACE_ENTRIES;
const FOLDERS = [generated, `${MEMORY}/log`, skills, files] as const;

/**
 * A bot's workspace folder and the files J3 Bots generates in it
 * (`docs/prompts/architecture.md#layers`): `.j3/system.md` holds the base
 * prompt, the profile and the pinned memory, which Claude Code appends to its
 * system prompt; `AGENTS.md` holds the profile and pinned memory, which Codex
 * reads from the session's folder. Both are rewritten from the database and
 * the memory files whenever one of their inputs changes, and reach the bot when
 * its session next starts its provider.
 */
export class Workspaces extends Context.Service<
  Workspaces,
  {
    /** Creates the folders, if missing, and writes the generated files. */
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
    const writing = yield* Semaphore.make(1);

    const pinnedText = (document: Option.Option<{ readonly text: string }>) =>
      Option.match(document, { onNone: () => "", onSome: ({ text }) => text });

    const writeFile = Effect.fn("Workspaces.writeFile")(function* (target: string, text: string) {
      yield* layout.writable(target);
      const aside = `${target}.j3-writing`;
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(aside, text);
      yield* fs.rename(aside, target);
    }, Effect.orDie);

    const render = Effect.fn("Workspaces.render")(function* (botId: BotId) {
      const stored = yield* bots.find(botId);
      if (Option.isNone(stored)) return;
      const { bot } = stored.value;
      const now = yield* settings.get;
      // Paths are J3 Bots' own constants: they always resolve inside the folder.
      const pinnedBot = yield* memory
        .read({ _tag: "bot", botId }, PINNED_FILE.bot)
        .pipe(Effect.orDie);
      const pinnedShared = yield* memory
        .read({ _tag: "shared" }, PINNED_FILE.shared)
        .pipe(Effect.orDie);
      const input: BotInstructionsInput = {
        operator: { name: now.operatorName ?? UNNAMED_OPERATOR, timeZone: now.timeZone },
        profile: {
          name: bot.profile.name,
          title: bot.profile.title,
          job: bot.profile.job,
          primary: bot.primary,
        },
        runtime: yield* engineState.labels(bot.model),
        pinned: { shared: pinnedText(pinnedShared), bot: pinnedText(pinnedBot) },
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
      const workspace = yield* layout.writable(layout.workspace(botId)).pipe(Effect.orDie);
      for (const folder of FOLDERS) {
        yield* fs
          .makeDirectory(path.join(workspace, folder), { recursive: true })
          .pipe(Effect.orDie);
      }
      yield* fs.makeDirectory(layout.sharedMemory, { recursive: true }).pipe(Effect.orDie);
      yield* fs.makeDirectory(layout.sharedSkills, { recursive: true }).pipe(Effect.orDie);
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
      for (const target of targets) {
        yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.orDie);
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
