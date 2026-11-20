// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- instance ids are a short SHA-256 of J3 Bots' provider id.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
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
 * The variable that carries a generation's key to the harnesses. Its name
 * carries the generation, and so does the engine's secret file that holds it,
 * so a new key never overwrites the one an earlier URL is paired with. Each
 * harness's own configuration names the variable next to the URL: Codex's
 * model provider takes it as `env_key`, and Claude Code reads it through an
 * `apiKeyHelper`, which sends what it prints as the bearer token. **Verified**
 * with Claude Code 2.1.328 against a CLIProxyAPI endpoint: a turn answered
 * with the URL in the home's `settings.json` `env` and the key only in the
 * variable, and failed with the helper's error when the variable was missing.
 */
const KEY_VARIABLE_PREFIX = "J3_PROVIDER_KEY_";
const keyVariable = (generation: string) => `${KEY_VARIABLE_PREFIX}${generation}`;

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

/** The key generation an instance's secret file holds, if it holds one. */
const keyGenerationOf = (instanceId: string, name: string): string | null => {
  const prefix = `provider-env-${Base64Url.encode(instanceId)}-`;
  if (!name.startsWith(prefix) || !name.endsWith(".bin")) return null;
  const variable = Base64Url.decodeString(name.slice(prefix.length, -".bin".length));
  return Result.isSuccess(variable) && variable.success.startsWith(KEY_VARIABLE_PREFIX)
    ? variable.success.slice(KEY_VARIABLE_PREFIX.length)
    : null;
};

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
 * The variables the engine gives an instance for the connection: the key of
 * each generation in `generations`, and for Claude Code tool search turned
 * off, which an endpoint other than Anthropic's own may not serve
 * (**Assumed** from the operator's proxy setup, which turns it off for that
 * reason). The URL is not among them: it is in the harness's own
 * configuration, with the name of its key's variable.
 */
const connectionVariables = (
  spec: InstanceSpec,
  generations: ReadonlyArray<string>,
): ReadonlyArray<SettingsVariable> => {
  if (spec.kind === "acp-local" || generations.length === 0) return [];
  const keys = generations.map((generation) => secretVariable(keyVariable(generation)));
  return spec.kind === "claude-code"
    ? [...keys, { name: "ENABLE_TOOL_SEARCH", value: "false", sensitive: false }]
    : keys;
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
  generations: (spec: InstanceSpec) => ReadonlyArray<string>,
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
          ...connectionVariables(spec, generations(spec)),
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
              ["env_key", keyVariable(connection.generation)],
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
    owns: [
      ["model_providers", CODEX_MODEL_PROVIDER],
      ["mcp_servers", TOOL_SERVER],
    ],
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

/** A harness configuration file J3 Bots cannot edit safely, which it left as it is. */
class HarnessConfigUnreadable extends Schema.TaggedError<HarnessConfigUnreadable>()(
  "HarnessConfigUnreadable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.file} was left as it is: ${this.reason}. Correct it or move it aside, and J3 Bots writes its part at the next start.`;
  }
}

/** The names of the variables each instance has in the engine's settings, as last written. */
const DeclaredVariables = Schema.Struct({
  providerInstances: Schema.Record(
    Schema.String,
    Schema.Struct({
      environment: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
});
const decodeDeclared = Schema.decodeUnknownOption(DeclaredVariables);

/** The key generations the engine's settings give an instance. */
const declaredGenerations = (
  settings: Readonly<Record<string, unknown>>,
  instanceId: string,
): ReadonlyArray<string> =>
  Option.match(decodeDeclared(settings), {
    onNone: () => [],
    onSome: (declared) =>
      (declared.providerInstances[instanceId]?.environment ?? []).flatMap((variable) =>
        variable.name.startsWith(KEY_VARIABLE_PREFIX)
          ? [variable.name.slice(KEY_VARIABLE_PREFIX.length)]
          : [],
      ),
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
          apiKeyHelper: `printenv ${keyVariable(connection.generation)}`,
        }),
  };
};

/**
 * Writes the engine's settings and each harness's configuration for the
 * recorded connection, so that every URL a harness is given comes with its
 * own key, whichever step a failure cuts short:
 *
 * 1. The key goes into the engine's secret store under its generation's
 *    variable, beside the keys of earlier generations, which stay.
 * 2. The engine's settings name the new variable next to those the harnesses'
 *    configuration may still name.
 * 3. Each harness's configuration gets the URL with the name of its key's
 *    variable, in one file.
 * 4. The engine's settings name the new variable alone.
 * 5. The keys no variable names any more are removed.
 *
 * Done on every provisioning, so a connection whose activation was cut short
 * is completed at the next start.
 */
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
  const current = connection === null ? [] : [connection.generation];
  const settingsFile = path.join(userdata, "settings.json");
  const before = yield* readObject(settingsFile);
  const secretFile = (spec: InstanceSpec, variable: string) =>
    path.join(secrets, secretFileName(spec.instanceId, variable));

  // 1.
  for (const spec of input.instances) {
    if (stagedKey !== null && connection !== null && spec.kind !== "acp-local") {
      yield* input.files.write(secretFile(spec, keyVariable(connection.generation)), stagedKey);
    }
    for (const variable of spec.environment) {
      yield* input.files.write(secretFile(spec, variable.name), Redacted.value(variable.value));
    }
  }

  // 2.
  yield* writeJson(
    settingsFile,
    engineSettings(
      input,
      (spec) => [...new Set([...declaredGenerations(before, spec.instanceId), ...current])],
      before,
    ),
  );

  // 3.
  for (const spec of input.instances) {
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
        const harnessSettings = path.join(spec.home, "settings.json");
        yield* writeJson(
          harnessSettings,
          claudeSettings(yield* readObject(harnessSettings), connection),
        );
        break;
      }
      case "codex": {
        yield* input.files.folder(spec.home);
        const configFile = path.join(spec.home, "config.toml");
        const edited = editToml(yield* readText(configFile), codexConfig(input, connection));
        if (edited._tag === "unreadable") {
          return yield* new HarnessConfigUnreadable({ file: configFile, reason: edited.reason });
        }
        yield* input.files.write(configFile, edited.text);
        break;
      }
      case "acp-local":
        break;
    }
  }

  // 4.
  yield* writeJson(
    settingsFile,
    engineSettings(input, () => current, yield* readObject(settingsFile)),
  );

  // 5. Every other generation's key: one whose activation was cut short
  // before the engine's settings named it is removed here too.
  const stored = yield* fs.readDirectory(secrets);
  for (const spec of input.instances) {
    for (const name of stored) {
      const generation = keyGenerationOf(spec.instanceId, name);
      if (generation !== null && generation !== connection?.generation) {
        yield* input.files.remove(path.join(secrets, name));
      }
    }
  }
  for (const name of stored) {
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
    const edited = editToml(text, {
      keys: [["developer_instructions", input.basePrompt]],
      owns: [],
      tables: [],
    });
    if (edited._tag === "unreadable") {
      return yield* new HarnessConfigUnreadable({ file: configFile, reason: edited.reason });
    }
    yield* input.files.write(configFile, edited.text);
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
