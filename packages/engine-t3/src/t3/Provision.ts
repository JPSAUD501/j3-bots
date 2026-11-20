// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- instance ids are a short SHA-256 of J3 Bots' provider id.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import { engineFolders, type PrivateFiles } from "./PrivateFiles.ts";
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
}

/**
 * The provider connection in force: the generation of its key, and its base
 * URL. Writing this record is what makes a generation the connection: the key
 * is staged first under its generation's name, and every provisioning
 * activates the recorded generation, so the URL and the key the harnesses get
 * always come from one connection, also after a write was cut short. The key
 * itself is only in the engine's secret store.
 */
const StoredConnection = Schema.Struct({ generation: Schema.String, baseUrl: Schema.String });
type StoredConnection = typeof StoredConnection.Type;

/** Where the record of the connection in force is kept, in the adapter's own folder. */
const connectionFile = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).j3, "provider-connection.json");

/**
 * A staged key, in the engine's secret store under a name the engine never
 * reads (**Read** at `db51b67`, `serverSettings.ts`: the engine reads and
 * removes only the secrets its settings name).
 */
const STAGED_KEY_PREFIX = "j3-provider-key-";
const stagedKeyFile = (path: Path.Path, secrets: string, generation: string) =>
  path.join(secrets, `${STAGED_KEY_PREFIX}${generation}.bin`);

/**
 * The variable that carries the connection's key to each harness: Claude
 * Code reads `ANTHROPIC_AUTH_TOKEN`; Codex reads the variable its model
 * provider's `env_key` names.
 */
const CONNECTION_KEY_VARIABLE = {
  "claude-code": "ANTHROPIC_AUTH_TOKEN",
  codex: "J3_PROVIDER_KEY",
} as const;

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
 * The variables through which an instance reaches the connection: for Claude
 * Code the endpoint, the key, and tool search turned off, which an endpoint
 * other than Anthropic's own may not serve (**Assumed** from the operator's
 * proxy setup, which turns it off for that reason); for Codex the key its
 * model provider names.
 */
const connectionVariables = (
  spec: InstanceSpec,
  connection: StoredConnection | null,
): ReadonlyArray<SettingsVariable> => {
  if (connection === null) return [];
  switch (spec.kind) {
    case "claude-code":
      return [
        { name: "ANTHROPIC_BASE_URL", value: connection.baseUrl, sensitive: false },
        secretVariable(CONNECTION_KEY_VARIABLE["claude-code"]),
        { name: "ENABLE_TOOL_SEARCH", value: "false", sensitive: false },
      ];
    case "codex":
      return [secretVariable(CONNECTION_KEY_VARIABLE.codex)];
    case "acp-local":
      return [];
  }
};

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

/** The settings file with J3 Bots' keys and instances merged into what the engine keeps there. */
const engineSettings = (
  input: ProvisionInput,
  connection: StoredConnection | null,
  existing: Readonly<Record<string, unknown>>,
) => ({
  ...existing,
  ...ENGINE_SETTINGS,
  providerInstances: Object.fromEntries(
    input.instances.map((spec) => [
      spec.instanceId,
      {
        driver: DRIVERS[spec.kind],
        displayName: spec.name,
        enabled: true,
        environment: [
          ...connectionVariables(spec, connection),
          ...spec.environment.map((variable) => secretVariable(variable.name)),
        ],
        config: instanceConfig(input, spec),
      },
    ]),
  ),
});

/**
 * J3 Bots' part of a Codex instance's `config.toml`: the base prompt, the
 * connection's model provider, and the bot tools. Codex writes the rest of the
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
              ["env_key", CONNECTION_KEY_VARIABLE.codex],
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
  return {
    keys: [
      ["developer_instructions", input.basePrompt],
      ["model_provider", connection === null ? undefined : CODEX_MODEL_PROVIDER],
    ],
    owns: ([table, name]) =>
      (table === "model_providers" && name === CODEX_MODEL_PROVIDER) ||
      (table === "mcp_servers" && name === TOOL_SERVER),
    tables: [...modelProvider, tools],
  };
};

const decodeConnection = Schema.decodeUnknownOption(Schema.fromJsonString(StoredConnection));

/** The record of the connection in force, if one was ever committed and can be read. */
const readConnection = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(connectionFile(path, home)).pipe(
    Effect.map((text) => Option.getOrNull(decodeConnection(text))),
    Effect.orElseSucceed(() => null),
  );
});

/** The base URL of the connection in force, if there is one. */
export const activeConnection = Effect.fn("engine.activeConnection")(function* (home: string) {
  return (yield* readConnection(home))?.baseUrl ?? null;
});

export const provision = Effect.fn("engine.provision")(function* (input: ProvisionInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const writeJson = Effect.fnUntraced(function* (file: string, value: unknown) {
    const text = yield* encodeJson(value).pipe(Effect.orDie);
    yield* input.files.write(file, `${text}\n`);
  });

  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));

  const readObject = (file: string) =>
    readText(file).pipe(
      Effect.map((text) => decodeJsonObject(text)),
      Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value : {})),
    );

  const { userdata, secrets } = engineFolders(path, input.home);
  yield* input.files.folder(secrets);
  yield* fs.chmod(secrets, 0o700);

  // The committed generation is activated: its key goes to every instance
  // that reaches the connection, and its URL into the settings below. Done on
  // every provisioning, so a connection whose activation was cut short is
  // completed at the next start.
  const recorded = yield* readConnection(input.home);
  const stagedKey =
    recorded === null
      ? null
      : yield* fs
          .readFileString(stagedKeyFile(path, secrets, recorded.generation))
          .pipe(Effect.orElseSucceed(() => null));
  if (recorded !== null && stagedKey === null) {
    yield* Effect.logWarning(
      "The provider connection's key is missing from the engine's secret store; connect the providers again",
    );
  }
  const connection = stagedKey === null ? null : recorded;
  for (const spec of input.instances) {
    if (stagedKey !== null && spec.kind !== "acp-local") {
      yield* input.files.write(
        path.join(secrets, secretFileName(spec.instanceId, CONNECTION_KEY_VARIABLE[spec.kind])),
        stagedKey,
      );
    }
    for (const variable of spec.environment) {
      yield* input.files.write(
        path.join(secrets, secretFileName(spec.instanceId, variable.name)),
        Redacted.value(variable.value),
      );
    }
    switch (spec.kind) {
      case "claude-code": {
        yield* input.files.folder(spec.home);
        // Claude Code keeps its own state in `.claude.json`; merge, never replace.
        const stateFile = path.join(spec.home, ".claude.json");
        const state = yield* readObject(stateFile);
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
        const settingsFile = path.join(spec.home, "settings.json");
        const settings = yield* readObject(settingsFile);
        // **Read** in Claude Code 2.1.328: `autoMemoryEnabled: false` turns auto-memory off.
        yield* writeJson(settingsFile, {
          ...settings,
          autoMemoryEnabled: false,
        });
        break;
      }
      case "codex": {
        yield* input.files.folder(spec.home);
        const configFile = path.join(spec.home, "config.toml");
        yield* input.files.write(
          configFile,
          editToml(yield* readText(configFile), codexConfig(input, connection)),
        );
        break;
      }
      case "acp-local":
        break;
    }
  }

  const settingsFile = path.join(userdata, "settings.json");
  const existing = yield* readObject(settingsFile);
  yield* writeJson(settingsFile, engineSettings(input, connection, existing));

  // Keys staged for a generation that never became the connection, or that
  // another one replaced.
  for (const name of yield* fs.readDirectory(secrets)) {
    if (
      name.startsWith(STAGED_KEY_PREFIX) &&
      (connection === null ||
        path.join(secrets, name) !== stagedKeyFile(path, secrets, connection.generation))
    ) {
      yield* input.files.remove(path.join(secrets, name));
    }
  }
});

/**
 * Writes a new base prompt into each Codex instance's `config.toml`, and
 * nothing else: the rest of the provisioning has not changed.
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
    const text = yield* fs.readFileString(configFile).pipe(Effect.orElseSucceed(() => ""));
    yield* input.files.write(
      configFile,
      editToml(text, {
        keys: [["developer_instructions", input.basePrompt]],
        owns: () => false,
        tables: [],
      }),
    );
  }
});

/** Random bytes in a generation's name. */
const GENERATION_BYTES = 12;

/**
 * Commits a new provider connection: its key is staged under a new
 * generation, then the record names that generation and the base URL. Until
 * the record is written the connection before it stays in force; once it is,
 * the next provisioning activates the new one, so the caller provisions right
 * after.
 */
export const storeConnection = Effect.fn("engine.storeConnection")(function* (input: {
  readonly home: string;
  readonly files: PrivateFiles;
  readonly connection: { readonly baseUrl: string; readonly key: Redacted.Redacted<string> };
}) {
  const path = yield* Path.Path;
  const { j3, secrets } = engineFolders(path, input.home);
  const random = yield* SecureRandom.SecureRandom;
  const generation = Hex.encode(yield* random.randomBytes(GENERATION_BYTES));
  yield* input.files.folder(secrets);
  yield* input.files.write(
    stagedKeyFile(path, secrets, generation),
    Redacted.value(input.connection.key),
  );
  yield* input.files.folder(j3);
  const record: StoredConnection = { generation, baseUrl: input.connection.baseUrl };
  const text = yield* encodeJson(record).pipe(Effect.orDie);
  yield* input.files.write(connectionFile(path, input.home), `${text}\n`);
});
