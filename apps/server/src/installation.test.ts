// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { locate, RELEASE_MANIFEST } from "./installation.ts";

const MANIFEST = { version: "0.1.0", platform: "linux-arm64", node: "26.13.1" };

/** A temporary folder, links resolved, and a way to name files under it. */
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  /** `locate` as the module at `parts` under the folder would call it. */
  const locateFrom = (...parts: ReadonlyArray<string>) =>
    path.toFileUrl(at(...parts)).pipe(Effect.orDie, Effect.flatMap(locate));
  return { fs, at, locateFrom };
});

it.layer(NodeServices.layer)("where J3 Bots finds its own files", (it) => {
  it.effect("in a release archive, beside the bundle", () =>
    Effect.gen(function* () {
      const { fs, at, locateFrom } = yield* scratch;
      yield* fs.makeDirectory(at("server"));
      yield* fs.writeFileString(at(RELEASE_MANIFEST), JSON.stringify(MANIFEST));

      const found = yield* locateFrom("server", "bin.mjs");

      assert.deepStrictEqual(found, {
        layout: { _tag: "release", root: at(), manifest: MANIFEST },
        entryPoint: at("server", "bin.mjs"),
        bridgeEntryPoint: at("server", "bridge.mjs"),
        webClient: at("web"),
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "in a checkout, the web client built beside the server, from the bundle or the source",
    () =>
      Effect.gen(function* () {
        const { fs, at, locateFrom } = yield* scratch;
        yield* fs.makeDirectory(at("apps", "server", "dist"), { recursive: true });

        assert.deepStrictEqual(yield* locateFrom("apps", "server", "dist", "bin.mjs"), {
          layout: { _tag: "checkout" },
          entryPoint: at("apps", "server", "dist", "bin.mjs"),
          bridgeEntryPoint: at("apps", "server", "dist", "bridge.mjs"),
          webClient: at("apps", "web", "dist"),
        });
        assert.deepStrictEqual(yield* locateFrom("apps", "server", "src", "installation.ts"), {
          layout: { _tag: "checkout" },
          entryPoint: at("apps", "server", "src", "bin.ts"),
          bridgeEntryPoint: at("apps", "server", "src", "bridge", "main.ts"),
          webClient: at("apps", "web", "dist"),
        });
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a release whose manifest it cannot read, rather than run as a checkout", () =>
    Effect.gen(function* () {
      const { fs, at, locateFrom } = yield* scratch;
      yield* fs.makeDirectory(at("server"));
      yield* fs.writeFileString(at(RELEASE_MANIFEST), JSON.stringify({ version: "0.1.0" }));

      const exit = yield* Effect.exit(locateFrom("server", "bin.mjs"));

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.deepInclude(Cause.squash(exit.cause), {
          _tag: "ReleaseDamaged",
          manifest: at(RELEASE_MANIFEST),
        });
      }
    }).pipe(Effect.scoped),
  );
});
