// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- instance ids are a short SHA-256 of J3 Bots' provider id.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { engineFolders, harnessDefaultHomes, type PrivateFiles } from "./PrivateFiles.ts";
import { linkSharedSkills } from "./SkillLinks.ts";
import { editToml, type TomlEdit, type TomlTable } from "./toml.ts";

// Everything J3 Bots writes into the engine's data directory and the provider
// homes it owns. Every file is written whole to a new file and renamed
// (`PrivateFiles`), so the engine, which watches its settings file, never
// reads half of one.

/** One harness instance, in the shape the engine needs it. */
export type InstanceSpec =
  | {
      readonly kind: "claude-code";
      readonly instanceId: string;
      readonly name: string;
      readonly home: string;
      readonly environment: ReadonlyArray<EnvironmentVariable>;
    }
  | {
      readonly kind: "codex";
      readonly instanceId: string;
      readonly name: string;
      readonly home: string;
      readonly environment: ReadonlyArray<EnvironmentVariable>;
    }
  | {
      /** An Agent Client Protocol agent started as a local command. */
      readonly kind: "acp-local";
      readonly instanceId: string;
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly environment: ReadonlyArray<EnvironmentVariable>;
    };

interface EnvironmentVariable {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export interface ProvisionInput {
  /** The engine's `--base-dir`. */
  readonly home: string;
  readonly files: PrivateFiles;
  readonly instances: ReadonlyArray<InstanceSpec>;
  readonly toolBridge: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };
  /** Relative to each workspace folder, as Claude Code resolves it. */
  readonly systemPromptFile: string;
  /** The base prompt every bot shares, which Codex takes as `developer_instructions`. */
  readonly basePrompt: string;
  /** The folder of the skills every bot shares, which each Claude Code and Codex home links. */
  readonly sharedSkills: string;
  /**
   * The server user's home folder (`HOME`), which the commands a Codex bot
   * runs get back (`codexConfig`), or undefined when the server has none.
   */
  readonly userHome: string | undefined;
}

/**
 * The provider connection: its base URL and its key, in one file of the
 * engine's secret store, written whole and renamed, so a new connection
 * replaces both at once and a write cut short leaves the one before it whole.
 * It is the single source of what every provisioning writes. The engine never
 * reads it: it reads and removes only the secrets its settings name (**Read**
 * at `db51b67`, `serverSettings.ts`).
 */
const StoredConnection = Schema.Struct({ baseUrl: Schema.String, key: Schema.String });
type StoredConnection = typeof StoredConnection.Type;

const connectionFile = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).secrets, "j3-provider-connection.json");

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
 * Claude Code tools that reach a person outside J3 Bots or vanish with the
 * session. Removed from the model's tool list; the base prompt names the J3
 * Bots replacement for each.
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
] as const;

const claudeLaunchArgs = (systemPromptFile: string) =>
  [
    "--append-system-prompt-file",
    systemPromptFile,
    "--allowedTools",
    `mcp__${TOOL_SERVER}__*`,
    "--disallowedTools",
    CLAUDE_DISALLOWED_TOOLS.join(","),
  ].join(" ");

// Engine settings J3 Bots owns. Everything else in the file is the engine's.
const ENGINE_SETTINGS = {
  // The engine would look up each harness's latest release to offer an
  // update, with the harness's package manager (`npm view`, `npm outdated -g`),
  // which writes its cache in the server user's home. J3 Bots offers no
  // harness update. **Read** at `59651c1`, `enrichProviderSnapshotWithVersionAdvisory`
  // in `provider-core/src/server/maintenanceResolver.ts`.
  enableProviderUpdateChecks: false,
  // A bot's session must never be settled: a settled thread loses usage-limit
  // auto-resume and restart continuation.
  sidebarAutoSettleAfterDays: null,
  sidebarAutoSettleOnMerge: false,
  // An unattended bot has nobody to press a compact button.
  idleCompaction: "beforeCacheExpires",
  autoResumeLimitedThreads: true,
  // A turn an engine restart cuts short stays ended (`interrupted`): the engine
  // arms no restart continuation, whose pending state it never reports over
  // the socket J3 Bots reads. **Read** at `db51b67`, `RestartContinuation.ts`.
  continueThreadsAfterServerUpdate: false,
  // Also drops the engine's device instructions from every session.
  enableAgentDeviceAccess: false,
} as const;

const DRIVERS = {
  "claude-code": "claudeAgent",
  codex: "codex",
  "acp-local": "acpRegistry",
} as const;

/**
 * The instance the engine adds for each of its built-in drivers that has
 * one, under the driver's own name, whenever its settings do not name that
 * instance, and the driver of each. Claude Code's and Codex's start enabled,
 * with no home of their own: the engine probes them at every start, and each
 * probe runs the harness on the server user's own `~/.claude` and `~/.codex`,
 * which it creates and writes. So J3 Bots names every one of them, turned
 * off, and the engine checks and runs only J3 Bots' own instances. **Read**
 * at `59651c1`, `deriveProviderInstanceConfigMap` in
 * `ProviderInstanceRegistryHydration.ts` and `BUILT_IN_DRIVERS` in
 * `builtInDrivers.ts` (the ACP registry has no default instance); **Verified**
 * on `0.1.11` (`docs/architecture/engine.md#isolation`).
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
 * (`docs/decisions/0019-codex-runs-with-a-home-of-its-own.md`). The commands
 * a Codex bot runs get the server user's home back (`codexConfig`).
 */
const codexProcessHome = (path: Path.Path, home: string, instanceId: string) =>
  path.join(engineFolders(path, home).codexHomes, instanceId);

/** Where the engine's secret store keeps one instance variable. **Read** at `db51b67`, `settingsSecrets.ts`. */
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
 * The variables the engine gives an instance for the connection: its key,
 * and for Claude Code tool search turned off, which an endpoint other than
 * Anthropic's own may not serve (**Assumed** from the operator's proxy setup,
 * which turns it off for that reason). The URL is not among them: it is in
 * the harness's own configuration, with the name of its key's variable.
 */
const connectionVariables = (
  spec: InstanceSpec,
  connected: boolean,
): ReadonlyArray<SettingsVariable> => {
  if (spec.kind === "acp-local" || !connected) return [];
  const key = secretVariable(KEY_VARIABLE);
  return spec.kind === "claude-code"
    ? [key, { name: "ENABLE_TOOL_SEARCH", value: "false", sensitive: false }]
    : [key];
};

/** The variables an instance runs with whatever the connection: for Codex, its own home folder. */
const instanceVariables = (
  path: Path.Path,
  input: ProvisionInput,
  spec: InstanceSpec,
): ReadonlyArray<SettingsVariable> =>
  spec.kind === "codex"
    ? [
        {
          name: "HOME",
          value: codexProcessHome(path, input.home, spec.instanceId),
          sensitive: false,
        },
      ]
    : [];

const instanceConfig = (input: ProvisionInput, spec: InstanceSpec) => {
  switch (spec.kind) {
    case "claude-code":
      return {
        homePath: spec.home,
        launchArgs: claudeLaunchArgs(input.systemPromptFile),
      };
    case "codex":
      return { homePath: spec.home };
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
  providerInstances: Object.fromEntries([
    ...ENGINE_DEFAULT_INSTANCES.map((driver) => [driver, { driver, enabled: false }] as const),
    ...input.instances.map(
      (spec) =>
        [
          spec.instanceId,
          {
            driver: DRIVERS[spec.kind],
            displayName: spec.name,
            enabled: !disabled.has(spec.instanceId),
            environment: [
              ...instanceVariables(path, input, spec),
              ...connectionVariables(spec, connected),
              ...spec.environment.map((variable) => secretVariable(variable.name)),
            ],
            config: instanceConfig(input, spec),
          },
        ] as const,
    ),
  ]),
});

/**
 * J3 Bots' part of a Codex instance's `config.toml`: the base prompt, the
 * connection's model provider, the bot tools, and the server user's home
 * folder for the commands a bot runs. Codex itself runs with a home of its
 * own (`codexProcessHome`); `shell_environment_policy.set` puts `HOME` back
 * in the environment of every command it runs, so a bot's shell, `git` and
 * `gh` find the same configuration as a Claude Code bot's. **Read** in Codex
 * 0.171.0, `protocol/src/shell_environment.rs` `populate_env`, used by its
 * shell, `exec_command` and hook runners. Codex writes the rest of the file
 * itself (trusted projects, its own settings), and that is kept.
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
  const tools: TomlTable = {
    path: ["mcp_servers", TOOL_SERVER],
    values: [
      ["command", input.toolBridge.command],
      ["args", input.toolBridge.args],
      ["default_tools_approval_mode", "approve"],
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
    ],
    tables: [...modelProvider, tools, ...commandHome],
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
 */
export const provision = Effect.fn("engine.provision")(function* (input: ProvisionInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const writeJson = Effect.fnUntraced(function* (file: string, value: unknown) {
    const text = yield* encodeJson(value).pipe(Effect.orDie);
    yield* input.files.write(file, `${text}\n`);
  });

  const { j3, userdata, secrets } = engineFolders(path, input.home);
  /** The links made in an instance's home, in the adapter's own folder rather than the home. */
  const skillLinkRecord = (instanceId: string) =>
    path.join(j3, "skill-links", `${instanceId}.json`);
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

  const harness = Effect.fnUntraced(function* (spec: InstanceSpec) {
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
        yield* writeJson(stateFile, {
          ...state,
          hasCompletedOnboarding: true,
          mcpServers: {
            ...servers,
            [TOOL_SERVER]: {
              type: "stdio",
              command: input.toolBridge.command,
              args: input.toolBridge.args,
              env: {},
            },
          },
        });
        yield* writeJson(settingsFile, claudeSettings(settings, connection));
        yield* linkSharedSkills({
          files: input.files,
          home: spec.home,
          shared: input.sharedSkills,
          record: skillLinkRecord(spec.instanceId),
        });
        return;
      }
      case "codex": {
        yield* input.files.folder(spec.home);
        yield* input.files.folder(codexProcessHome(path, input.home, spec.instanceId));
        const configFile = path.join(spec.home, "config.toml");
        const text = yield* readIfPresent(fs, configFile, unreadable(configFile));
        const edited = editToml(text ?? "", codexConfig(input, connection));
        if (edited._tag === "unreadable") return yield* unreadable(configFile)(edited.reason);
        yield* input.files.write(configFile, edited.text);
        yield* linkSharedSkills({
          files: input.files,
          home: spec.home,
          shared: input.sharedSkills,
          record: skillLinkRecord(spec.instanceId),
        });
        return;
      }
      case "acp-local":
        return;
    }
  });

  const disabled = new Set<string>();
  for (const spec of input.instances) {
    const written = yield* harness(spec).pipe(
      Effect.as(true),
      Effect.catchTag("HarnessConfigUnreadable", (error) =>
        Effect.logWarning(error.message).pipe(Effect.as(false)),
      ),
    );
    if (!written) disabled.add(spec.instanceId);
  }

  for (const spec of input.instances) {
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
  }
  yield* writeJson(
    settingsFile,
    engineSettings(path, input, connection !== null, disabled, existing),
  );
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
