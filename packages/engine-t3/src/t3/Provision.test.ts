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
import { engineFolders, makePrivateFiles } from "./PrivateFiles.ts";
import { type InstanceSpec, provision, storeConnection, tomlString } from "./Provision.ts";

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

describe("provision with a provider connection", () => {
  it.effect("points both harnesses at the endpoint, with the key only in the secret store", () =>
    Effect.gen(function* () {
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
      yield* storeConnection({
        home,
        files,
        instances,
        connection: { baseUrl: "http://127.0.0.1:8317", key: Redacted.make("the-key") },
      });
      yield* provision(input);

      const { userdata, secrets } = engineFolders(path, home);
      const settings = yield* Schema.decodeEffect(Settings)(
        yield* fs.readFileString(path.join(userdata, "settings.json")),
      );
      const variables = (instanceId: string) =>
        (settings.providerInstances[instanceId]?.environment ?? []).map(
          ({ name, value, sensitive }) => ({ name, value, sensitive }),
        );
      assert.deepStrictEqual(variables("j3-claude"), [
        { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true },
        { name: "ENABLE_TOOL_SEARCH", value: "false", sensitive: false },
      ]);
      assert.deepStrictEqual(variables("j3-codex"), [
        { name: "J3_PROVIDER_KEY", value: "", sensitive: true },
      ]);

      const config = yield* fs.readFileString(path.join(home, "codex", "config.toml"));
      assert.include(config, 'developer_instructions = "Say \\"done\\" when done."');
      assert.include(config, 'model_provider = "j3"');
      assert.include(config, 'base_url = "http://127.0.0.1:8317/v1"');
      assert.include(config, 'env_key = "J3_PROVIDER_KEY"');
      // Top-level keys come before the first table, or TOML files them under it.
      assert.isBelow(config.indexOf("model_provider ="), config.indexOf("["));

      const stored = yield* fs.readDirectory(secrets);
      assert.strictEqual(stored.length, 2);
      for (const name of stored) {
        assert.strictEqual(yield* fs.readFileString(path.join(secrets, name)), "the-key");
      }
      assert.notInclude(yield* fs.readFileString(path.join(userdata, "settings.json")), "the-key");
      assert.notInclude(config, "the-key");
    }).pipe(Effect.scoped, Effect.provide(machine)),
  );
});

describe("tomlString", () => {
  it("escapes what TOML would read otherwise, and makes lone surrogates whole", () => {
    assert.strictEqual(tomlString('a "b"\n\\c\u007f'), '"a \\"b\\"\\n\\\\c\\u007f"');
    assert.strictEqual(tomlString("\ud800"), '"�"');
  });
});
