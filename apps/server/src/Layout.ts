// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "./config.ts";

/** The relative path of a bot's generated system prompt file, inside its workspace. */
export const SYSTEM_PROMPT_FILE = ".j3/system.md";

/**
 * Where J3 Bots keeps files under `J3_HOME` (see `docs/architecture/server.md#data`):
 *
 * ```
 * bots/<bot>/            a bot's workspace, the folder of its engine project
 *   .j3/system.md        generated
 *   AGENTS.md            generated
 *   memory/              profile.md and log/<yyyy-mm>.md
 *   skills/  files/
 * shared/memory/         user.md and log/<yyyy-mm>.md, every bot's to read
 * shared/skills/
 * attachments/           file bytes, by digest
 * ```
 */
export class Layout extends Context.Service<
  Layout,
  {
    readonly workspace: (botId: BotId) => string;
    readonly botMemory: (botId: BotId) => string;
    readonly sharedMemory: string;
    readonly sharedSkills: string;
    readonly attachments: string;
  }
>()("@j3-bots/server/Layout") {}

export const layer = Layer.effect(
  Layout,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const path = yield* Path.Path;
    const workspace = (botId: BotId) => path.join(home, "bots", botId);
    return Layout.of({
      workspace,
      botMemory: (botId) => path.join(workspace(botId), "memory"),
      sharedMemory: path.join(home, "shared", "memory"),
      sharedSkills: path.join(home, "shared", "skills"),
      attachments: path.join(home, "attachments"),
    });
  }),
);
