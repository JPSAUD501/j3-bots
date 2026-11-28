// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the archives are written byte by byte, with zlib's CRC-32, as a zip tool would.
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { unzip } from "./unzip.ts";

/** An entry of a test archive: a file, or a link to `to`, with Unix permissions. */
type TestEntry =
  | { readonly name: string; readonly text: string; readonly executable?: boolean }
  | { readonly name: string; readonly linkTo: string };

const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** A zip of `entries`, stored without compression, made on a Unix host. */
const zipOf = (entries: ReadonlyArray<TestEntry>): Uint8Array => {
  const locals: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from("text" in entry ? entry.text : entry.linkTo, "utf8");
    const mode =
      "linkTo" in entry ? S_IFLNK | 0o777 : S_IFREG | (entry.executable === true ? 0o755 : 0o644);
    const crc = NodeZlib.crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
};

/** Unpacks a zip of `entries` into a fresh folder, inside a fresh parent: the folder and the parent. */
const unpack = (entries: ReadonlyArray<TestEntry>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "j3-unzip-test-" });
    const archive = path.join(parent, "chrome.zip");
    const into = path.join(parent, "into");
    yield* fs.makeDirectory(into);
    yield* fs.writeFile(archive, zipOf(entries));
    const result = yield* unzip(archive, into).pipe(Effect.result);
    return { result, into, parent };
  });

it.effect("unpacks files and folders", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { result, into } = yield* unpack([
      { name: "chrome-linux64/chrome", text: "binary" },
      { name: "chrome-linux64/resources/locale.pak", text: "pak" },
    ]);
    assert.strictEqual(result._tag, "Success");
    assert.strictEqual(
      yield* fs.readFileString(path.join(into, "chrome-linux64/chrome")),
      "binary",
    );
    assert.strictEqual(
      yield* fs.readFileString(path.join(into, "chrome-linux64/resources/locale.pak")),
      "pak",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses an entry that leads out of the folder, and writes nothing outside", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const climbing = yield* unpack([{ name: "../escaped", text: "out" }]);
    assert.strictEqual(climbing.result._tag, "Failure");
    assert.isFalse(yield* fs.exists(path.join(climbing.parent, "escaped")));

    const absolute = yield* unpack([{ name: "/tmp/j3-unzip-absolute", text: "out" }]);
    assert.strictEqual(absolute.result._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Permission bits and links, as the Linux and macOS archives carry them.
// Windows keeps neither, and its archive has none.
describe.skipIf(process.platform === "win32")("on Unix", () => {
  it.effect("keeps a file executable, and a link that stays inside the folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { result, into } = yield* unpack([
        { name: "chrome-linux64/chrome", text: "binary", executable: true },
        { name: "chrome-linux64/resources/locale.pak", text: "pak" },
        { name: "chrome-linux64/current", linkTo: "resources/locale.pak" },
      ]);
      assert.strictEqual(result._tag, "Success");
      const chrome = path.join(into, "chrome-linux64/chrome");
      assert.strictEqual(((yield* fs.stat(chrome)).mode & 0o111) !== 0, true);
      assert.strictEqual(
        yield* fs.readLink(path.join(into, "chrome-linux64/current")),
        "resources/locale.pak",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a link that leads out of the folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const linking = yield* unpack([{ name: "chrome-linux64/out", linkTo: "../../escaped" }]);
      assert.strictEqual(linking.result._tag, "Failure");
      assert.isFalse(yield* fs.exists(path.join(linking.into, "chrome-linux64/out")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
