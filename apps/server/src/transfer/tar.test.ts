// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the test takes an archive apart with node:zlib, as only a hostile writer would.
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { measureFile, type TarEntry, unpack, writeTarGz } from "./tar.ts";

const AT = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-01T00:00:00Z"));
const text = (value: string) => new TextEncoder().encode(value);

it.effect("keeps names longer than a tar header holds, and files of any size, whole", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped();
    const long = `bots/bot_000000000000000001/files/${"a-folder-with-a-long-name/".repeat(8)}notes.md`;
    const source = path.join(folder, "large.bin");
    const large = new Uint8Array(3 * 1024 * 1024 + 7).map((_, index) => index % 251);
    yield* fs.writeFile(source, large);
    const entries: ReadonlyArray<TarEntry> = [
      { _tag: "bytes", name: "manifest.json", bytes: text("{}") },
      { _tag: "bytes", name: long, bytes: text("The blue door.\n") },
      { _tag: "bytes", name: "attachments/empty", bytes: new Uint8Array() },
      { _tag: "disk", name: "attachments/large", source, ...(yield* measureFile(source)) },
    ];
    const file = path.join(folder, "archive.tar.gz");
    yield* writeTarGz(file, entries, AT);

    const out = path.join(folder, "out");
    const unpacked = yield* unpack(file, ({ name }) =>
      name === "manifest.json"
        ? { _tag: "memory", limit: 1024 }
        : { _tag: "file", path: path.join(out, ...name.split("/")) },
    );
    assert.deepStrictEqual(
      unpacked.map(({ name, size }) => [name, size]),
      [
        ["manifest.json", 2],
        [long, 15],
        ["attachments/empty", 0],
        ["attachments/large", large.length],
      ],
    );
    assert.strictEqual(
      yield* fs.readFileString(path.join(out, ...long.split("/"))),
      "The blue door.\n",
    );
    assert.deepStrictEqual(yield* fs.readFile(path.join(out, "attachments", "large")), large);
    assert.strictEqual(unpacked[3]?.sha256, (yield* measureFile(source)).sha256);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(process.platform === "win32")("keeps whether a file's owner may run it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped();
    const script = path.join(folder, "run.sh");
    const notes = path.join(folder, "notes.md");
    yield* fs.writeFileString(script, "#!/bin/sh\necho hello\n");
    yield* fs.chmod(script, 0o755);
    yield* fs.writeFileString(notes, "Notes.\n");
    const file = path.join(folder, "archive.tar.gz");
    yield* writeTarGz(
      file,
      [
        {
          _tag: "disk",
          name: "skills/greet/run.sh",
          source: script,
          ...(yield* measureFile(script)),
        },
        {
          _tag: "disk",
          name: "skills/greet/notes.md",
          source: notes,
          ...(yield* measureFile(notes)),
        },
      ],
      AT,
    );
    const out = path.join(folder, "out");
    yield* unpack(file, ({ name }) => ({ _tag: "file", path: path.join(out, ...name.split("/")) }));
    const modeOf = (name: string) =>
      Effect.map(fs.stat(path.join(out, "skills", "greet", name)), ({ mode }) => mode & 0o777);
    assert.strictEqual(yield* modeOf("run.sh"), 0o700);
    assert.strictEqual(yield* modeOf("notes.md"), 0o600);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "writes no archive when a file changed after it was measured, and keeps one already there",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped();
      const source = path.join(folder, "notes.md");
      yield* fs.writeFileString(source, "The blue door.\n");
      const measured = yield* measureFile(source);
      yield* fs.writeFileString(source, "The red door.\n!");
      const file = path.join(folder, "archive.tar.gz");
      const changed = yield* Effect.flip(
        writeTarGz(file, [{ _tag: "disk", name: "notes.md", source, ...measured }], AT),
      );
      assert.strictEqual(changed._tag, "FileChanged");
      assert.isFalse(yield* fs.exists(file));

      yield* fs.writeFileString(file, "already here");
      const refused = yield* Effect.flip(
        writeTarGz(file, [{ _tag: "bytes", name: "notes.md", bytes: text("x") }], AT),
      );
      assert.strictEqual(refused._tag, "ArchiveNotWritten");
      assert.strictEqual(yield* fs.readFileString(file), "already here");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a file with more than one extended header before it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped();
    const long = `shared/memory/${"a-long-name/".repeat(10)}notes.md`;
    const file = path.join(folder, "archive.tar.gz");
    yield* writeTarGz(file, [{ _tag: "bytes", name: long, bytes: text("The blue door.\n") }], AT);
    // The extended header and its one block of records, said twice.
    const tar = NodeZlib.gunzipSync(yield* fs.readFile(file));
    const extended = tar.subarray(0, 1024);
    const hostile = path.join(folder, "hostile.tar.gz");
    yield* fs.writeFile(hostile, NodeZlib.gzipSync(Buffer.concat([extended, tar])));

    const refused = yield* Effect.flip(unpack(hostile, () => ({ _tag: "memory", limit: 1024 })));
    assert.strictEqual(refused._tag, "ArchiveUnreadable");
    assert.include(refused.message, "more than one extended header");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
