// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- instance ids are a short SHA-256 of J3 Bots' provider id.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ToolBridge } from "../Engine.ts";
import { engineFolders, harnessDefaultHomes, type PrivateFiles } from "./PrivateFiles.ts";
import { linkSharedSkills } from "./SkillLinks.ts";
import { editToml, type TomlEdit, type TomlInline, type TomlTable } from "./toml.ts";

// Everything J3 Bots writes into the engine's data directory and the provider
// homes it owns. Every file is written whole to a new file and renamed
// (`PrivateFiles`), so the engine, which watches its settings file, never
// reads half of one.

/** One harness instance, in the shape the engine needs it. */
export type InstanceSpec =
  | {
      readonly kind: "claude-code" | "codex";
      readonly instanceId: string;
      readonly name: string;
      readonly home: string;
      /**
       * The harness it runs, by its path: the operator's choice, else J3
       * Bots' own copy; undefined for the one on the engine's `PATH`.
       */
      readonly executable: string | undefined;
      /** Whether `executable` is J3 Bots' own copy, which updates only with J3 Bots. */
      readonly ownCopy: boolean;
      /** The operator's arguments, after J3 Bots' own; empty for none. */
      readonly launchArguments: string;
      readonly enabled: boolean;
      readonly environment: ReadonlyArray<EnvironmentVariable>;
    }
  | {
      /** An Agent Client Protocol agent started as a local command. */
      readonly kind: "acp-local";
      readonly instanceId: string;
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly enabled: boolean;
      readonly environment: ReadonlyArray<EnvironmentVariable>;
    };

/**
 * Whether two specs of an instance run the same: all but its name, which the
 * engine changes without rebuilding the instance (**Read** at `bc0f04d`,
 * `runtimeEqual` in `ProviderInstanceRegistry.ts`). A secret variable counts
 * by its name and value.
 */
export const sameRuntime = (a: InstanceSpec, b: InstanceSpec): boolean => {
  if (
    a.instanceId !== b.instanceId ||
    a.enabled !== b.enabled ||
    a.environment.length !== b.environment.length ||
    a.environment.some(
      (variable, index) =>
        variable.name !== b.environment[index]?.name ||
        Redacted.value(variable.value) !== Redacted.value(b.environment[index].value),
    )
  ) {
    return false;
  }
  switch (a.kind) {
    case "claude-code":
    case "codex":
      return (
        b.kind === a.kind &&
        a.home === b.home &&
        a.executable === b.executable &&
        a.ownCopy === b.ownCopy &&
        a.launchArguments === b.launchArguments
      );
    case "acp-local":
      return (
        b.kind === "acp-local" &&
        a.command === b.command &&
        a.args.length === b.args.length &&
        a.args.every((arg, index) => arg === b.args[index])
      );
  }
};

/** Whether two specs of an instance are the same, its name included. */
export const sameInstance = (a: InstanceSpec, b: InstanceSpec): boolean =>
  a.name === b.name && sameRuntime(a, b);

interface EnvironmentVariable {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export interface ProvisionInput {
  /** The engine's `--base-dir`. */
  readonly home: string;
  readonly files: PrivateFiles;
  readonly instances: ReadonlyArray<InstanceSpec>;
  readonly toolBridge: ToolBridge;
  /** Relative to each workspace folder, as Claude Code resolves it. */
  readonly systemPromptFile: string;
  /** The base prompt every bot shares, which Codex takes as `developer_instructions`. */
  readonly basePrompt: string;
  /** The folder of the skills every bot shares, which each Claude Code and Codex home links. */
  readonly sharedSkills: string;
  /** Whether the harnesses guess the operator's next message (`promptSuggestionsEnabled`). */
  readonly suggestReplies: boolean;
  /**
   * The server user's home folder (`HOME`), which the commands a Codex bot
   * runs get back (`codexConfig`), or undefined when the server has none, as
   * on Windows, where Codex then runs with the server's own environment.
   */
  readonly userHome: string | undefined;
}

/**
 * The provider connection: its base URL and its key, in one file of the
 * engine's secret store, written whole and renamed, so a new connection
 * replaces both at once and a write cut short leaves the one before it whole.
 * It is the single source of what every provisioning writes. The engine never
 * reads it: it reads and removes only the secrets its settings name (**Read**
 * at `bc0f04d`, `serverSettings.ts`).
 */
export const StoredConnection = Schema.Struct({ baseUrl: Schema.String, key: Schema.String });
type StoredConnection = typeof StoredConnection.Type;

/** The file of the engine's secret store that holds the provider connection. */
export const CONNECTION_FILE = "j3-provider-connection.json";

const connectionFile = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).secrets, CONNECTION_FILE);

/**
 * The variable that carries the connection's key to the harnesses. Each
 * harness's own configuration names it next to the URL: Codex's model
 * provider takes it as `env_key`, and Claude Code reads it through an
 * `apiKeyHelper`, which sends what it prints as the bearer token. **Verified**
 * with Claude Code 2.1.328 against a CLIProxyAPI endpoint: a turn answered
 * with the URL in the home's `settings.json` `env` and the key only in the
 * variable, and failed with the helper's error when the variable was missing.
 *
 * One name serves every connection: the engine and its harnesses are
 * provisioned only while the engine is stopped, so no harness that started
 * with one connection is still running when the next one is written.
 */
const KEY_VARIABLE = "J3_PROVIDER_KEY";

/** Codex's name for the connection's model provider. A dot would not survive TOML's dotted keys. */
const CODEX_MODEL_PROVIDER = "j3";

/** The engine's name for a J3 Bots provider id: a stable slug the engine accepts. */
export const instanceIdFor = (providerId: string) =>
  `j3-${NodeCrypto.createHash("sha256").update(providerId).digest("hex").slice(0, 24)}`;

/** The MCP server name of the bot tools. A dot would cost Codex the thread id. */
export const TOOL_SERVER = "j3";

/**
 * The engine's own tool server, as the harnesses name its tools:
 * `mcp__t3-code__delegate_task` on Claude Code, `t3-code.delegate_task` on
 * Codex and on ACP agents. **Verified** on `0.1.11`: a step of the scripted
 * agent's `delegate_task` call carried `t3-code.delegate_task`; the code it
 * rests on is unchanged at `bc0f04d`.
 */
export const ENGINE_TOOL_SERVER = "t3-code";

/**
 * The variable that gives an ACP agent the bot tools' bridge, as the JSON
 * array of its command line. The engine offers an ACP agent only the engine's
 * own MCP server, so one that calls J3 Bots' tools, as the scripted agent
 * does, starts the bridge itself: the bridge inherits the agent's
 * environment, and with it the session's thread id (`sessionOfToolCaller`).
 */
export const TOOL_BRIDGE_VARIABLE = "J3_TOOL_BRIDGE";

/**
 * The engine's browser tools, by their bare names (**Verified**, 2026-11:
 * the tool list a running engine gives Claude Code). A bot browses with J3 Bots' own browser
 * (decision 0110), and the engine's stays off (`ENGINE_SETTINGS`).
 */
const ENGINE_BROWSER_TOOLS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_snapshot",
  "preview_act",
  "preview_evaluate",
  "preview_wait_for",
  "preview_dialog",
  "preview_resize",
  "preview_set_appearance",
  "preview_recording_start",
  "preview_recording_stop",
  "t3_preview_list",
  "t3_preview_close",
] as const;

/**
 * Claude Code tools that reach a person outside J3 Bots or vanish with the
 * session, and the engine's browser tools. Removed from the model's tool
 * list; the base prompt names the J3 Bots replacement for each. Codex takes
 * no such list: there the engine's browser tools stay listed, and refuse
 * every call while the engine's browser is off.
 */
const CLAUDE_DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "PushNotification",
  ...ENGINE_BROWSER_TOOLS.map((tool) => `mcp__${ENGINE_TOOL_SERVER}__${tool}`),
];

/**
 * Claude Code's launch arguments. Only J3 Bots' own tools are pre-approved,
 * each by its exact name: every other tool the bridge lists, a connector's,
 * follows the session's permission mode like any of the harness's own tools.
 */
const claudeLaunchArgs = (systemPromptFile: string, toolBridge: ToolBridge) =>
  [
    "--append-system-prompt-file",
    systemPromptFile,
    ...(toolBridge.preApproved.length === 0
      ? []
      : [
          "--allowedTools",
          toolBridge.preApproved.map((tool) => `mcp__${TOOL_SERVER}__${tool}`).join(","),
        ]),
    "--disallowedTools",
    CLAUDE_DISALLOWED_TOOLS.join(","),
  ].join(" ");

// Engine settings J3 Bots owns. Everything else in the file is the engine's.
const ENGINE_SETTINGS = {
  // The engine looks up each harness's latest release, which the operator's
  // update needs (`server.updateProvider`). Set, as every setting here is,
  // so it holds whatever the file said before. **Read** at `bc0f04d`,
  // `enrichProviderSnapshotWithVersionAdvisory` in
  // `provider-core/src/server/maintenanceResolver.ts`.
  enableProviderUpdateChecks: true,
  // A bot's session must never be settled: a settled thread loses usage-limit
  // auto-resume and restart continuation.
  sidebarAutoSettleAfterDays: null,
  sidebarAutoSettleOnMerge: false,
  // An unattended bot has nobody to press a compact button.
  idleCompaction: "beforeCacheExpires",
  autoResumeLimitedThreads: true,
  // A turn an engine restart cuts short stays ended (`interrupted`): the engine
  // arms no restart continuation, whose pending state it never reports over
  // the socket J3 Bots reads. **Read** at `bc0f04d`, `RestartContinuation.ts`.
  continueThreadsAfterServerUpdate: false,
  // Also drops the engine's device instructions from every session.
  enableAgentDeviceAccess: false,
  // A bot browses with J3 Bots' own browser (decision 0110), never the
  // engine's; the engine's default is on. Releases before 0.16 turned it on
  // per project, which the adapter clears (`withoutBrowserAccess`).
  // **Read** at `bc0f04d`, `contracts/src/settings.ts`.
  enableAgentBrowserAccess: false,
} as const;

const DRIVERS = {
  "claude-code": "claudeAgent",
  codex: "codex",
  "acp-local": "acpRegistry",
} as const;

/** The engine's driver for an instance of Claude Code or Codex. */
export const driverOf = (harness: "claude-code" | "codex") => DRIVERS[harness];

/**
 * The instance the engine adds for each of its built-in drivers that has
 * one, under the driver's own name, whenever its settings do not name that
 * instance, and the driver of each. Claude Code's and Codex's start enabled,
 * with no home of their own: the engine probes them at every start, and each
 * probe runs the harness on the server user's own `~/.claude` and `~/.codex`,
 * which it creates and writes. So J3 Bots names every one of them, turned
 * off, and the engine checks and runs only J3 Bots' own instances. **Read**
 * at `bc0f04d`, `deriveProviderInstanceConfigMap` in
 * `ProviderInstanceRegistryHydration.ts` and `BUILT_IN_DRIVERS` in
 * `builtInDrivers.ts` (the ACP registry has no default instance); **Verified**
 * on `0.1.11` (`docs/architecture/engine.md#isolation`), and the code it rests
 * on is unchanged at `bc0f04d`.
 */
const ENGINE_DEFAULT_INSTANCES = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "kiro",
  "pi",
  "muse",
] as const;

/**
 * The home folder a Codex instance runs with, which J3 Bots owns and leaves
 * empty: Codex looks in its home folder, not only in `CODEX_HOME`, for user
 * skills (`~/.agents/skills`) and plugin marketplaces, so with the server
 * user's own a Codex bot would be offered theirs. **Read** in Codex 0.171.0,
 * `ext/skills/src/host_roots.rs` and `core-plugins/src/marketplace.rs`;
 * **Verified** with its app server's `skills/list`
 * (`docs/decisions/0019-codex-runs-with-a-home-of-its-own.md`). Only when the
 * commands a Codex bot runs get the server user's home back (`codexConfig`),
 * so undefined when the server has no `HOME`.
 */
const codexProcessHome = (path: Path.Path, input: ProvisionInput, instanceId: string) =>
  input.userHome === undefined
    ? undefined
    : path.join(engineFolders(path, input.home).codexHomes, instanceId);

/** Where the engine's secret store keeps one instance variable. **Read** at `bc0f04d`, `settingsSecrets.ts`. */
const secretFileName = (instanceId: string, variable: string) =>
  `provider-env-${Base64Url.encode(instanceId)}-${Base64Url.encode(variable)}.bin`;

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const isJsonObject = Schema.is(JsonObject);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

/** One variable as the engine's settings file keeps it. */
type SettingsVariable =
  | { readonly name: string; readonly value: string; readonly sensitive: false }
  /** The value lives in the engine's secret store; the file says only that it exists. */
  | {
      readonly name: string;
      readonly value: "";
      readonly sensitive: true;
      readonly valueRedacted: true;
    };

const secretVariable = (name: string): SettingsVariable => ({
  name,
  value: "",
  sensitive: true,
  valueRedacted: true,
});

/**
 * The variables the engine gives an instance for the connection: its key.
 * The URL is not among them: it is in the harness's own configuration, with
 * the name of its key's variable.
 */
const connectionVariables = (
  spec: InstanceSpec,
  connected: boolean,
): ReadonlyArray<SettingsVariable> =>
  spec.kind === "acp-local" || !connected ? [] : [secretVariable(KEY_VARIABLE)];

/**
 * What every Claude Code instance runs with for MCP: tool search on, so a
 * connector's tools are found when a turn needs them instead of filling each
 * request (J3 Bots' own tools ask to stay loaded), also through a provider
 * connection, for which Claude Code leaves it off by default; and room for a
 * tool description up to 8,192 characters, where Claude Code would cut at
 * 4,096, since `set_routine`'s is longer. What tool search saves through a
 * provider connection is **Verified** (`docs/architecture/engine.md`); that
 * J3 Bots' own tools then stay loaded, and the description limit, are
 * **Assumed** from Claude Code's documentation (`anthropic/alwaysLoad`,
 * `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`).
 */
const CLAUDE_MCP_VARIABLES: ReadonlyArray<SettingsVariable> = [
  { name: "ENABLE_TOOL_SEARCH", value: "true", sensitive: false },
  { name: "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", value: "8192", sensitive: false },
];

/**
 * The variables an instance runs with whatever the connection: for Codex, its
 * own home folder; for Claude Code, {@link CLAUDE_MCP_VARIABLES}, and for a
 * Claude Code J3 Bots installed, its own updater
 * turned off, since J3 Bots updates that copy itself and Claude Code's
 * updater would install another into the server user's home (**Assumed**
 * from Claude Code's documented `DISABLE_AUTOUPDATER`).
 */
const instanceVariables = (
  path: Path.Path,
  input: ProvisionInput,
  spec: InstanceSpec,
): ReadonlyArray<SettingsVariable> => {
  switch (spec.kind) {
    case "codex": {
      const home = codexProcessHome(path, input, spec.instanceId);
      return home === undefined ? [] : [{ name: "HOME", value: home, sensitive: false }];
    }
    case "claude-code":
      return !spec.ownCopy
        ? CLAUDE_MCP_VARIABLES
        : [...CLAUDE_MCP_VARIABLES, { name: "DISABLE_AUTOUPDATER", value: "1", sensitive: false }];
    case "acp-local":
      return [];
  }
};

/**
 * The executable a Claude Code or Codex instance runs, when J3 Bots installed
 * it or the operator chose one: the engine's `binaryPath`, which it runs in
 * place of the command on its `PATH` (**Read** at `bc0f04d`, `ClaudeSettings` and `CodexSettings` in
 * `contracts/src/settings.ts`).
 */
const binaryPath = (spec: { readonly executable: string | undefined }) =>
  spec.executable === undefined ? {} : { binaryPath: spec.executable };

const instanceConfig = (input: ProvisionInput, spec: InstanceSpec) => {
  switch (spec.kind) {
    case "claude-code":
      return {
        ...binaryPath(spec),
        homePath: spec.home,
        launchArgs: [
          claudeLaunchArgs(input.systemPromptFile, input.toolBridge),
          spec.launchArguments.trim(),
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      };
    case "codex":
      return {
        ...binaryPath(spec),
        homePath: spec.home,
        ...(spec.launchArguments.trim().length === 0
          ? {}
          : { launchArgs: spec.launchArguments.trim() }),
      };
    case "acp-local":
      return {
        source: "local",
        commandPath: spec.command,
        commandArgs: spec.args,
      };
  }
};

/**
 * The settings file with J3 Bots' keys and instances merged into what the
 * engine keeps there, and the engine's own default instances turned off
 * (`ENGINE_DEFAULT_INSTANCES`). An instance whose harness configuration J3
 * Bots could not write is turned off, so it never runs with a configuration
 * that belongs to another connection or lacks the bot tools.
 */
const engineSettings = (
  path: Path.Path,
  input: ProvisionInput,
  connected: boolean,
  disabled: ReadonlySet<string>,
  existing: Readonly<Record<string, unknown>>,
) => ({
  ...existing,
  ...ENGINE_SETTINGS,
  promptSuggestionsEnabled: input.suggestReplies,
  providerInstances: Object.fromEntries([
    ...ENGINE_DEFAULT_INSTANCES.map((driver) => [driver, { driver, enabled: false }] as const),
    ...input.instances.map(
      (spec) =>
        [spec.instanceId, instanceEntry(path, input, spec, { connected, disabled })] as const,
    ),
  ]),
});

/**
 * One instance as the engine's settings keep it, as provisioning writes it:
 * `connected` when a provider connection is stored, and turned off when it
 * is in `disabled`, the instances whose harness configuration could not be
 * written. A secret variable names its value in the engine's secret store
 * without carrying it, so the entry holds no secret.
 */
export const instanceEntry = (
  path: Path.Path,
  input: ProvisionInput,
  spec: InstanceSpec,
  state: { readonly connected: boolean; readonly disabled: ReadonlySet<string> },
) => ({
  driver: DRIVERS[spec.kind],
  displayName: spec.name,
  enabled: spec.enabled && !state.disabled.has(spec.instanceId),
  environment: [
    ...instanceVariables(path, input, spec),
    ...connectionVariables(spec, state.connected),
    ...spec.environment.map((variable) => secretVariable(variable.name)),
  ],
  config: instanceConfig(input, spec),
});

/**
 * The bridge's own variables as its entry in a harness's configuration
 * writes them, by name. The values are in the file: the harness hands them
 * to the bridge's process alone. The file is private to the server's user,
 * like the rest of the harness's home.
 */
const bridgeVariables = (toolBridge: ToolBridge): ReadonlyArray<readonly [string, string]> =>
  toolBridge.environment.map((variable) => [variable.name, Redacted.value(variable.value)]);

/**
 * J3 Bots' part of a Codex instance's `config.toml`: the base prompt, the
 * connection's model provider, the bot tools, the server user's home folder
 * for the commands a bot runs, and Codex's features. Codex itself runs with a
 * home of its own (`codexProcessHome`); `shell_environment_policy.set` puts
 * `HOME` back in the environment of every command it runs, so a bot's shell,
 * `git` and `gh` find the same configuration as a Claude Code bot's. **Read**
 * in Codex 0.171.0, `protocol/src/shell_environment.rs` `populate_env`, used
 * by its shell, `exec_command` and hook runners.
 *
 * The shell snapshot is off. With it, Codex runs the login shell once, with
 * its own environment, whose `HOME` is the empty one, and runs every command
 * in a plain shell that reads what that run captured, so a bot's commands
 * would never read the user's profile. Without it, each command runs as a
 * login shell (`bash -lc`) with the `HOME` above, which reads the profile as
 * a Claude Code bot's does. **Read** in Codex 0.171.0,
 * `core/src/shell_snapshot.rs`, `core/src/tools/runtimes/mod.rs`
 * `maybe_wrap_shell_lc_with_snapshot` and `core/src/shell.rs`
 * `derive_exec_args`; **Verified** through `exec_command`
 * (`docs/decisions/0019-codex-runs-with-a-home-of-its-own.md`). J3 Bots owns
 * `[features]`: only Codex's own terminal client and its `codex features`
 * command write it, and a bot runs with neither. Codex writes the rest of the
 * file itself (trusted projects, its own settings), and that is kept.
 */
const codexConfig = (input: ProvisionInput, connection: StoredConnection | null): TomlEdit => {
  const modelProvider: ReadonlyArray<TomlTable> =
    connection === null
      ? []
      : [
          {
            path: ["model_providers", CODEX_MODEL_PROVIDER],
            values: [
              ["name", "J3 Bots provider connection"],
              ["base_url", `${connection.baseUrl}/v1`],
              ["env_key", KEY_VARIABLE],
              ["wire_api", "responses"],
            ],
          },
        ];
  // Only J3 Bots' own tools are approved ahead, each by name; the server's
  // default stays Codex's, so a connector's tool follows the session's mode.
  // **Verified** with Codex 0.171.0: an approved tool runs without asking in
  // Supervised, any other asks, and in Full access none does. A call past
  // `tool_timeout_sec` is cut off, also one that reports progress. The
  // approvals are an inline `tools` table, the same TOML as a
  // `[mcp_servers.j3.tools.<name>]` table each, so that the server's table is
  // one pair also where the file writes `mcp_servers` as an inline table.
  const tools: TomlTable = {
    path: ["mcp_servers", TOOL_SERVER],
    values: [
      ["command", input.toolBridge.command],
      ["args", input.toolBridge.args],
      // The bridge's own variables, which Codex adds to the bridge's
      // environment only, not to the commands a bot runs.
      ["env", { inline: bridgeVariables(input.toolBridge) }],
      ["tool_timeout_sec", input.toolBridge.callTimeoutSeconds],
      [
        "tools",
        {
          inline: input.toolBridge.preApproved.map((tool): readonly [string, TomlInline] => [
            tool,
            { inline: [["approval_mode", "approve"]] },
          ]),
        },
      ],
    ],
  };
  const features: TomlTable = {
    path: ["features"],
    values: [
      ["shell_snapshot", false],
      // **Verified** with Codex 0.171.0: with it, Codex lists the `j3` server's
      // tools again when the bridge says they changed, and a tool added
      // mid-turn can be called in that turn; without it, not even at the
      // next turn. So a connector granted to a bot reaches it without a new
      // session.
      ["mcp_tool_list_changed", true],
    ],
  };
  const commandHome: ReadonlyArray<TomlTable> =
    input.userHome === undefined
      ? []
      : [{ path: ["shell_environment_policy", "set"], values: [["HOME", input.userHome]] }];
  return {
    keys: [
      ["developer_instructions", input.basePrompt],
      ["model_provider", connection === null ? undefined : CODEX_MODEL_PROVIDER],
    ],
    owns: [
      ["model_providers", CODEX_MODEL_PROVIDER],
      ["mcp_servers", TOOL_SERVER],
      ["shell_environment_policy", "set"],
      ["features"],
    ],
    tables: [...modelProvider, tools, ...commandHome, features],
  };
};

const decodeConnection = Schema.decodeUnknownOption(Schema.fromJsonString(StoredConnection));

/** A file J3 Bots must read to provision the engine, and could not, which it left as it is. */
class EngineFileUnreadable extends Schema.TaggedError<EngineFileUnreadable>()(
  "EngineFileUnreadable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.file} was left as it is: ${this.reason}. The engine does not start until it can be read.`;
  }
}

/** A harness configuration file J3 Bots cannot edit safely, which it left as it is. */
class HarnessConfigUnreadable extends Schema.TaggedError<HarnessConfigUnreadable>()(
  "HarnessConfigUnreadable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.file} was left as it is: ${this.reason}. Its provider stays off until the file is corrected or moved aside; J3 Bots writes its part when the engine next starts.`;
  }
}

/**
 * A file's text, or null when it does not exist: the first setup. Any other
 * failure to read it is `unreadable`'s, with the file's path and never its
 * contents.
 */
const readIfPresent = <E>(
  fs: FileSystem.FileSystem,
  file: string,
  unreadable: (reason: string) => E,
): Effect.Effect<string | null, E> =>
  fs.readFileString(file).pipe(
    Effect.map((text): string | null => text),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    Effect.mapError((error) => unreadable(`it could not be read (${error.reason._tag})`)),
  );

/** A JSON object file: `{}` when it does not exist, and `unreadable` when it is not a JSON object. */
const readJsonObject = <E>(
  fs: FileSystem.FileSystem,
  file: string,
  unreadable: (reason: string) => E,
): Effect.Effect<Readonly<Record<string, unknown>>, E> =>
  readIfPresent(fs, file, unreadable).pipe(
    Effect.flatMap((text) =>
      text === null
        ? Effect.succeed({})
        : Effect.fromOption(decodeJsonObject(text)).pipe(
            Effect.mapError(() => unreadable("it is not a JSON object")),
          ),
    ),
  );

/** The connection, or null when none was ever stored. */
const readConnection = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = connectionFile(path, home);
  const unreadable = (reason: string) => new EngineFileUnreadable({ file, reason });
  const text = yield* readIfPresent(fs, file, unreadable);
  if (text === null) return null;
  return yield* Effect.fromOption(decodeConnection(text)).pipe(
    Effect.mapError(() =>
      unreadable("it is not a provider connection; run `j3-bots provider connect` again"),
    ),
  );
});

/** The base URL of the stored connection, if one can be read. */
export const activeConnection = Effect.fn("engine.activeConnection")(function* (home: string) {
  return yield* readConnection(home).pipe(
    Effect.map((connection) => connection?.baseUrl ?? null),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Claude Code's `settings.json` with J3 Bots' part set: auto-memory off, and
 * the connection's URL and the variable its key is read from, together, or
 * neither when there is no connection. The rest is the harness's own.
 */
const claudeSettings = (
  settings: Readonly<Record<string, unknown>>,
  connection: StoredConnection | null,
) => {
  const rest = Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== "apiKeyHelper" && key !== "env"),
  );
  const env = Object.fromEntries(
    Object.entries(isJsonObject(settings["env"]) ? settings["env"] : {}).filter(
      ([key]) => key !== "ANTHROPIC_BASE_URL",
    ),
  );
  return {
    ...rest,
    // **Read** in Claude Code 2.1.328: `autoMemoryEnabled: false` turns auto-memory off.
    autoMemoryEnabled: false,
    ...(connection === null
      ? Object.keys(env).length === 0
        ? {}
        : { env }
      : {
          env: { ...env, ANTHROPIC_BASE_URL: connection.baseUrl },
          apiKeyHelper: `printenv ${KEY_VARIABLE}`,
        }),
  };
};

/**
 * Writes the engine's settings, its secret store and each harness's
 * configuration from the stored connection, and links the shared skills into
 * each Claude Code and Codex home (`linkSharedSkills`). Run only while the
 * engine is stopped, before each start (`Supervisor.beforeStart`): the engine
 * reads its settings, and each harness its configuration, when they start, so a
 * connection reaches every harness together with its key, and a provisioning
 * cut short is completed by the next one, which writes everything again.
 *
 * A harness configuration J3 Bots cannot edit safely is left as it is and its
 * instance is turned off, so the other harnesses still start; each such file
 * is logged by path, and the provider's status shows it off. A failure to
 * read the connection or the engine's own settings, or to write anything,
 * fails the provisioning, and the engine does not start.
 *
 * Answers the connection's key it gave the harnesses, null when there is no
 * connection: a secret the engine's words must not carry (`withoutSecrets`);
 * and the instances it turned off.
 */
const writeJson = Effect.fnUntraced(function* (files: PrivateFiles, file: string, value: unknown) {
  const text = yield* encodeJson(value).pipe(Effect.orDie);
  yield* files.write(file, `${text}\n`);
});

/**
 * Writes what `spec`'s instance needs besides its entry in the engine's
 * settings: its secret files, then what its harness reads in its home (J3
 * Bots' tool server, the base prompt, the connection, the shared skills).
 * `HarnessConfigUnreadable` for a configuration of the harness that cannot be
 * read, which is left as it was.
 */
const writeInstance = Effect.fnUntraced(function* (
  input: ProvisionInput,
  connection: StoredConnection | null,
  spec: InstanceSpec,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secrets } = engineFolders(path, input.home);
  const record = homeSkillLinkRecord(path, input.home, spec.instanceId);

  const secretFile = path.join(secrets, secretFileName(spec.instanceId, KEY_VARIABLE));
  if (connection !== null && spec.kind !== "acp-local") {
    yield* input.files.write(secretFile, connection.key);
  } else {
    yield* input.files.remove(secretFile);
  }
  for (const variable of spec.environment) {
    yield* input.files.write(
      path.join(secrets, secretFileName(spec.instanceId, variable.name)),
      Redacted.value(variable.value),
    );
  }

  const unreadable = (file: string) => (reason: string) =>
    new HarnessConfigUnreadable({ file, reason });
  switch (spec.kind) {
    case "claude-code": {
      yield* input.files.folder(spec.home);
      // Claude Code keeps its own state in `.claude.json`; merge, never replace.
      const stateFile = path.join(spec.home, ".claude.json");
      const settingsFile = path.join(spec.home, "settings.json");
      // Both are read before either is written, so a refusal changes neither.
      const state = yield* readJsonObject(fs, stateFile, unreadable(stateFile));
      const settings = yield* readJsonObject(fs, settingsFile, unreadable(settingsFile));
      const servers = isJsonObject(state["mcpServers"]) ? state["mcpServers"] : {};
      yield* writeJson(input.files, stateFile, {
        ...state,
        hasCompletedOnboarding: true,
        mcpServers: {
          ...servers,
          [TOOL_SERVER]: {
            type: "stdio",
            command: input.toolBridge.command,
            args: input.toolBridge.args,
            // Added to the bridge's environment only, not to the commands a bot runs.
            env: Object.fromEntries(bridgeVariables(input.toolBridge)),
            // Milliseconds. **Verified** with Claude Code 2.1.330: a call past
            // it is cut off, also one that reports progress, and the bridge
            // is sent `notifications/cancelled`. **Read** there: it
            // overrides `MCP_TOOL_TIMEOUT`, 1e8 ms by default.
            timeout: input.toolBridge.callTimeoutSeconds * 1000,
          },
        },
      });
      yield* writeJson(input.files, settingsFile, claudeSettings(settings, connection));
      yield* linkSharedSkills({
        files: input.files,
        home: spec.home,
        shared: input.sharedSkills,
        record,
      });
      return;
    }
    case "codex": {
      yield* input.files.folder(spec.home);
      const processHome = codexProcessHome(path, input, spec.instanceId);
      if (processHome !== undefined) yield* input.files.folder(processHome);
      const configFile = path.join(spec.home, "config.toml");
      const text = yield* readIfPresent(fs, configFile, unreadable(configFile));
      const edited = editToml(text ?? "", codexConfig(input, connection));
      if (edited._tag === "unreadable") return yield* unreadable(configFile)(edited.reason);
      yield* input.files.write(configFile, edited.text);
      yield* linkSharedSkills({
        files: input.files,
        home: spec.home,
        shared: input.sharedSkills,
        record,
      });
      return;
    }
    case "acp-local":
      return;
  }
});

/** `writeInstance`, telling whether its harness configuration was written: an instance's whose was not is turned off. */
const instanceWritten = (
  input: ProvisionInput,
  connection: StoredConnection | null,
  spec: InstanceSpec,
) =>
  writeInstance(input, connection, spec).pipe(
    Effect.as(true),
    Effect.catchTag("HarnessConfigUnreadable", (error) =>
      Effect.logWarning(error.message).pipe(Effect.as(false)),
    ),
  );

export const provision = Effect.fn("engine.provision")(function* (input: ProvisionInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const { userdata, secrets } = engineFolders(path, input.home);
  yield* input.files.folder(secrets);
  yield* fs.chmod(secrets, 0o700);
  for (const folder of Object.values(harnessDefaultHomes(path, input.home))) {
    yield* input.files.folder(folder);
  }

  const connection = yield* readConnection(input.home);
  const settingsFile = path.join(userdata, "settings.json");
  const existing = yield* readJsonObject(
    fs,
    settingsFile,
    (reason) => new EngineFileUnreadable({ file: settingsFile, reason }),
  );

  const disabled = new Set<string>();
  for (const spec of input.instances) {
    if (!(yield* instanceWritten(input, connection, spec))) disabled.add(spec.instanceId);
  }
  yield* writeJson(
    input.files,
    settingsFile,
    engineSettings(path, input, connection !== null, disabled, existing),
  );
  return {
    key: connection === null ? null : Redacted.make(connection.key),
    disabled,
  } as const;
});

/**
 * Prepares an instance the engine is given while it runs, as a provisioning
 * prepares each one (`writeInstance`), so a bot on an account added then can
 * speak and use J3 Bots' tools as on any other. Whether its harness
 * configuration was written: the entry of one that was not is turned off, as
 * a provisioning turns it off.
 */
export const provisionInstance = Effect.fn("engine.provisionInstance")(function* (
  input: ProvisionInput,
  spec: InstanceSpec,
) {
  return yield* instanceWritten(input, yield* readConnection(input.home), spec);
});

/**
 * Writes a new base prompt into each Codex instance's `config.toml`, and
 * nothing else: the rest of the provisioning has not changed. Codex reads it
 * for each thread it starts or resumes, so this is the one write J3 Bots
 * makes while the engine runs.
 */
export const writeBasePrompt = Effect.fn("engine.writeBasePrompt")(function* (input: {
  readonly files: PrivateFiles;
  readonly instances: ReadonlyArray<InstanceSpec>;
  readonly basePrompt: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const spec of input.instances) {
    if (spec.kind !== "codex") continue;
    const configFile = path.join(spec.home, "config.toml");
    const unreadable = (reason: string) =>
      new HarnessConfigUnreadable({ file: configFile, reason });
    // Not written yet: the next start writes it whole, with this prompt.
    const text = yield* readIfPresent(fs, configFile, unreadable);
    if (text === null) continue;
    const edited = editToml(text, {
      keys: [["developer_instructions", input.basePrompt]],
      owns: [],
      tables: [],
    });
    if (edited._tag === "unreadable") return yield* unreadable(edited.reason);
    yield* input.files.write(configFile, edited.text);
  }
});

/** The links made in an instance's home, in the adapter's own folder rather than the home. */
const homeSkillLinkRecord = (path: Path.Path, home: string, instanceId: string) =>
  path.join(engineFolders(path, home).j3, "skill-links", `${instanceId}.json`);

/**
 * Links the shared skills into each Claude Code and Codex home now, as a
 * provisioning does, while the engine runs: a skill added to the shared
 * folder or removed from it reaches the harnesses without a restart. Each
 * harness watches its skill folder (`docs/architecture/engine.md`).
 */
export const linkHomeSkills = Effect.fn("engine.linkHomeSkills")(function* (input: {
  readonly home: string;
  readonly files: PrivateFiles;
  readonly instances: ReadonlyArray<InstanceSpec>;
  readonly sharedSkills: string;
}) {
  const path = yield* Path.Path;
  for (const spec of input.instances) {
    if (spec.kind === "acp-local") continue;
    yield* linkSharedSkills({
      files: input.files,
      home: spec.home,
      shared: input.sharedSkills,
      record: homeSkillLinkRecord(path, input.home, spec.instanceId),
    });
  }
});

/**
 * The folders of a session's working folder where each harness lists project
 * skills, as `<folder>/skills`: Claude Code's `.claude/skills`, and Codex's
 * `.agents/skills` (it also reads `.codex/skills`, which J3 Bots leaves to
 * the bot). **Verified** with Claude Code 2.1.328 and Codex 0.170.0
 * (`docs/research/t3-code.md`, Skills). No folder is read by both.
 */
const PROJECT_SKILL_FOLDERS = [".claude", ".agents"] as const;

/**
 * Links a bot's own skills, each folder of `<workspace>/<skills>` with a
 * `SKILL.md`, into the folders each harness lists project skills from in that
 * workspace, the bot's engine project: one link per skill, as the shared
 * skills are linked into a harness home (`linkSharedSkills`), so a skill the
 * bot or the operator put there is offered by its harness. The links made are
 * recorded in the adapter's own folder, by the workspace's path. Never fails.
 */
export const linkProjectSkills = Effect.fn("engine.linkProjectSkills")(function* (input: {
  readonly home: string;
  readonly files: PrivateFiles;
  readonly workspace: string;
  readonly skills: string;
}) {
  const path = yield* Path.Path;
  const key = NodeCrypto.createHash("sha256").update(input.workspace).digest("hex").slice(0, 32);
  for (const folder of PROJECT_SKILL_FOLDERS) {
    yield* linkSharedSkills({
      files: input.files,
      home: path.join(input.workspace, folder),
      shared: path.join(input.workspace, input.skills),
      record: path.join(
        engineFolders(path, input.home).j3,
        "project-skill-links",
        `${key}-${folder.slice(1)}.json`,
      ),
    });
  }
});

/**
 * Stores a new provider connection, replacing the one before it in one
 * write. It reaches the harnesses at the engine's next start, which the
 * caller brings about.
 */
export const storeConnection = Effect.fn("engine.storeConnection")(function* (input: {
  readonly home: string;
  readonly files: PrivateFiles;
  readonly connection: { readonly baseUrl: string; readonly key: Redacted.Redacted<string> };
}) {
  const path = yield* Path.Path;
  const { secrets } = engineFolders(path, input.home);
  yield* input.files.folder(secrets);
  const record: StoredConnection = {
    baseUrl: input.connection.baseUrl,
    key: Redacted.value(input.connection.key),
  };
  const text = yield* encodeJson(record).pipe(Effect.orDie);
  yield* input.files.write(connectionFile(path, input.home), `${text}\n`);
});
