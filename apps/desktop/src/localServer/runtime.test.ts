// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Runtime from "./runtime.ts";

/** A folder for the package's runtime and one for the copies, in a fresh directory. */
const folders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-runtime-" });
  return {
    source: path.join(root, "package"),
    folder: path.join(root, "userData", "server-runtime"),
  };
});

/** Lays out a runtime of `version` at `source`, as the package carries it. */
const packaged = (source: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(source, { recursive: true, force: true });
    yield* fs.makeDirectory(path.join(source, "node", "bin"), { recursive: true });
    yield* fs.makeDirectory(path.join(source, "server"), { recursive: true });
    yield* fs.writeFileString(path.join(source, "node", "bin", "node"), `node for ${version}`);
    yield* fs.writeFileString(path.join(source, "node", "node.exe"), `node.exe for ${version}`);
    yield* fs.writeFileString(path.join(source, "server", "bin.mjs"), `server ${version}`);
    yield* fs.writeFileString(
      path.join(source, "release.json"),
      JSON.stringify({ version, engine: "t3-0.0.27", target: "linux-x64" }),
    );
  });

const listed = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(folder)).sort();
  });

describe("putting the server runtime in place", () => {
  it.effect("copies it out of the package, under its version, and runs it from there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, folder } = yield* folders;
      yield* packaged(source, "0.3.0");
      const release = yield* Runtime.install({ source, folder });
      assert.deepStrictEqual(release, { version: "0.3.0", engine: "t3-0.0.27" });
      const runtime = yield* Runtime.ready({ folder, version: "0.3.0", platform: "linux" });
      assert.strictEqual(runtime.node, path.join(folder, "0.3.0", "node", "bin", "node"));
      assert.strictEqual(runtime.entry, path.join(folder, "0.3.0", "server", "bin.mjs"));
      assert.strictEqual(yield* fs.readFileString(runtime.node), "node for 0.3.0");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps every version it copied until told which to keep", () =>
    Effect.gen(function* () {
      const { source, folder } = yield* folders;
      for (const version of ["0.3.0", "0.3.1", "0.3.2"]) {
        yield* packaged(source, version);
        yield* Runtime.install({ source, folder });
      }
      assert.deepStrictEqual((yield* Runtime.kept(folder)).sort(), ["0.3.0", "0.3.1", "0.3.2"]);
      yield* Runtime.prune(folder, ["0.3.0", "0.3.2"]);
      assert.deepStrictEqual(yield* listed(folder), ["0.3.0", "0.3.2"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("copies again a version whose copy was cut short, and never runs one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, folder } = yield* folders;
      // An earlier copy, killed before it was whole: no `.complete`, no server.
      yield* fs.makeDirectory(path.join(folder, "0.3.0", "node", "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(folder, "0.3.0", "node", "bin", "node"), "half");
      yield* fs.makeDirectory(path.join(folder, ".0.2.9.partial"), { recursive: true });
      assert.deepStrictEqual(yield* Runtime.kept(folder), []);
      const cutShort = yield* Effect.flip(
        Runtime.ready({ folder, version: "0.3.0", platform: "linux" }),
      );
      assert.strictEqual(cutShort.reason, "not-kept");

      yield* packaged(source, "0.3.0");
      yield* Runtime.install({ source, folder });
      const runtime = yield* Runtime.ready({ folder, version: "0.3.0", platform: "linux" });
      assert.strictEqual(yield* fs.readFileString(runtime.node), "node for 0.3.0");
      assert.strictEqual(yield* fs.readFileString(runtime.entry), "server 0.3.0");
      assert.deepStrictEqual(yield* listed(folder), ["0.3.0"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a package that carries no runtime, or a damaged one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, folder } = yield* folders;
      const missing = yield* Effect.flip(Runtime.install({ source, folder }));
      assert.strictEqual(missing.reason, "missing");
      yield* packaged(source, "0.3.0");
      yield* fs.writeFileString(path.join(source, "release.json"), '{"version": "../../etc"}');
      const damaged = yield* Effect.flip(Runtime.install({ source, folder }));
      assert.strictEqual(damaged.reason, "damaged");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the runtime on Windows", () => {
  it.effect("runs from a stable `current` folder, swapped by rename when the version changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, folder } = yield* folders;
      for (const version of ["0.3.0", "0.3.1"]) {
        yield* packaged(source, version);
        yield* Runtime.install({ source, folder });
      }
      const newer = yield* Runtime.ready({ folder, version: "0.3.1", platform: "win32" });
      assert.strictEqual(newer.node, path.join(folder, "current", "node", "node.exe"));
      assert.strictEqual(yield* fs.readFileString(newer.node), "node.exe for 0.3.1");

      // A rollback runs the older version from the same path.
      const older = yield* Runtime.ready({ folder, version: "0.3.0", platform: "win32" });
      assert.strictEqual(older.node, newer.node);
      assert.strictEqual(older.version, "0.3.0");
      assert.strictEqual(yield* fs.readFileString(older.node), "node.exe for 0.3.0");
      assert.deepStrictEqual(yield* listed(folder), ["0.3.0", "0.3.1", "current"]);
      assert.deepStrictEqual((yield* Runtime.kept(folder)).sort(), ["0.3.0", "0.3.1"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
