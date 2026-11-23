// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { removeEntry, writeEntry } from "./autostartFile.ts";
import { renderAutostartEntry } from "./desktopEntry.ts";

const execOf = (entry: string) => entry.split("\n").find((line) => line.startsWith("Exec="));

/** An autostart folder that does not exist yet, under a fresh temporary one. */
const autostartFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* fs.makeTempDirectoryScoped();
  return path.join(config, "autostart");
});

describe("the entry that starts the app with the system on Linux", () => {
  it("starts the AppImage, or the deb's executable, hidden in the tray", () => {
    const appImage = renderAutostartEntry({
      name: "J3 Bots",
      command: ["/home/ana/Apps/J3-Bots-x86_64.AppImage", "--hidden"],
    });
    assert.strictEqual(execOf(appImage), "Exec=/home/ana/Apps/J3-Bots-x86_64.AppImage --hidden");
    assert.include(appImage, "Type=Application\n");
    assert.notInclude(appImage, "Hidden=");
    const deb = renderAutostartEntry({
      name: "J3 Bots",
      command: ["/opt/J3 Bots/j3-bots", "--hidden"],
    });
    assert.strictEqual(execOf(deb), 'Exec="/opt/J3 Bots/j3-bots" --hidden');
  });

  it.effect(
    "is written into a folder that did not exist, and written again when the app moved",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* autostartFolder;
        const file = path.join(folder, "j3bots.desktop");
        const before = renderAutostartEntry({
          name: "J3 Bots",
          command: ["/a/J3.AppImage", "--hidden"],
        });
        yield* writeEntry(file, before);
        assert.strictEqual(yield* fs.readFileString(file), before);
        const moved = renderAutostartEntry({
          name: "J3 Bots",
          command: ["/b/J3.AppImage", "--hidden"],
        });
        yield* writeEntry(file, moved);
        assert.strictEqual(yield* fs.readFileString(file), moved);
        // Nothing is left beside it: the temporary file was renamed over it.
        assert.deepStrictEqual(yield* fs.readDirectory(folder), ["j3bots.desktop"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is removed alone, and removing it again, or before it was written, succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* autostartFolder;
      const file = path.join(folder, "j3bots.desktop");
      yield* removeEntry(file);
      const other = path.join(folder, "another-app.desktop");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(other, "[Desktop Entry]\n");
      yield* writeEntry(
        file,
        renderAutostartEntry({ name: "J3 Bots", command: ["/a/J3", "--hidden"] }),
      );
      yield* removeEntry(file);
      yield* removeEntry(file);
      assert.deepStrictEqual(yield* fs.readDirectory(folder), ["another-app.desktop"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails, and leaves nothing behind, where the folder cannot be made", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* fs.makeTempDirectoryScoped();
      // A file where the autostart folder would be.
      const blocked = path.join(config, "autostart");
      yield* fs.writeFileString(blocked, "");
      const failure = yield* writeEntry(
        path.join(blocked, "j3bots.desktop"),
        renderAutostartEntry({ name: "J3 Bots", command: ["/a/J3", "--hidden"] }),
      ).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AutostartNotChanged");
      assert.deepStrictEqual(yield* fs.readDirectory(config), ["autostart"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
