// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { workspaceReader } from "./workspaceFile.ts";

/** A workspace, by its real path, and a folder outside it. */
const places = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const outside = yield* fs.makeTempDirectoryScoped();
  return {
    fs,
    path: yield* Path.Path,
    workspace,
    outside,
    readWorkspaceFile: yield* workspaceReader,
  };
});

it.layer(NodeServices.layer)("readWorkspaceFile", (it) => {
  // A file far larger than memory could hold: read whole, it could not be refused at all.
  it.effect("refuses a file above the limit, reading no more than the limit", () =>
    Effect.gen(function* () {
      const { fs, path, workspace, readWorkspaceFile } = yield* places;
      const huge = path.join(workspace, "huge.bin");
      yield* fs.writeFileString(huge, "");
      yield* fs.truncate(huge, 64 * 1024 ** 3);
      assert.deepStrictEqual(yield* readWorkspaceFile(workspace, "huge.bin", 1024 * 1024), {
        _tag: "too-large",
      });

      const fits = path.join(workspace, "fits.txt");
      yield* fs.writeFileString(fits, "x".repeat(1024));
      const read = yield* readWorkspaceFile(workspace, "fits.txt", 1024);
      assert.strictEqual(read._tag === "read" ? read.bytes.length : read._tag, 1024);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a link that leads out of the workspace, and follows one that stays in", () =>
    Effect.gen(function* () {
      const { fs, path, workspace, outside, readWorkspaceFile } = yield* places;
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret");
      yield* fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "notes.txt"));
      assert.deepStrictEqual(yield* readWorkspaceFile(workspace, "notes.txt", 1024), {
        _tag: "outside",
      });
      yield* fs.symlink(outside, path.join(workspace, "files"));
      assert.deepStrictEqual(yield* readWorkspaceFile(workspace, "files/secret.txt", 1024), {
        _tag: "outside",
      });

      yield* fs.writeFileString(path.join(workspace, "plan.md"), "The plan.");
      yield* fs.symlink(path.join(workspace, "plan.md"), path.join(workspace, "latest.md"));
      const read = yield* readWorkspaceFile(workspace, "latest.md", 1024);
      assert.strictEqual(read._tag === "read" ? read.name : read._tag, "plan.md");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses what is not a regular file", () =>
    Effect.gen(function* () {
      const { fs, path, workspace, readWorkspaceFile } = yield* places;
      yield* fs.makeDirectory(path.join(workspace, "files"));
      assert.deepStrictEqual(yield* readWorkspaceFile(workspace, "files", 1024), {
        _tag: "not-a-file",
      });
    }).pipe(Effect.scoped),
  );
});
