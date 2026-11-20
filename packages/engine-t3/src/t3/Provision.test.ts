// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as PlatformError from "effect/PlatformError";
import { engineFolders, makePrivateFiles, type PrivateFiles } from "./PrivateFiles.ts";
import { type InstanceSpec, provision, storeConnection, writeBasePrompt } from "./Provision.ts";

const machine = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto);

const Settings = Schema.fromJsonString(
  Schema.Struct({
    providerInstances: Schema.Record(
      Schema.String,
      Schema.Struct({
        environment: Schema.Array(
          Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
        ),
      }),
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
      environment: [],
    },
    {
      kind: "codex",
      instanceId: "j3-codex",
      name: "Codex",
      home: path.join(home, "codex"),
      environment: [],
    },
  ];
  const input = {
    home,
    files,
    instances,
    toolBridge: { command: "/usr/bin/node", args: ["bridge.js"] },
    systemPromptFile: ".j3/system.md",
    basePrompt: 'Say "done" when done.',
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
      yield* provision(input);

      const variables = (instanceId: string) =>
        Effect.map(settings, (read) =>
          (read.providerInstances[instanceId]?.environment ?? []).map(
            ({ name, value, sensitive }) => ({ name, value, sensitive }),
          ),
        );
      const claude = yield* variables("j3-claude");
      const keyVariable = claude[0]?.name ?? "";
      assert.match(keyVariable, /^J3_PROVIDER_KEY_[0-9a-f]{24}$/);
      assert.deepStrictEqual(claude, [
        { name: keyVariable, value: "", sensitive: true },
        { name: "ENABLE_TOOL_SEARCH", value: "false", sensitive: false },
      ]);
      assert.deepStrictEqual(yield* variables("j3-codex"), [
        { name: keyVariable, value: "", sensitive: true },
      ]);

      const harness = yield* fs.readFileString(path.join(home, "claude-code", "settings.json"));
      assert.deepStrictEqual(JSON.parse(harness), {
        autoMemoryEnabled: false,
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
        apiKeyHelper: `printenv ${keyVariable}`,
      });

      const config = yield* fs.readFileString(path.join(home, "codex", "config.toml"));
      assert.include(config, 'developer_instructions = "Say \\"done\\" when done."');
      assert.include(config, 'model_provider = "j3"');
      assert.include(config, 'base_url = "http://127.0.0.1:8317/v1"');
      assert.include(config, `env_key = "${keyVariable}"`);
      // Top-level keys come before the first table, or TOML files them under it.
      assert.isBelow(config.indexOf("model_provider ="), config.indexOf("["));

      // One slot per instance, and the committed generation's staged key.
      const stored = yield* fs.readDirectory(secrets);
      assert.strictEqual(stored.length, 3);
      for (const name of stored) {
        assert.strictEqual(yield* fs.readFileString(path.join(secrets, name)), "the-key");
      }
      assert.notInclude(yield* fs.readFileString(path.join(userdata, "settings.json")), "the-key");
      assert.notInclude(harness, "the-key");
      assert.notInclude(config, "the-key");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect("keeps the URL and the key of one connection when a change is cut short", () =>
    Effect.gen(function* () {
      const { home, files, input, claudeConnection } = yield* setUp;
      yield* storeConnection({
        home,
        files,
        connection: { baseUrl: "https://old.example.com", key: Redacted.make("old-key") },
      });
      yield* provision(input);

      // The new key is staged, and the record naming it fails to be written:
      // the old connection stays whole, now and after the next start.
      const refused = yield* Effect.exit(
        storeConnection({
          home,
          files: failingWrite(files, "provider-connection.json"),
          connection: { baseUrl: "https://new.example.com", key: Redacted.make("new-key") },
        }),
      );
      assert.isTrue(refused._tag === "Failure");
      assert.deepStrictEqual(yield* claudeConnection, {
        url: "https://old.example.com",
        key: "old-key",
      });
      yield* provision(input);
      assert.deepStrictEqual(yield* claudeConnection, {
        url: "https://old.example.com",
        key: "old-key",
      });

      // Recorded, and stopped before the engine was given it: the next start
      // gives the engine the new URL and the new key together.
      yield* storeConnection({
        home,
        files,
        connection: { baseUrl: "https://new.example.com", key: Redacted.make("new-key") },
      });
      assert.deepStrictEqual(yield* claudeConnection, {
        url: "https://old.example.com",
        key: "old-key",
      });
      yield* provision(input);
      assert.deepStrictEqual(yield* claudeConnection, {
        url: "https://new.example.com",
        key: "new-key",
      });
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );

  it.effect(
    "pairs each URL a harness is given with its own key when provisioning is cut short",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, files, input, secrets, claudeConnection, codexConnection } =
          yield* setUp;
        yield* storeConnection({
          home,
          files,
          connection: { baseUrl: "https://old.example.com", key: Redacted.make("old-key") },
        });
        yield* provision(input);
        yield* storeConnection({
          home,
          files,
          connection: { baseUrl: "https://new.example.com", key: Redacted.make("new-key") },
        });
        const old = { url: "https://old.example.com", key: "old-key" };
        const fresh = { url: "https://new.example.com", key: "new-key" };

        // Cut before Claude Code's settings name the new URL.
        const beforeHarness = yield* Effect.exit(
          provision({ ...input, files: failingWrite(files, "claude-code/settings.json") }),
        );
        assert.isTrue(beforeHarness._tag === "Failure");
        assert.deepStrictEqual(yield* claudeConnection, old);
        assert.deepStrictEqual(yield* codexConnection, old);

        // Cut after both harnesses name the new URL, before the engine's
        // settings stop naming the old key.
        const beforeSettings = yield* Effect.exit(
          provision({ ...input, files: failingWrite(files, "userdata/settings.json", 2) }),
        );
        assert.isTrue(beforeSettings._tag === "Failure");
        assert.deepStrictEqual(yield* claudeConnection, fresh);
        assert.deepStrictEqual(yield* codexConnection, fresh);

        // The next provisioning completes it, and the old key is gone.
        yield* provision(input);
        assert.deepStrictEqual(yield* claudeConnection, fresh);
        assert.deepStrictEqual(yield* codexConnection, fresh);
        for (const name of yield* fs.readDirectory(secrets)) {
          assert.strictEqual(yield* fs.readFileString(path.join(secrets, name)), "new-key");
        }
      }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("a Codex instance's config.toml", () => {
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

  it.effect("is left as it is when it is not TOML, and provisioning says which file", () =>
    Effect.gen(function* () {
      const { fs, path, files, input } = yield* setUp;
      const configFile = path.join(input.home, "codex", "config.toml");
      yield* files.folder(path.join(input.home, "codex"));
      yield* files.write(configFile, 'model = "gpt-6-luna\n');
      const refused = yield* Effect.flip(provision(input));
      assert.strictEqual(refused._tag, "HarnessConfigUnreadable");
      assert.include(refused.message, configFile);
      assert.strictEqual(yield* fs.readFileString(configFile), 'model = "gpt-6-luna\n');
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});
