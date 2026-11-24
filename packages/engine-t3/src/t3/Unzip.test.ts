// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { makeZip, type TestZipEntry } from "./testZip.ts";
import { extractZip, isSafeEntryName } from "./Unzip.ts";

/** Writes a zip of `entries`, unpacks it into a new folder, and answers the folder and why it failed, if it did. */
const unpack = (
  entries: ReadonlyArray<TestZipEntry>,
  into: (scratch: string) => string = (scratch) => scratch,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratch = yield* fs.makeTempDirectoryScoped();
    const archive = path.join(scratch, "archive.zip");
    yield* fs.writeFile(archive, makeZip(entries));
    const folder = path.join(into(scratch), "unpacked");
    yield* fs.makeDirectory(folder, { recursive: true });
    const exit = yield* extractZip(archive, folder).pipe(Effect.exit);
    const reason = Exit.isFailure(exit)
      ? Option.getOrUndefined(Exit.findErrorOption(exit))?.reason
      : undefined;
    return { scratch, folder, reason };
  });

/** Every file under `folder`, by its path from there with `/` between segments, and what it holds. */
const contents = Effect.fn("contents")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Record<string, string> = {};
  for (const relative of yield* fs.readDirectory(folder, { recursive: true })) {
    const location = path.join(folder, relative);
    if ((yield* fs.stat(location)).type === "File") {
      found[relative.split(path.sep).join("/")] = yield* fs.readFileString(location);
    }
  }
  return found;
});

describe("extractZip", () => {
  it.effect("unpacks stored and deflated files, making the folders the archive leaves out", () =>
    Effect.gen(function* () {
      const { folder, reason } = yield* unpack([
        { name: "t3-0.1.11-win32-x64/" },
        { name: "t3-0.1.11-win32-x64/t3.exe", data: "the engine", method: "deflated" },
        { name: "t3-0.1.11-win32-x64/client/index.html", data: "<!doctype html>" },
        { name: "t3-0.1.11-win32-x64/node_modules/a/b/empty.txt", data: "", method: "deflated" },
        { name: "t3-0.1.11-win32-x64/notes – ünïcode.txt", data: "ok" },
      ]);
      assert.isUndefined(reason);
      assert.deepStrictEqual(yield* contents(folder), {
        "t3-0.1.11-win32-x64/t3.exe": "the engine",
        "t3-0.1.11-win32-x64/client/index.html": "<!doctype html>",
        "t3-0.1.11-win32-x64/node_modules/a/b/empty.txt": "",
        "t3-0.1.11-win32-x64/notes – ünïcode.txt": "ok",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("unpacks into a folder whose paths pass Windows' old 260-character limit", () =>
    Effect.gen(function* () {
      const deep = (scratch: string) =>
        [scratch, ...Array.from({ length: 6 }, (_, i) => `${i}`.repeat(40))].join("/");
      const name = `t3/${"node_modules/".repeat(4)}package/${"x".repeat(60)}.js`;
      const { folder, reason } = yield* unpack(
        [{ name, data: "module", method: "deflated" }],
        deep,
      );
      assert.isAbove(folder.length + name.length, 260);
      assert.isUndefined(reason);
      assert.deepStrictEqual(yield* contents(folder), { [name]: "module" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an entry that leads out of the folder, and writes nothing out of it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { scratch, reason } = yield* unpack([
        { name: "t3/ok.txt", data: "fine" },
        { name: "t3/../../escaped.txt", data: "out" },
      ]);
      assert.strictEqual(reason, "unsafe-name");
      assert.isFalse(yield* fs.exists(path.join(scratch, "escaped.txt")));
      assert.isFalse(yield* fs.exists(path.join(path.dirname(scratch), "escaped.txt")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a link, rather than unpack it as a file", () =>
    Effect.gen(function* () {
      const { folder, reason } = yield* unpack([
        { name: "t3/link", data: "/etc/passwd", unixMode: 0o120777 },
      ]);
      assert.strictEqual(reason, "unsupported");
      assert.deepStrictEqual(yield* contents(folder), {});
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an entry whose bytes do not match its CRC-32", () =>
    Effect.gen(function* () {
      const { reason } = yield* unpack([
        { name: "t3/t3.exe", data: "the engine", method: "deflated", crc32: 1234 },
      ]);
      assert.strictEqual(reason, "corrupt");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses two files whose names Windows would take for one", () =>
    Effect.gen(function* () {
      const { reason } = yield* unpack([
        { name: "t3/README.md", data: "first" },
        { name: "t3/readme.md", data: "second" },
      ]);
      assert.strictEqual(reason, "corrupt");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses what is not a zip", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratch = yield* fs.makeTempDirectoryScoped();
      const archive = path.join(scratch, "archive.zip");
      yield* fs.writeFileString(archive, "a gzipped tar, say, and not a zip at all".repeat(4));
      const exit = yield* extractZip(archive, scratch).pipe(Effect.exit);
      assert.strictEqual(
        Exit.isFailure(exit)
          ? Option.getOrUndefined(Exit.findErrorOption(exit))?.reason
          : undefined,
        "not-a-zip",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("isSafeEntryName", () => {
  it("takes plain relative paths, and folders by their trailing slash", () => {
    for (const name of ["t3.exe", "t3/client/index.html", "t3/client/", "a/.hidden", "a/b c/d"]) {
      assert.isTrue(isSafeEntryName(name), name);
    }
  });

  it("refuses what would lead out, or that Windows would read as another name", () => {
    for (const name of [
      "",
      "/etc/passwd",
      "../up",
      "a/../../up",
      "a/./b",
      "a//b",
      String.raw`a\..\..\up`,
      "C:/Windows/win.ini",
      "c:relative",
      "file.txt:hidden-stream",
      "trailing-dot.",
      "trailing-space ",
      "CON",
      "a/nul.txt",
      "lpt1",
      "tab\there",
      'quote"d',
      "star*",
    ]) {
      assert.isFalse(isSafeEntryName(name), JSON.stringify(name));
    }
  });
});
