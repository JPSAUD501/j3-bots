// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Path from "effect/Path";

/**
 * What the home holds, by name (see `docs/architecture/server.md#data`).
 * Everything but `web` is private.
 */
export const HOME_ENTRIES = {
  config: "config.json",
  database: "j3.sqlite",
  engine: "engine",
  /** One workspace per bot, `bots/<bot>`. */
  bots: "bots",
  /** Memory and skills every bot reads. */
  shared: "shared",
  attachments: "attachments",
  adminSocket: "admin.sock",
  /** Held by the one server running for the home. */
  lock: "server.lock",
  /** The one place in the home a web client may be put: the server keeps nothing there. */
  web: "web",
} as const;

/** What the server keeps in a bot's workspace, by name. */
export const WORKSPACE_ENTRIES = {
  /** Generated: `system.md`. */
  generated: ".j3",
  /** Generated, for harnesses that read one (Codex). */
  instructions: "AGENTS.md",
  memory: "memory",
  skills: "skills",
  files: "files",
} as const;

/** The relative path of a bot's generated system prompt file, inside its workspace. */
export const SYSTEM_PROMPT_FILE = `${WORKSPACE_ENTRIES.generated}/system.md`;

/**
 * Where the home's private state is, for a home at `home`:
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
 * web/                   where the operator may put a built web client; public
 * ```
 */
export const homeLayout = (path: Path.Path, home: string) => {
  const workspace = (bot: string) => path.join(home, HOME_ENTRIES.bots, bot);
  const sharedMemory = path.join(home, HOME_ENTRIES.shared, "memory");
  const sharedSkills = path.join(home, HOME_ENTRIES.shared, "skills");
  return {
    workspace,
    botMemory: (bot: string) => path.join(workspace(bot), WORKSPACE_ENTRIES.memory),
    sharedMemory,
    sharedSkills,
    attachments: path.join(home, HOME_ENTRIES.attachments),
    /**
     * Every location the server writes, for a home whose bots are `bots`:
     * each entry of the home but `web`, the database's journal beside it, the
     * shared folders, and each bot's workspace and what the server keeps in it.
     */
    written: (bots: ReadonlyArray<string>) => {
      const { config, database, engine, shared, attachments, adminSocket, lock } = HOME_ENTRIES;
      return [
        ...[config, engine, HOME_ENTRIES.bots, shared, attachments, adminSocket, lock].map(
          (entry) => path.join(home, entry),
        ),
        // SQLite keeps its journal beside the database.
        ...["", "-wal", "-shm"].map((suffix) => path.join(home, `${database}${suffix}`)),
        sharedMemory,
        sharedSkills,
        ...bots.flatMap((bot) => [
          workspace(bot),
          ...Object.values(WORKSPACE_ENTRIES).map((entry) => path.join(workspace(bot), entry)),
        ]),
      ];
    },
  };
};
