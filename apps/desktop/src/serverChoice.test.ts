// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type ConnectRefusal, ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerChoice from "./serverChoice.ts";
import * as Settings from "./settings.ts";

const origin = Schema.decodeSync(ServerOrigin);
const SERVER = origin("http://192.168.1.20:3737");

/**
 * A server choice over the settings in `file`, whose check answers `answer`,
 * and a page that records what is done to it, with the server kept as it
 * happens.
 */
const setUp = (file: string, answer: ConnectRefusal | null = null) =>
  Effect.gen(function* () {
    const settings = yield* Settings.DesktopSettings;
    const done: Array<string> = [];
    const checked: Array<string> = [];
    const choice = yield* ServerChoice.make((server) =>
      Effect.sync(() => {
        checked.push(server);
        return answer;
      }),
    );
    const page: ServerChoice.Page = {
      clearStorage: Effect.gen(function* () {
        done.push(`clear (server ${(yield* settings.get).server ?? "none"})`);
      }),
      openHome: Effect.gen(function* () {
        done.push(`open home (server ${(yield* settings.get).server ?? "none"})`);
      }),
    };
    return { choice, page, done, checked, settings };
  }).pipe(Effect.provide(Settings.layer(file)));

/** A settings file in a fresh directory, optionally holding `text`. */
const settingsFile = (text?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-settings-" });
    const file = path.join(directory, "desktop.json");
    if (text !== undefined) yield* fs.writeFileString(file, text);
    return file;
  });

/** A settings file that cannot be written: its directory is a regular file. */
const unwritableFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-settings-" });
  yield* fs.writeFileString(path.join(directory, "not-a-directory"), "");
  return path.join(directory, "not-a-directory", "desktop.json");
});

describe("naming the server", () => {
  it.effect("empties the page's storage before it keeps the server, and writes it", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile();
      const { choice, page, done, settings } = yield* setUp(file);
      const result = yield* choice.connect("192.168.1.20:3737", page);
      assert.deepStrictEqual(result, { _tag: "connected", server: SERVER });
      assert.deepStrictEqual(done, ["clear (server none)"]);
      assert.strictEqual((yield* settings.get).server, SERVER);
      const written = yield* (yield* FileSystem.FileSystem).readFileString(file);
      assert.include(written, `"server":"${SERVER}"`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses, keeping no server, when the server cannot be written", () =>
    Effect.gen(function* () {
      const { choice, page, settings } = yield* setUp(yield* unwritableFile);
      const result = yield* choice.connect("192.168.1.20:3737", page);
      assert.deepStrictEqual(result, { _tag: "refused", reason: "not-saved" });
      assert.isNull((yield* settings.get).server);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while a server is kept, without checking or touching the page", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ server: SERVER, window: null }));
      const { choice, page, done, checked } = yield* setUp(file);
      const result = yield* choice.connect("10.0.0.5:3737", page);
      assert.deepStrictEqual(result, { _tag: "refused", reason: "server-kept" });
      assert.deepStrictEqual(done, []);
      assert.deepStrictEqual(checked, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps nothing and touches nothing when no J3 Bots server answers", () =>
    Effect.gen(function* () {
      const { choice, page, done, settings } = yield* setUp(yield* settingsFile(), "not-j3-bots");
      const result = yield* choice.connect("192.168.1.20:3737", page);
      assert.deepStrictEqual(result, { _tag: "refused", reason: "not-j3-bots" });
      assert.deepStrictEqual(done, []);
      assert.isNull((yield* settings.get).server);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("forgetting the server", () => {
  it.effect("writes it forgotten, then empties the page's storage and loads it again", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ server: SERVER, window: null }));
      const { choice, page, done } = yield* setUp(file);
      assert.strictEqual(yield* choice.forget(page), "forgotten");
      assert.deepStrictEqual(done, ["clear (server none)", "open home (server none)"]);
      const written = yield* (yield* FileSystem.FileSystem).readFileString(file);
      assert.include(written, `"server":null`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails, with the server kept and the page untouched, when it cannot be written", () =>
    Effect.gen(function* () {
      const { choice, page, done } = yield* setUp(yield* unwritableFile);
      assert.strictEqual(yield* choice.forget(page), "failed");
      assert.deepStrictEqual(done, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the settings file", () => {
  it("reads the server, the window, the shortcut and the appearance each on its own", () => {
    const window = { x: 10, y: 20, width: 800, height: 600, maximized: false };
    const shortcut = "Control+Alt+K";
    assert.deepStrictEqual(
      Settings.decodeSettings(
        JSON.stringify({ server: SERVER, window: { x: "left" }, shortcut, appearance: "dark" }),
      ),
      {
        settings: { server: SERVER, window: null, shortcut, appearance: "dark" },
        dropped: ["window"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: "somewhere", window })),
      {
        settings: { server: null, window, shortcut: null, appearance: "system" },
        dropped: ["server"],
      },
    );
    // Shift alone does not make a shortcut: it would take a capital letter from every app.
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, window, shortcut: "Shift+K" })),
      {
        settings: { server: SERVER, window, shortcut: null, appearance: "system" },
        dropped: ["shortcut"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, appearance: "sepia" })),
      {
        settings: { server: SERVER, window: null, shortcut: null, appearance: "system" },
        dropped: ["appearance"],
      },
    );
    assert.deepStrictEqual(Settings.decodeSettings("{ not json"), {
      settings: { server: null, window: null, shortcut: null, appearance: "system" },
      dropped: [],
    });
  });

  it("drops a server the server address screen would refuse now", () => {
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: "http://192.0.2.10:3737", window: null })),
      {
        settings: { server: null, window: null, shortcut: null, appearance: "system" },
        dropped: ["server"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: "https://192.0.2.10:3737" })).settings,
      {
        server: origin("https://192.0.2.10:3737"),
        window: null,
        shortcut: null,
        appearance: "system",
      },
    );
  });
});
