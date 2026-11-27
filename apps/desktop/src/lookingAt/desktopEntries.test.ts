// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { appNameFor, windowClassOf } from "./desktopEntries.ts";

const entry = (lines: ReadonlyArray<string>) => ["[Desktop Entry]", ...lines].join("\n");

describe("the name a window's app goes by", () => {
  it.effect(
    "is its desktop entry's, in the operator's language, the operator's own entry first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "j3-entries-" });
        const own = path.join(root, "own");
        const shared = path.join(root, "shared");
        yield* fs.makeDirectory(own);
        yield* fs.makeDirectory(shared);
        yield* fs.writeFileString(
          path.join(shared, "org.example.Files.desktop"),
          entry(["Name=Files", "Name[pt_BR]=Arquivos", "Name[pt]=Ficheiros"]),
        );
        yield* fs.writeFileString(
          path.join(shared, "example-browser.desktop"),
          entry(["Name=Example Browser", "StartupWMClass=Example-browser"]),
        );
        yield* fs.writeFileString(
          path.join(own, "browser-override.desktop"),
          entry(["Name=My Browser", "StartupWMClass=example-browser"]),
        );
        // Another group's name is not the entry's.
        yield* fs.writeFileString(
          path.join(shared, "notes.desktop"),
          [
            "[Desktop Action New]",
            "Name=New note",
            "[Desktop Entry]",
            "Hidden=true",
            "Name=Notes",
          ].join("\n"),
        );
        const folders = [own, shared];

        const files = { instance: "org.example.Files", className: "org.example.Files" };
        assert.strictEqual(yield* appNameFor(files, folders, "pt-BR"), "Arquivos");
        assert.strictEqual(yield* appNameFor(files, folders, "pt-PT"), "Ficheiros");
        assert.strictEqual(yield* appNameFor(files, folders, "en-US"), "Files");
        const browser = { instance: "navigator", className: "Example-browser" };
        assert.strictEqual(yield* appNameFor(browser, folders, "en-US"), "My Browser");
        assert.isNull(yield* appNameFor({ instance: "notes", className: "Notes" }, folders, "en"));
        assert.isNull(yield* appNameFor(files, [path.join(root, "missing")], "en"));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads a window's class as the X server keeps it", () => {
    const held = (text: string) => new TextEncoder().encode(text);
    assert.deepStrictEqual(windowClassOf(held("navigator\0Example-browser\0")), {
      instance: "navigator",
      className: "Example-browser",
    });
    assert.isNull(windowClassOf(held("navigator\0")));
  });
});
