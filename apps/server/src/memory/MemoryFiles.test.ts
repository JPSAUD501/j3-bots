// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { BotId, MemoryPath } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Layout from "../Layout.ts";
import * as TestDatabase from "../testing/database.ts";
import * as MemoryFiles from "./MemoryFiles.ts";

const files = MemoryFiles.layer.pipe(
  Layer.provideMerge(Layout.layer),
  Layer.provideMerge(TestDatabase.layer),
);

const shared = { _tag: "shared" } as const;

/** A folder outside the memory, and a link inside the memory that points to it. */
const linkOutside = (name: string, target: "folder" | "nowhere") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { sharedMemory } = yield* Layout.Layout;
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(sharedMemory, { recursive: true });
    const pointed = target === "folder" ? outside : path.join(outside, "missing");
    yield* fs.symlink(pointed, path.join(sharedMemory, name));
    return outside;
  });

it.effect("refuses to read or write through a link that leaves the memory folder", () =>
  Effect.gen(function* () {
    const memory = yield* MemoryFiles.MemoryFiles;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The memory folder is in place; the log folder inside it leads out of the home.
    const outside = yield* linkOutside("log", "folder");
    yield* fs.writeFileString(path.join(outside, "secret.md"), "outside");

    const read = yield* memory.read(shared, MemoryPath.make("log/secret.md")).pipe(Effect.exit);
    const write = yield* memory
      .write({ scope: shared, path: MemoryPath.make("log/new.md"), text: "x", revision: null })
      .pipe(Effect.exit);
    const appended = yield* memory
      .modify(shared, MemoryPath.make("log/2026-11.md"), () => [undefined, Option.some("x")])
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(read));
    // Refused as private state leaving the home, as a link of the folder itself is.
    for (const exit of [write, appended]) {
      assert.deepInclude(Option.getOrUndefined(Exit.findErrorOption(exit)), {
        _tag: "Conflict",
        reason: "private-location",
      });
    }
    assert.deepStrictEqual(yield* fs.readDirectory(outside), ["secret.md"]);
  }).pipe(Effect.scoped, Effect.provide(files)),
);

it.effect("refuses to write through a link to a place that does not exist yet", () =>
  Effect.gen(function* () {
    const memory = yield* MemoryFiles.MemoryFiles;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outside = yield* linkOutside("dangling", "nowhere");

    const write = yield* memory
      .write({ scope: shared, path: MemoryPath.make("dangling/new.md"), text: "x", revision: null })
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(write));
    assert.isFalse(yield* fs.exists(path.join(outside, "missing")));
  }).pipe(Effect.scoped, Effect.provide(files)),
);

it.effect("writes only over the revision the writer read", () =>
  Effect.gen(function* () {
    const memory = yield* MemoryFiles.MemoryFiles;
    const path = MemoryPath.make("notes/today.md");
    const first = yield* memory.write({ scope: shared, path, text: "one", revision: null });
    yield* memory.write({ scope: shared, path, text: "two", revision: first.revision });

    const stale = yield* memory
      .write({ scope: shared, path, text: "three", revision: first.revision })
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(stale));
    const current = yield* memory.read(shared, path);
    assert.strictEqual(Option.getOrThrow(current).text, "two");
    // Private state: only this user may open it, whatever the umask.
    const { sharedMemory } = yield* Layout.Layout;
    const info = yield* (yield* FileSystem.FileSystem).stat(`${sharedMemory}/${path}`);
    assert.strictEqual(info.mode & 0o777, 0o600);
  }).pipe(Effect.provide(files)),
);

it.effect(
  "never writes memory into the web client's folder through a link made while it runs",
  () =>
    Effect.gen(function* () {
      const memory = yield* MemoryFiles.MemoryFiles;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* Layout.Layout;
      const { webClient } = yield* ServerConfig;
      const botId = BotId.make("b1");
      const scopes = [
        { scope: shared, folder: layout.sharedMemory },
        { scope: { _tag: "bot", botId } as const, folder: layout.botMemory(botId) },
      ];
      for (const [index, { scope, folder }] of scopes.entries()) {
        const published = path.join(webClient.directory, `memory-${index}`);
        yield* fs.makeDirectory(published, { recursive: true });
        yield* fs.makeDirectory(path.dirname(folder), { recursive: true });
        yield* fs.symlink(published, folder);

        const write = yield* memory
          .write({ scope, path: MemoryPath.make("user.md"), text: "private", revision: null })
          .pipe(Effect.exit);
        const appended = yield* memory
          .modify(scope, MemoryPath.make("log/2026-11.md"), () => [undefined, Option.some("x")])
          .pipe(Effect.exit);

        // Refused with a reason a client can show, not as a malformed path.
        for (const exit of [write, appended]) {
          assert.deepInclude(Option.getOrUndefined(Exit.findErrorOption(exit)), {
            _tag: "Conflict",
            reason: "private-location",
          });
        }
        assert.deepStrictEqual(yield* fs.readDirectory(published), []);
      }
    }).pipe(Effect.provide(files)),
);
