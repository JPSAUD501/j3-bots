// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Host, layer } from "./Host.ts";

const host = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("findExecutable", () => {
  it.effect.skipIf(process.platform === "win32")(
    "finds a file that may run, and passes over one that may not",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const first = yield* fs.makeTempDirectoryScoped();
        const second = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(first, "claude"), "not to be run", { mode: 0o600 });
        yield* fs.writeFileString(path.join(second, "claude"), "#!/bin/sh\n", { mode: 0o700 });

        const found = yield* (yield* Host).findExecutable("claude", `${first}:${second}`);
        assert.deepStrictEqual(found, Option.some(path.join(second, "claude")));
      }).pipe(Effect.scoped, Effect.provide(host)),
  );

  it.effect.skipIf(process.platform !== "win32")(
    "on Windows, finds what npm installs as a .cmd shim by the name it runs as",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(folder, "claude.cmd"), "@echo off\r\n");

        const lookUp = (yield* Host).findExecutable;
        assert.deepStrictEqual(
          yield* lookUp("claude", folder),
          Option.some(path.join(folder, "claude.cmd")),
        );
        assert.isTrue(Option.isNone(yield* lookUp("codex", folder)));
      }).pipe(Effect.scoped, Effect.provide(host)),
  );
});
