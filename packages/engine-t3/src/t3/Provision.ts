// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- instance ids are a short SHA-256 of J3 Bots' provider id.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// Everything J3 Bots writes into the engine's data directory and the provider
// homes it owns. Every file is written whole to a temporary name and renamed,
// so the engine, which watches its settings file, never reads half of one.

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

export interface EnvironmentVariable {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export interface ProvisionInput {
  /** The engine's `--base-dir`. */
  readonly home: string;
  readonly instances: ReadonlyArray<InstanceSpec>;
  readonly toolBridge: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };
  /** Relative to each workspace folder, as Claude Code resolves it. */
  readonly systemPromptFile: string;
  /** The base prompt, which Codex reads from `developer_instructions`. */
  readonly codexDeveloperInstructions: string;
}

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
export const CLAUDE_DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "PushNotification",
] as const;

export const claudeLaunchArgs = (systemPromptFile: string) =>
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
  // Also drops the engine's device instructions from every session.
  enableAgentDeviceAccess: false,
} as const;

const DRIVERS = {
  "claude-code": "claudeAgent",
  codex: "codex",
  "acp-local": "acpRegistry",
} as const;

/** Where the engine's secret store keeps one instance variable. **Read** at `db51b67`, `settingsSecrets.ts`. */
export const secretFileName = (instanceId: string, variable: string) =>
  `provider-env-${Base64Url.encode(instanceId)}-${Base64Url.encode(variable)}.bin`;

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const isJsonObject = Schema.is(JsonObject);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

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
export const engineSettings = (
  input: ProvisionInput,
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
        // The value lives in the engine's secret store; the file says only that it exists.
        environment: spec.environment.map((variable) => ({
          name: variable.name,
          value: "",
          sensitive: true,
          valueRedacted: true,
        })),
        config: instanceConfig(input, spec),
      },
    ]),
  ),
});

const tomlString = (value: string) => JSON.stringify(value);

/** The J3-owned `config.toml` of a Codex instance. J3 Bots owns the whole file. */
export const codexConfig = (input: ProvisionInput) =>
  [
    "# Written by J3 Bots. Changes here are overwritten.",
    `developer_instructions = ${tomlString(input.codexDeveloperInstructions)}`,
    "",
    `[mcp_servers.${TOOL_SERVER}]`,
    `command = ${tomlString(input.toolBridge.command)}`,
    `args = [${input.toolBridge.args.map(tomlString).join(", ")}]`,
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");

export const provision = Effect.fn("engine.provision")(function* (input: ProvisionInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const writeAtomically = Effect.fnUntraced(function* (
    file: string,
    contents: string,
    mode: number,
  ) {
    const temporary = `${file}.j3.tmp`;
    yield* fs.writeFileString(temporary, contents, { mode });
    yield* fs.chmod(temporary, mode);
    yield* fs.rename(temporary, file);
  });
  const writeJson = Effect.fnUntraced(function* (file: string, value: unknown) {
    const text = yield* encodeJson(value).pipe(Effect.orDie);
    yield* writeAtomically(file, `${text}\n`, 0o600);
  });

  const readObject = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => decodeJsonObject(text)),
      Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value : {})),
      Effect.orElseSucceed((): Readonly<Record<string, unknown>> => ({})),
    );

  const userdata = path.join(input.home, "userdata");
  const secrets = path.join(userdata, "secrets");
  yield* fs.makeDirectory(secrets, { recursive: true, mode: 0o700 });
  yield* fs.chmod(secrets, 0o700);

  for (const spec of input.instances) {
    for (const variable of spec.environment) {
      yield* writeAtomically(
        path.join(secrets, secretFileName(spec.instanceId, variable.name)),
        Redacted.value(variable.value),
        0o600,
      );
    }
    switch (spec.kind) {
      case "claude-code": {
        yield* fs.makeDirectory(spec.home, { recursive: true, mode: 0o700 });
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
        yield* fs.makeDirectory(spec.home, { recursive: true, mode: 0o700 });
        yield* writeAtomically(path.join(spec.home, "config.toml"), codexConfig(input), 0o600);
        break;
      }
      case "acp-local":
        break;
    }
  }

  const settingsFile = path.join(userdata, "settings.json");
  const existing = yield* readObject(settingsFile);
  yield* writeJson(settingsFile, engineSettings(input, existing));
});
