// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Path from "effect/Path";

/**
 * What the home holds, by name (see `docs/architecture/server.md#data`):
 * everything the server and the engine write there, and nothing else.
 * Everything but `web` is private.
 */
export const HOME_ENTRIES = {
  config: "config.json",
  database: "j3.sqlite",
  /** SQLite's write-ahead log and its index, beside the database in WAL mode. */
  databaseLog: "j3.sqlite-wal",
  databaseLogIndex: "j3.sqlite-shm",
  engine: "engine",
  /** One home per Claude Code or Codex instance of the engine, `providers/<provider>`. */
  providers: "providers",
  /** One workspace per bot, `bots/<bot>`. */
  bots: "bots",
  /** Memory and skills every bot reads. */
  shared: "shared",
  /** What the server keeps for itself outside the database. */
  state: "state",
  attachments: "attachments",
  /** What `j3-bots update` copied before it changed release, one folder per update. */
  backups: "backups",
  /** The vault's own database, which no update copies or rolls back. */
  vault: "vault",
  adminSocket: "admin.sock",
  /** Held by the one server running for the home. */
  lock: "server.lock",
  /** The one place in the home a web client may be put: the server keeps nothing there. */
  web: "web",
} as const;

/** The engine provider instances that keep a home in `providers`, by J3 Bots provider id. */
export const PROVIDER_HOMES = ["claude-code", "codex"] as const;

/** What a bot's workspace holds, by name. */
export const WORKSPACE_ENTRIES = {
  /** Generated: `system.md`. */
  generated: ".j3",
  /** Generated, for harnesses that read one (Codex). */
  instructions: "AGENTS.md",
  memory: "memory",
  /** The bot's own, which the server creates once and never writes. */
  skills: "skills",
  /** The bot's own, which the server creates once and never writes. */
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
 * state/shipped-skills.json  which texts in shared/skills the server installed
 * state/runtime.json     the release whose data this home holds, and a transition under way
 * attachments/           file bytes, by digest
 * backups/<snapshot>/    the databases and settings an update copied first
 * vault/vault.sqlite     the vault's sealed logins; in no snapshot
 * providers/<provider>/  the configuration folder of an engine provider instance
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
    shippedSkills: path.join(home, HOME_ENTRIES.state, "shipped-skills.json"),
    providerHome: (provider: (typeof PROVIDER_HOMES)[number]) =>
      path.join(home, HOME_ENTRIES.providers, provider),
    /**
     * Every location the server writes, for a home whose bots are `bots`:
     * each entry of the home but `web`, the shared folders, the provider
     * homes, and each bot's workspace with what the server writes in it: not
     * `skills` and `files`, which are the bot's, links included.
     */
    written: (bots: ReadonlyArray<string>) => {
      const {
        config,
        database,
        databaseLog,
        databaseLogIndex,
        engine,
        providers,
        shared,
        state,
        attachments,
        backups,
        vault,
        adminSocket,
        lock,
      } = HOME_ENTRIES;
      const { generated, instructions, memory } = WORKSPACE_ENTRIES;
      return [
        ...[
          config,
          database,
          databaseLog,
          databaseLogIndex,
          engine,
          providers,
          HOME_ENTRIES.bots,
          shared,
          state,
          attachments,
          backups,
          vault,
          adminSocket,
          lock,
        ].map((entry) => path.join(home, entry)),
        sharedMemory,
        sharedSkills,
        ...PROVIDER_HOMES.map((provider) => path.join(home, providers, provider)),
        ...bots.flatMap((bot) => [
          workspace(bot),
          ...[generated, instructions, memory].map((entry) => path.join(workspace(bot), entry)),
        ]),
      ];
    },
  };
};
