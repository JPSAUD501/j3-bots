// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as PlatformError from "effect/PlatformError";
import { parse } from "smol-toml";
import { engineFolders, makePrivateFiles, type PrivateFiles } from "./PrivateFiles.ts";
import {
  type InstanceSpec,
  linkHomeSkills,
  linkProjectSkills,
  provision,
  provisionInstance,
  storeConnection,
  writeBasePrompt,
} from "./Provision.ts";

/** Every line logged while these tests run, as JSON. */
const logged: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.map(Logger.formatJson, (line) => {
    logged.push(line);
  }),
]);

const machine = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto, recordLogs);

const Settings = Schema.fromJsonString(
  Schema.Struct({
    providerInstances: Schema.Record(
      Schema.String,
      Schema.Struct({
        enabled: Schema.Boolean,
        config: Schema.optional(
          Schema.Struct({
            launchArgs: Schema.optional(Schema.String),
            binaryPath: Schema.optional(Schema.String),
          }),
        ),
        environment: Schema.optional(
          Schema.Array(
            Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
          ),
        ),
      }),
    ),
  }),
);

const ClaudeState = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(
      Schema.String,
      Schema.Struct({ timeout: Schema.Number, env: Schema.Record(Schema.String, Schema.String) }),
    ),
  }),
);

const ClaudeSettings = Schema.fromJsonString(
  Schema.Struct({
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    apiKeyHelper: Schema.optional(Schema.String),
  }),
);

const setUp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const files = yield* makePrivateFiles(() => Effect.succeed(true));
  const instances: ReadonlyArray<InstanceSpec> = [
    {
      kind: "claude-code",
      instanceId: "j3-claude",
      name: "Claude Code",
      home: path.join(home, "claude-code"),
      executable: undefined,
      ownCopy: false,
      launchArguments: "",
      enabled: true,
      environment: [],
    },
    {
      kind: "codex",
      instanceId: "j3-codex",
      name: "Codex",
      home: path.join(home, "codex"),
      executable: undefined,
      ownCopy: false,
      launchArguments: "",
      enabled: true,
      environment: [],
    },
  ];
  const input = {
    home,
    files,
    instances,
    toolBridge: {
      command: "/usr/bin/node",
      args: ["bridge.js"],
      environment: [{ name: "J3_BRIDGE_KEY", value: Redacted.make("the-bridge-key") }],
      preApproved: ["say", "ask"],
      callTimeoutSeconds: 720,
    },
    systemPromptFile: ".j3/system.md",
    basePrompt: 'Say "done" when done.',
    suggestReplies: true,
    sharedSkills: path.join(home, "shared-skills"),
    userHome: "/home/sam",
  };
  const { userdata, secrets } = engineFolders(path, home);
  const settings = Effect.gen(function* () {
    return yield* Schema.decodeEffect(Settings)(
      yield* fs.readFileString(path.join(userdata, "settings.json")),
    );
  });
  /**
   * The connection Claude Code would use: the URL in its home's settings, and
   * the key of the variable its key helper prints, which the engine gives it
   * only while its settings name that variable.
   */
  const claudeConnection = Effect.gen(function* () {
    const harness = yield* Schema.decodeEffect(ClaudeSettings)(
      yield* fs.readFileString(path.join(home, "claude-code", "settings.json")),
    );
    const variable = harness.apiKeyHelper?.replace(/^printenv /, "");
    const declared = (yield* settings).providerInstances["j3-claude"]?.environment ?? [];
    const keyFile = path.join(
      secrets,
      `provider-env-${Base64Url.encode("j3-claude")}-${Base64Url.encode(variable ?? "")}.bin`,
    );
    return {
      url: harness.env?.ANTHROPIC_BASE_URL,
      key:
        variable === undefined || !declared.some(({ name }) => name === variable)
          ? undefined
          : yield* fs.readFileString(keyFile).pipe(Effect.orElseSucceed(() => undefined)),
    };
  });
  /** The connection Codex would use: its model provider's URL and the key of its `env_key`. */
  const codexConnection = Effect.gen(function* () {
    const config = yield* fs.readFileString(path.join(home, "codex", "config.toml"));
    const url = /^base_url = "(.*)\/v1"$/m.exec(config)?.[1];
    const variable = /^env_key = "(.*)"$/m.exec(config)?.[1];
    const declared = (yield* settings).providerInstances["j3-codex"]?.environment ?? [];
    const keyFile = path.join(
      secrets,
      `provider-env-${Base64Url.encode("j3-codex")}-${Base64Url.encode(variable ?? "")}.bin`,
    );
    return {
      url,
      key:
        variable === undefined || !declared.some(({ name }) => name === variable)
          ? undefined
          : yield* fs.readFileString(keyFile).pipe(Effect.orElseSucceed(() => undefined)),
    };
  });
  return {
    fs,
    path,
    home,
    files,
    instances,
    input,
    userdata,
    secrets,
    settings,
    claudeConnection,
    codexConnection,
  };
});

/**
 * Files whose `nth` write to a file ending in `suffix` fails, as a full disk
 * or a crash would leave it; later writes go through.
 */
const failingWrite = (files: PrivateFiles, suffix: string, nth = 1): PrivateFiles => {
  let seen = 0;
  return {
    ...files,
    write: (file, contents) =>
      Effect.suspend(() => {
        if (!file.endsWith(suffix) || ++seen !== nth) return files.write(file, contents);
        return Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "writeFile",
            pathOrDescriptor: file,
          }),
        );
      }),
  };
};

describe("provision with a provider connection", () => {
  it.effect("points both harnesses at the endpoint, with the key only in the secret store", () =>
    Effect.gen(function* () {
      const { fs, path, home, files, input, userdata, secrets, settings } = yield* setUp;
      yield* storeConnection({
        home,
        files,
        connection: { baseUrl: "http://127.0.0.1:8317", key: Redacted.make("the-key") },
      });
      const { key: given } = yield* provision(input);
      // The key it gave the harnesses, which their words must not carry.
      assert.strictEqual(given === null ? null : Redacted.value(given), "the-key");

      const variables = (instanceId: string) =>
        Effect.map(settings, (read) =>
          (read.providerInstances[instanceId]?.environment ?? []).map(
            ({ name, value, sensitive }) => ({ name, value, sensitive }),
          ),
        );
      assert.deepStrictEqual(yield* variables("j3-claude"), [
        { name: "ENABLE_TOOL_SEARCH", value: "true", sensitive: false },
        { name: "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", value: "8192", sensitive: false },
        { name: "J3_PROVIDER_KEY", value: "", sensitive: true },
      ]);
      assert.deepStrictEqual(yield* variables("j3-codex"), [
        {
          name: "HOME",
          value: path.join(engineFolders(path, home).codexHomes, "j3-codex"),
          sensitive: false,
        },
        { name: "J3_PROVIDER_KEY", value: "", sensitive: true },
      ]);

      const harness = yield* fs.readFileString(path.join(home, "claude-code", "settings.json"));
      assert.deepStrictEqual(JSON.parse(harness), {
        autoMemoryEnabled: false,
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
        apiKeyHelper: "printenv J3_PROVIDER_KEY",
      });

      const config = yield* fs.readFileString(path.join(home, "codex", "config.toml"));
      assert.include(config, 'developer_instructions = "Say \\"done\\" when done."');
      assert.include(config, 'model_provider = "j3"');
      assert.include(config, 'base_url = "http://127.0.0.1:8317/v1"');
      assert.include(config, 'env_key = "J3_PROVIDER_KEY"');
      // Top-level keys come before the first table, or TOML files them under it.
      assert.isBelow(config.indexOf("model_provider ="), config.indexOf("["));

      // The connection, and one slot per instance.
      const stored = yield* fs.readDirectory(secrets);
      assert.strictEqual(stored.length, 3);
      for (const name of stored) {
        assert.include(yield* fs.readFileString(path.join(secrets, name)), "the-key");
      }
      assert.notInclude(yield* fs.readFileString(path.join(userdata, "settings.json")), "the-key");
      assert.notInclude(harness, "the-key");
      assert.notInclude(config, "the-key");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("keeps one connection's URL and key together when a change is cut short", () =>
    Effect.gen(function* () {
      const { path, home, files, input, claudeConnection, codexConnection } = yield* setUp;
      yield* storeConnection({
        home,
        files,
        connection: { baseUrl: "https://old.example.com", key: Redacted.make("old-key") },
      });
      yield* provision(input);
      const old = { url: "https://old.example.com", key: "old-key" };
      const fresh = { url: "https://new.example.com", key: "new-key" };

      // A store that fails leaves the old connection whole.
      const refused = yield* Effect.exit(
        storeConnection({
          home,
          files: failingWrite(files, "j3-provider-connection.json"),
          connection: { baseUrl: "https://new.example.com", key: Redacted.make("new-key") },
        }),
      );
      assert.isTrue(refused._tag === "Failure");
      yield* provision(input);
      assert.deepStrictEqual(yield* claudeConnection, old);
      assert.deepStrictEqual(yield* codexConnection, old);

      // A provisioning cut short is completed by the next start's.
      yield* storeConnection({
        home,
        files,
        connection: { baseUrl: "https://new.example.com", key: Redacted.make("new-key") },
      });
      const cut = yield* Effect.exit(
        provision({ ...input, files: failingWrite(files, path.join("userdata", "settings.json")) }),
      );
      assert.isTrue(cut._tag === "Failure");
      yield* provision(input);
      assert.deepStrictEqual(yield* claudeConnection, fresh);
      assert.deepStrictEqual(yield* codexConnection, fresh);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("a harness configuration J3 Bots cannot read", () => {
  it.effect("is left as it is with its provider turned off, and the other is provisioned", () =>
    Effect.gen(function* () {
      const { fs, path, files, input, settings, codexConnection } = yield* setUp;
      yield* storeConnection({
        home: input.home,
        files,
        connection: { baseUrl: "https://proxy.example.com", key: Redacted.make("the-key") },
      });
      const claudeSettings = path.join(input.home, "claude-code", "settings.json");
      yield* files.folder(path.join(input.home, "claude-code"));
      yield* files.write(claudeSettings, '{ "model": "opus", ');

      yield* provision(input);
      assert.strictEqual(yield* fs.readFileString(claudeSettings), '{ "model": "opus", ');
      const instances = (yield* settings).providerInstances;
      assert.strictEqual(instances["j3-claude"]?.enabled, false);
      assert.strictEqual(instances["j3-codex"]?.enabled, true);
      assert.deepStrictEqual(yield* codexConnection, {
        url: "https://proxy.example.com",
        key: "the-key",
      });
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("is never taken for an empty one when it cannot be read at all", () =>
    Effect.gen(function* () {
      const { fs, path, files, input, instances, settings } = yield* setUp;
      const configFile = path.join(input.home, "codex", "config.toml");
      yield* files.folder(configFile);

      yield* provision(input);
      assert.strictEqual((yield* settings).providerInstances["j3-codex"]?.enabled, false);
      const prompt = yield* Effect.flip(
        writeBasePrompt({ files, instances, basePrompt: "Ada is your teammate." }),
      );
      assert.strictEqual(prompt._tag, "HarnessConfigUnreadable");
      assert.include(prompt.message, configFile);
      assert.strictEqual((yield* fs.stat(configFile)).type, "Directory");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("a Codex instance", () => {
  /** A `config.toml` with what J3 Bots owns set otherwise, beside a key it does not own. */
  const writeOldConfig = (files: PrivateFiles, configFile: string) =>
    files.write(
      configFile,
      [
        "[shell_environment_policy]",
        'inherit = "core"',
        'set = { HOME = "/old" }',
        "",
        "[features]",
        "shell_snapshot = true",
        "",
      ].join("\n"),
    );

  it.effect(
    "runs in a home of its own, and the commands it runs keep the server user's, in a login shell",
    () =>
      Effect.gen(function* () {
        const { fs, path, files, input, home, settings } = yield* setUp;
        const configFile = path.join(input.home, "codex", "config.toml");
        yield* files.folder(path.join(input.home, "codex"));
        yield* writeOldConfig(files, configFile);

        yield* provision(input);

        const variables = (yield* settings).providerInstances["j3-codex"]?.environment ?? [];
        const own = path.join(engineFolders(path, home).codexHomes, "j3-codex");
        assert.strictEqual(variables.find(({ name }) => name === "HOME")?.value, own);
        assert.deepStrictEqual(yield* fs.readDirectory(own), []);
        const config = parse(yield* fs.readFileString(configFile));
        assert.deepStrictEqual(config["shell_environment_policy"], {
          inherit: "core",
          set: { HOME: "/home/sam" },
        });
        assert.deepStrictEqual(config["features"], {
          shell_snapshot: false,
          mcp_tool_list_changed: true,
        });
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("keeps the server's environment when the server has no home folder", () =>
    Effect.gen(function* () {
      const { fs, path, files, input, home, settings } = yield* setUp;
      const configFile = path.join(input.home, "codex", "config.toml");
      yield* files.folder(path.join(input.home, "codex"));
      yield* writeOldConfig(files, configFile);

      yield* provision({ ...input, userHome: undefined });

      const variables = (yield* settings).providerInstances["j3-codex"]?.environment ?? [];
      assert.isUndefined(variables.find(({ name }) => name === "HOME"));
      assert.isFalse(yield* fs.exists(engineFolders(path, home).codexHomes));
      const config = parse(yield* fs.readFileString(configFile));
      assert.deepStrictEqual(config["shell_environment_policy"], { inherit: "core" });
      assert.deepStrictEqual(config["features"], {
        shell_snapshot: false,
        mcp_tool_list_changed: true,
      });
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("the bridge's tools", () => {
  it.effect(
    "run without asking only by J3 Bots' own names, take the bridge's key, and a call may take as long as the bridge allows",
    () =>
      Effect.gen(function* () {
        const { fs, path, files, input, home, settings, userdata } = yield* setUp;
        const configFile = path.join(input.home, "codex", "config.toml");
        yield* files.folder(path.join(input.home, "codex"));
        // An approval for every tool of the server, as an earlier release wrote it.
        yield* files.write(
          configFile,
          '[mcp_servers.j3]\ncommand = "/old/node"\ndefault_tools_approval_mode = "approve"\n',
        );
        yield* provision(input);

        const claude = (yield* settings).providerInstances["j3-claude"];
        assert.include(
          claude?.config?.launchArgs ?? "",
          "--allowedTools mcp__j3__say,mcp__j3__ask ",
        );
        const state = yield* Schema.decodeEffect(ClaudeState)(
          yield* fs.readFileString(path.join(home, "claude-code", ".claude.json")),
        );
        assert.strictEqual(state.mcpServers.j3?.timeout, 720_000);
        // The bridge's key is in its entry alone: neither harness runs with it, so the
        // commands a bot runs do not inherit it.
        assert.deepStrictEqual(state.mcpServers.j3?.env, { J3_BRIDGE_KEY: "the-bridge-key" });
        assert.notInclude(
          yield* fs.readFileString(path.join(userdata, "settings.json")),
          "the-bridge-key",
        );

        const config = parse(yield* fs.readFileString(configFile));
        assert.deepStrictEqual(config["mcp_servers"], {
          j3: {
            command: "/usr/bin/node",
            args: ["bridge.js"],
            env: { J3_BRIDGE_KEY: "the-bridge-key" },
            tool_timeout_sec: 720,
            tools: { say: { approval_mode: "approve" }, ask: { approval_mode: "approve" } },
          },
        });
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("the harness an instance runs", () => {
  it.effect(
    "is the one J3 Bots installed, by its path, whose own updater stays off; otherwise the one on the PATH",
    () =>
      Effect.gen(function* () {
        const { input, settings } = yield* setUp;
        yield* provision({
          ...input,
          instances: input.instances.map((spec) =>
            spec.kind === "claude-code"
              ? { ...spec, executable: "/j3/harnesses/claude", ownCopy: true }
              : spec,
          ),
        });
        const instances = (yield* settings).providerInstances;
        assert.strictEqual(instances["j3-claude"]?.config?.binaryPath, "/j3/harnesses/claude");
        assert.deepInclude(instances["j3-claude"]?.environment ?? [], {
          name: "DISABLE_AUTOUPDATER",
          value: "1",
          sensitive: false,
        });
        assert.isUndefined(instances["j3-codex"]?.config?.binaryPath);
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("an instance the operator set up", () => {
  it.effect(
    "runs the executable they chose, starts with their arguments after J3 Bots' own, and stays off when turned off",
    () =>
      Effect.gen(function* () {
        const { input, settings } = yield* setUp;
        yield* provision({
          ...input,
          instances: input.instances.map((spec) =>
            spec.kind === "claude-code"
              ? { ...spec, executable: "/opt/claude", launchArguments: " --chrome " }
              : { ...spec, launchArguments: "--search", enabled: false },
          ),
        });
        const instances = (yield* settings).providerInstances;
        const claude = instances["j3-claude"];
        assert.strictEqual(claude?.config?.binaryPath, "/opt/claude");
        assert.match(claude?.config?.launchArgs ?? "", /^--append-system-prompt-file .* --chrome$/);
        assert.notDeepInclude(claude?.environment ?? [], {
          name: "DISABLE_AUTOUPDATER",
          value: "1",
          sensitive: false,
        });
        assert.isTrue(claude?.enabled);
        assert.strictEqual(instances["j3-codex"]?.config?.launchArgs, "--search");
        assert.isFalse(instances["j3-codex"]?.enabled);
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("an instance added while the engine runs", () => {
  it.effect(
    "gets J3 Bots' tools, the connection and its key in its own home, as one provisioned at a start",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, files, input, secrets } = yield* setUp;
        yield* storeConnection({
          home,
          files,
          connection: { baseUrl: "http://127.0.0.1:8317", key: Redacted.make("the-key") },
        });
        yield* provision(input);
        const added: ReadonlyArray<InstanceSpec> = input.instances.map((spec) => ({
          ...spec,
          instanceId: `${spec.instanceId}-work`,
          home: `${spec.home}-work`,
        }));
        for (const spec of added) {
          assert.isTrue(yield* provisionInstance({ ...input, instances: added }, spec));
        }

        const state = yield* Schema.decodeEffect(ClaudeState)(
          yield* fs.readFileString(path.join(home, "claude-code-work", ".claude.json")),
        );
        assert.property(state.mcpServers, "j3");
        const claude = yield* Schema.decodeEffect(ClaudeSettings)(
          yield* fs.readFileString(path.join(home, "claude-code-work", "settings.json")),
        );
        assert.strictEqual(claude.env?.["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8317");
        const config = yield* fs.readFileString(path.join(home, "codex-work", "config.toml"));
        assert.include(config, 'developer_instructions = "Say \\"done\\" when done."');
        assert.include(config, "[mcp_servers.j3]");
        // One key slot more per new instance, beside the two and the connection.
        assert.strictEqual((yield* fs.readDirectory(secrets)).length, 5);
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("a Codex instance's config.toml", () => {
  it.effect("takes J3 Bots' server, its approvals included, into an inline `mcp_servers`", () =>
    Effect.gen(function* () {
      const { fs, path, files, input } = yield* setUp;
      const configFile = path.join(input.home, "codex", "config.toml");
      yield* files.folder(path.join(input.home, "codex"));
      yield* files.write(configFile, 'mcp_servers = { github = { command = "gh" } }\n');
      yield* provision(input);

      const config = parse(yield* fs.readFileString(configFile));
      assert.deepStrictEqual(config["mcp_servers"], {
        github: { command: "gh" },
        j3: {
          command: "/usr/bin/node",
          args: ["bridge.js"],
          env: { J3_BRIDGE_KEY: "the-bridge-key" },
          tool_timeout_sec: 720,
          tools: { say: { approval_mode: "approve" }, ask: { approval_mode: "approve" } },
        },
      });
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("is J3 Bots' only in its own keys and tables; Codex's own settings stay", () =>
    Effect.gen(function* () {
      const { fs, path, files, input, instances } = yield* setUp;
      const configFile = path.join(input.home, "codex", "config.toml");
      yield* files.folder(path.join(input.home, "codex"));
      yield* files.write(
        configFile,
        [
          'model = "gpt-6-luna"',
          'developer_instructions = """',
          "An old prompt",
          'over lines"""',
          "",
          '[projects."/home/sam/bots/ada"]',
          'trust_level = "trusted"',
          "",
          "[mcp_servers.j3]",
          'command = "/old/node"',
          "",
          "[mcp_servers.other]",
          'command = "other"',
          "",
        ].join("\n"),
      );
      yield* provision(input);
      const provisioned = yield* fs.readFileString(configFile);
      assert.include(provisioned, 'model = "gpt-6-luna"');
      assert.include(provisioned, '[projects."/home/sam/bots/ada"]\ntrust_level = "trusted"');
      assert.include(provisioned, '[mcp_servers.other]\ncommand = "other"');
      assert.include(provisioned, 'command = "/usr/bin/node"');
      assert.notInclude(provisioned, "/old/node");
      assert.notInclude(provisioned, "An old prompt");
      assert.notInclude(provisioned, "over lines");
      assert.notInclude(provisioned, "model_provider");

      // A new base prompt changes that key alone.
      yield* writeBasePrompt({ files, instances, basePrompt: "Ada is your teammate." });
      assert.strictEqual(
        yield* fs.readFileString(configFile),
        provisioned.replace(
          'developer_instructions = "Say \\"done\\" when done."',
          'developer_instructions = "Ada is your teammate."',
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

it.effect("lets the Claude Code and Codex homes list the shared skills", () =>
  Effect.gen(function* () {
    const { fs, path, home, input } = yield* setUp;
    const text = "---\nname: j3-routines\ndescription: Routines\n---\n";
    yield* fs.makeDirectory(path.join(input.sharedSkills, "j3-routines"), { recursive: true });
    yield* fs.writeFileString(path.join(input.sharedSkills, "j3-routines", "SKILL.md"), text);

    yield* provision(input);

    for (const harness of ["claude-code", "codex"]) {
      assert.strictEqual(
        yield* fs.readFileString(path.join(home, harness, "skills", "j3-routines", "SKILL.md")),
        text,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(machine)),
);

it.effect(
  "lets a running harness list a shared skill added or removed after the engine started",
  () =>
    Effect.gen(function* () {
      const { fs, path, home, files, instances, input } = yield* setUp;
      yield* fs.makeDirectory(input.sharedSkills, { recursive: true });
      yield* provision(input);
      const text = "---\nname: expenses\ndescription: Filing expenses\n---\n";
      yield* fs.makeDirectory(path.join(input.sharedSkills, "expenses"), { recursive: true });
      yield* fs.writeFileString(path.join(input.sharedSkills, "expenses", "SKILL.md"), text);

      // What the server does once it has saved a shared skill, with no provisioning.
      yield* linkHomeSkills({ home, files, instances, sharedSkills: input.sharedSkills });

      for (const harness of ["claude-code", "codex"]) {
        assert.strictEqual(
          yield* fs.readFileString(path.join(home, harness, "skills", "expenses", "SKILL.md")),
          text,
        );
      }
      yield* fs.remove(path.join(input.sharedSkills, "expenses"), { recursive: true });
      yield* linkHomeSkills({ home, files, instances, sharedSkills: input.sharedSkills });
      for (const harness of ["claude-code", "codex"]) {
        assert.isFalse(yield* fs.exists(path.join(home, harness, "skills", "expenses")));
      }
    }).pipe(Effect.scoped, Effect.provide(machine)),
);

it.effect(
  "lets each harness list a bot's own skills from the folder it reads in the workspace",
  () =>
    Effect.gen(function* () {
      const { fs, path, home, files } = yield* setUp;
      const workspace = path.join(home, "bots", "ada", "workspace");
      const text = "---\nname: invoices\ndescription: Sending invoices\n---\n";
      yield* fs.makeDirectory(path.join(workspace, "skills", "invoices"), { recursive: true });
      yield* fs.writeFileString(path.join(workspace, "skills", "invoices", "SKILL.md"), text);
      // A skill the bot wrote straight into Claude Code's folder stays its own.
      const own = path.join(workspace, ".claude", "skills", "drafts", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(own), { recursive: true });
      yield* fs.writeFileString(own, "the bot's");

      yield* linkProjectSkills({ home, files, workspace, skills: "skills" });

      // Claude Code reads `.claude/skills`, Codex `.agents/skills`.
      for (const folder of [".claude", ".agents"]) {
        assert.strictEqual(
          yield* fs.readFileString(path.join(workspace, folder, "skills", "invoices", "SKILL.md")),
          text,
        );
      }
      yield* fs.remove(path.join(workspace, "skills", "invoices"), { recursive: true });
      yield* linkProjectSkills({ home, files, workspace, skills: "skills" });
      for (const folder of [".claude", ".agents"]) {
        assert.isFalse(yield* fs.exists(path.join(workspace, folder, "skills", "invoices")));
      }
      assert.strictEqual(yield* fs.readFileString(own), "the bot's");
    }).pipe(Effect.scoped, Effect.provide(machine)),
);

// A mode cannot keep writes out of a folder on Windows.
it.effect.skipIf(process.platform === "win32")(
  "provisions a home whose skill folder cannot be written, and keeps its skills",
  () =>
    Effect.gen(function* () {
      const { fs, path, home, input } = yield* setUp;
      yield* fs.makeDirectory(path.join(input.sharedSkills, "j3-routines"), { recursive: true });
      yield* fs.writeFileString(path.join(input.sharedSkills, "j3-routines", "SKILL.md"), "shared");
      const claudeHome = path.join(home, "claude-code");
      const skills = path.join(claudeHome, "skills");
      const own = path.join(skills, "expenses", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(own), { recursive: true });
      yield* fs.writeFileString(own, "the operator's");
      yield* fs.chmod(skills, 0o500);
      yield* Effect.addFinalizer(() => fs.chmod(skills, 0o700).pipe(Effect.ignore));
      logged.length = 0;

      yield* provision(input);

      assert.deepStrictEqual(yield* fs.readDirectory(skills), ["expenses"]);
      assert.strictEqual(yield* fs.readFileString(own), "the operator's");
      assert.isTrue(
        logged.some((line) => line.includes(`could not be linked in ${claudeHome}`)),
        "a warning names the home",
      );
    }).pipe(Effect.scoped, Effect.provide(machine)),
);

describe("suggested replies", () => {
  it.effect("follow the operator's switch, whatever the engine's file said", () =>
    Effect.gen(function* () {
      const { fs, path, input, userdata } = yield* setUp;
      const settingsFile = path.join(userdata, "settings.json");
      const switchOf = Effect.gen(function* () {
        return (yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ promptSuggestionsEnabled: Schema.Boolean })),
        )(yield* fs.readFileString(settingsFile))).promptSuggestionsEnabled;
      });
      yield* fs.makeDirectory(userdata, { recursive: true });
      yield* fs.writeFileString(settingsFile, JSON.stringify({ promptSuggestionsEnabled: true }));

      yield* provision({ ...input, suggestReplies: false });
      assert.isFalse(yield* switchOf);
      yield* provision({ ...input, suggestReplies: true });
      assert.isTrue(yield* switchOf);
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("the engine's browser", () => {
  it.effect("is off for every bot, and stays on for a bot the operator turned it on for", () =>
    Effect.gen(function* () {
      const { fs, path, input, userdata } = yield* setUp;
      const settingsFile = path.join(userdata, "settings.json");
      yield* fs.makeDirectory(userdata, { recursive: true });
      yield* fs.writeFileString(
        settingsFile,
        JSON.stringify({
          enableAgentBrowserAccess: true,
          projectSettingsOverrides: { "bot-project": { enableAgentBrowserAccess: true } },
        }),
      );

      yield* provision(input);

      const written = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            enableAgentBrowserAccess: Schema.Boolean,
            projectSettingsOverrides: Schema.Record(
              Schema.String,
              Schema.Struct({ enableAgentBrowserAccess: Schema.Boolean }),
            ),
          }),
        ),
      )(yield* fs.readFileString(settingsFile));
      assert.isFalse(written.enableAgentBrowserAccess);
      assert.deepStrictEqual(written.projectSettingsOverrides, {
        "bot-project": { enableAgentBrowserAccess: true },
      });
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
