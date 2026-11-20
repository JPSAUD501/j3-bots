// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as PlatformError from "effect/PlatformError";
import { engineFolders, makePrivateFiles, type PrivateFiles } from "./PrivateFiles.ts";
import { type InstanceSpec, provision, storeConnection, writeBasePrompt } from "./Provision.ts";
import { tomlString } from "./toml.ts";

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
  /** The connection the engine would hand Claude Code: its URL and its key. */
  const claudeConnection = Effect.gen(function* () {
    const environment = (yield* settings).providerInstances["j3-claude"]?.environment ?? [];
    const keyFile = (yield* fs.readDirectory(secrets)).find((name) =>
      name.startsWith("provider-env-"),
    );
    return {
      url: environment.find((variable) => variable.name === "ANTHROPIC_BASE_URL")?.value,
      key:
        keyFile === undefined ? undefined : yield* fs.readFileString(path.join(secrets, keyFile)),
    };
  });
  return { fs, path, home, files, instances, input, userdata, secrets, settings, claudeConnection };
});

/** Files whose write of the connection's record fails, as a full disk or a crash would leave it. */
const failingRecord = (files: PrivateFiles): PrivateFiles => ({
  ...files,
  write: (file, contents) =>
    file.endsWith("provider-connection.json")
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "writeFile",
            pathOrDescriptor: file,
          }),
        )
      : files.write(file, contents),
});

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
      assert.deepStrictEqual(yield* variables("j3-claude"), [
        { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true },
        { name: "ENABLE_TOOL_SEARCH", value: "false", sensitive: false },
      ]);
      assert.deepStrictEqual(yield* variables("j3-codex"), [
        { name: "J3_PROVIDER_KEY", value: "", sensitive: true },
      ]);

      const config = yield* fs.readFileString(path.join(home, "codex", "config.toml"));
      assert.include(config, 'developer_instructions = "Say \\"done\\" when done."');
      assert.include(config, 'model_provider = "j3"');
      assert.include(config, 'base_url = "http://127.0.0.1:8317/v1"');
      assert.include(config, 'env_key = "J3_PROVIDER_KEY"');
      // Top-level keys come before the first table, or TOML files them under it.
      assert.isBelow(config.indexOf("model_provider ="), config.indexOf("["));

      // One slot per instance, and the committed generation's staged key.
      const stored = yield* fs.readDirectory(secrets);
      assert.strictEqual(stored.length, 3);
      for (const name of stored) {
        assert.strictEqual(yield* fs.readFileString(path.join(secrets, name)), "the-key");
      }
      assert.notInclude(yield* fs.readFileString(path.join(userdata, "settings.json")), "the-key");
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
          files: failingRecord(files),
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
});

describe("tomlString", () => {
  it("escapes what TOML would read otherwise, and makes lone surrogates whole", () => {
    assert.strictEqual(tomlString('a "b"\n\\c\u007f'), '"a \\"b\\"\\n\\\\c\\u007f"');
    assert.strictEqual(tomlString("\ud800"), '"�"');
  });
});
