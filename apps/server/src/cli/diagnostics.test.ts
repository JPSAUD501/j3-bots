// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import { unzipSync } from "fflate";
import * as AdminClient from "../admin/AdminClient.ts";
import { ServerConfig } from "../config.ts";
import { DIAGNOSTICS_FILES } from "../diagnostics/build.ts";
import * as TestDatabase from "../testing/database.ts";
import { diagnosticsCommand } from "./diagnostics.ts";

const Manifest = Schema.Struct({
  requestedFrom: Schema.Struct({ surface: Schema.String }),
  running: Schema.Boolean,
});
const decodeManifest = Schema.decodeSync(Schema.fromJsonString(Manifest));

it.layer(TestDatabase.layer)("j3-bots diagnostics", (it) => {
  it.effect("writes the zip of a stopped server, and never over anything already at its name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home } = yield* ServerConfig;
      const out = path.join(home, "support.zip");
      // This home, and a user with no service installed.
      const run = (args: ReadonlyArray<string>) =>
        Command.runWith(diagnosticsCommand, { version: "0.14.0" })(args).pipe(
          Effect.provide(
            Layer.merge(
              AdminClient.layer,
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home, J3_HOME: home })),
            ),
          ),
        );

      yield* run(["--out", out]);
      const files = unzipSync(yield* fs.readFile(out));
      assert.deepStrictEqual(Object.keys(files), [...DIAGNOSTICS_FILES]);
      assert.deepStrictEqual(decodeManifest(new TextDecoder().decode(files["manifest.json"])), {
        requestedFrom: { surface: "j3-bots diagnostics" },
        running: false,
      });

      yield* fs.writeFileString(out, "kept");
      const again = yield* Effect.result(run(["--out", out]));
      assert.strictEqual(again._tag, "Failure");
      assert.strictEqual(yield* fs.readFileString(out), "kept");

      // A link to a drive not mounted now: refused, and the link left as it is.
      if (process.platform !== "win32") {
        const link = path.join(home, "to-a-drive.zip");
        yield* fs.symlink(path.join(home, "not-mounted", "support.zip"), link);
        const onLink = yield* Effect.result(run(["--out", link]));
        assert.strictEqual(onLink._tag, "Failure");
        assert.strictEqual(yield* fs.readLink(link), path.join(home, "not-mounted", "support.zip"));
      }
    }),
  );
});
