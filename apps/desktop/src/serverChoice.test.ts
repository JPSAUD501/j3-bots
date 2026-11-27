// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type ConnectRefusal, ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ExportFailed } from "./localServer/exportProcess.ts";
import type * as Home from "./localServer/home.ts";
import * as LocalHost from "./localServer/localHost.ts";
import * as ServerChoice from "./serverChoice.ts";
import * as Settings from "./settings.ts";

const origin = Schema.decodeSync(ServerOrigin);
const SERVER = origin("http://192.168.1.20:3737");
const LOCAL = origin("http://127.0.0.1:3747");
const DEVICE = "device-1";
const EXPORT = "/exports/j3-bots-export.tar.gz";
/** The bots' data on this computer, which deleting it deletes. */
const DATA = "/data/server/home";
const PASSPHRASE = Redacted.make("a long passphrase for the move");
/** What an export left out: the secrets, which wait for an old vault's password. */
const LEFT_OUT = {
  secrets: "old-vault",
  links: 1,
  names: 0,
  firstNames: [],
  attachmentsMissing: 0,
} as const;
/** Bots that moved away from this computer, as the settings file keeps it. */
const MOVED = { file: EXPORT, at: "2026-11-20T10:00:00.000Z", leftOut: LEFT_OUT };

/**
 * A server choice over the settings in `file`, whose check answers `answer`,
 * and a page that records what is done to it, with the server kept as it
 * happens. An export fails with `exportRefusal` when it is given, and ends
 * only once `exportEnds` does.
 */
const setUp = (
  file: string,
  answer: ConnectRefusal | null = null,
  localAvailable = true,
  prepare: ServerChoice.LocalServer["prepare"] = Effect.succeed(LOCAL),
  exportRefusal?: string,
  exportEnds: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const settings = yield* Settings.DesktopSettings;
    const done: Array<string> = [];
    const checked: Array<string> = [];
    const local: ServerChoice.LocalServer = {
      available: localAvailable,
      prepare,
      start: Effect.sync(() => done.push("start local server")),
      stop: Effect.sync(() => done.push("stop local server")),
      holds: (to) => Effect.succeed(to.startsWith(`${DATA}/`)),
      exportTo: (to, passphrase) =>
        Effect.gen(function* () {
          done.push(`export to ${to} (passphrase ${Redacted.value(passphrase).length} long)`);
          yield* exportEnds;
          if (exportRefusal !== undefined) {
            return yield* new ExportFailed({ reason: exportRefusal });
          }
          return LEFT_OUT;
        }),
      deleteData: Effect.sync(() => {
        done.push("delete local data");
      }),
    };
    const choice = yield* ServerChoice.make(
      (server) =>
        Effect.sync(() => {
          checked.push(server);
          return answer;
        }),
      local,
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

describe("running the bots on this computer", () => {
  it.effect(
    "forgets the named server with the page's storage, keeps this computer's and starts it",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(
          JSON.stringify({ server: SERVER, localDevice: { id: DEVICE, current: true } }),
        );
        const { choice, page, done, settings } = yield* setUp(file);
        assert.strictEqual(yield* choice.useThisComputer(page), "changed");
        assert.deepStrictEqual(done, [
          "clear (server http://192.168.1.20:3737)",
          "start local server",
          "open home (server http://127.0.0.1:3747)",
        ]);
        const now = yield* settings.get;
        assert.strictEqual(now.mode, "local");
        assert.strictEqual(now.server, LOCAL);
        // Chosen again: its next sign-in, which replaces the device, needs no asking.
        assert.deepStrictEqual(now.localDevice, { id: DEVICE, current: false });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "answers why the bots' folder is refused and how to repair it, changing nothing, and goes on once it is repaired",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-home-" }),
          "home",
        );
        yield* fs.makeDirectory(home, { mode: 0o700 });
        yield* fs.chmod(home, 0o750);
        const unix: Home.HomeSystem = {
          platform: "linux",
          acl: {
            read: () => Effect.die("the ACL is asked on Windows only"),
            createPrivate: () => Effect.die("the ACL is set on Windows only"),
          },
        };
        const file = yield* settingsFile(JSON.stringify({ server: SERVER }));
        const { choice, page, done, settings } = yield* setUp(
          file,
          null,
          true,
          LocalHost.prepareChosen(home, unix).pipe(Effect.provide(NodeServices.layer)),
        );

        assert.deepStrictEqual(yield* choice.useThisComputer(page), {
          _tag: "home-refused",
          reason: `Other users on this computer can open ${home}, where this computer's bots keep their data and their keys.`,
          fix: `Close it to others (\`chmod 700 '${home}'\`), then try again.`,
        });
        assert.deepStrictEqual(done, []);
        assert.strictEqual((yield* settings.get).server, SERVER);

        yield* fs.chmod(home, 0o700);
        assert.strictEqual(yield* choice.useThisComputer(page), "changed");
        assert.strictEqual((yield* settings.get).mode, "local");
        assert.include(done, "start local server");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("changes nothing where this computer cannot run the server", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ server: SERVER }));
      const { choice, page, done, settings } = yield* setUp(file, null, false);
      assert.strictEqual(yield* choice.useThisComputer(page), "unavailable");
      assert.deepStrictEqual(done, []);
      assert.strictEqual((yield* settings.get).server, SERVER);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is not left by forgetting the server, which would stop the bots", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
      const { choice, page, done } = yield* setUp(file);
      assert.strictEqual(yield* choice.forget(page), "failed");
      assert.deepStrictEqual(done, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "stops the server, keeps the device to replace, turns phone access off, and opens the address screen",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(
          JSON.stringify({
            mode: "local",
            server: LOCAL,
            localDevice: { id: DEVICE, current: true },
            phoneAccess: true,
          }),
        );
        const { choice, page, done, settings } = yield* setUp(file);
        assert.strictEqual(yield* choice.connectToServerInstead(page), "changed");
        assert.deepStrictEqual(done, [
          "stop local server",
          "clear (server none)",
          "open home (server none)",
        ]);
        const now = yield* settings.get;
        assert.strictEqual(now.mode, "remote");
        assert.isNull(now.server);
        assert.deepStrictEqual(now.localDevice, { id: DEVICE, current: false });
        assert.isFalse(now.phoneAccess);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lets a step taken while the bots run here end before they stop running here", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
      const { choice, page, done } = yield* setUp(file);
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      // Try again of an update stops the server, then starts it.
      const retry = Effect.gen(function* () {
        done.push("retry: stop");
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(go);
        done.push("retry: start");
      });

      const retrying = yield* Effect.forkChild(choice.whileLocal(retry));
      yield* Deferred.await(entered);
      const leaving = yield* Effect.forkChild(choice.connectToServerInstead(page));
      // Time for the switch to save and stop the server, were it not kept waiting.
      yield* Effect.sleep("200 millis");
      yield* Deferred.succeed(go, undefined);
      yield* Fiber.join(retrying);
      assert.strictEqual(yield* Fiber.join(leaving), "changed");
      // Once they run elsewhere, it does nothing.
      yield* choice.whileLocal(retry);

      assert.deepStrictEqual(done, [
        "retry: stop",
        "retry: start",
        "stop local server",
        "clear (server none)",
        "open home (server none)",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the settings file", () => {
  const REMOTE = {
    mode: "remote",
    server: SERVER,
    localDevice: null,
    startWithSystem: false,
    phoneAccess: false,
    updateChannel: "stable",
    automaticUpdates: true,
    moved: null,
    quickAccess: [],
    windowTitle: true,
    windowPicture: false,
  } as const;
  const NONE = {
    mode: null,
    server: null,
    localDevice: null,
    startWithSystem: false,
    phoneAccess: false,
    updateChannel: "stable",
    automaticUpdates: true,
    moved: null,
    quickAccess: [],
    windowTitle: true,
    windowPicture: false,
  } as const;

  it("reads the server, the window, the shortcut, the appearance, starting with the system, phone access, the update channel and updating by itself each on its own", () => {
    const window = { x: 10, y: 20, width: 800, height: 600, maximized: false };
    const shortcut = "Control+Alt+K";
    assert.deepStrictEqual(
      Settings.decodeSettings(
        JSON.stringify({ server: SERVER, window: { x: "left" }, shortcut, appearance: "dark" }),
      ),
      {
        settings: { ...REMOTE, window: null, shortcut, appearance: "dark" },
        dropped: ["window"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: "somewhere", window })),
      {
        settings: { ...NONE, window, shortcut: null, appearance: "system" },
        dropped: ["server"],
      },
    );
    // Shift alone does not make a shortcut: it would take a capital letter from every app.
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, window, shortcut: "Shift+K" })),
      {
        settings: { ...REMOTE, window, shortcut: null, appearance: "system" },
        dropped: ["shortcut"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, appearance: "sepia" })),
      {
        settings: { ...REMOTE, window: null, shortcut: null, appearance: "system" },
        dropped: ["appearance"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, startWithSystem: "yes" })),
      {
        settings: { ...REMOTE, window: null, shortcut: null, appearance: "system" },
        dropped: ["startWithSystem"],
      },
    );
    assert.isTrue(
      Settings.decodeSettings(JSON.stringify({ startWithSystem: true })).settings.startWithSystem,
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, phoneAccess: "on" })),
      {
        settings: { ...REMOTE, window: null, shortcut: null, appearance: "system" },
        dropped: ["phoneAccess"],
      },
    );
    assert.isTrue(
      Settings.decodeSettings(JSON.stringify({ mode: "local", phoneAccess: true })).settings
        .phoneAccess,
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, updateChannel: "beta" })),
      {
        settings: { ...REMOTE, window: null, shortcut: null, appearance: "system" },
        dropped: ["updateChannel"],
      },
    );
    assert.strictEqual(
      Settings.decodeSettings(JSON.stringify({ updateChannel: "nightly" })).settings.updateChannel,
      "nightly",
    );
    // Updating by itself is on until the operator turns it off, in a file from before it too.
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, automaticUpdates: "no" })),
      {
        settings: { ...REMOTE, window: null, shortcut: null, appearance: "system" },
        dropped: ["automaticUpdates"],
      },
    );
    assert.isFalse(
      Settings.decodeSettings(JSON.stringify({ automaticUpdates: false })).settings
        .automaticUpdates,
    );
    assert.deepStrictEqual(Settings.decodeSettings("{ not json"), {
      settings: { ...NONE, window: null, shortcut: null, appearance: "system" },
      dropped: [],
    });
  });

  it("drops a server the server address screen would refuse now", () => {
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: "http://192.0.2.10:3737", window: null })),
      {
        settings: { ...NONE, window: null, shortcut: null, appearance: "system" },
        dropped: ["server"],
      },
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: "https://192.0.2.10:3737" })).settings,
      {
        mode: "remote",
        server: origin("https://192.0.2.10:3737"),
        localDevice: null,
        window: null,
        shortcut: null,
        appearance: "system",
        startWithSystem: false,
        phoneAccess: false,
        updateChannel: "stable",
        automaticUpdates: true,
        moved: null,
        quickAccess: [],
        windowTitle: true,
        windowPicture: false,
      },
    );
  });

  it("keeps where quick access was put on each display, or nowhere when that cannot be read", () => {
    const quickAccess = [
      { display: "2528732444", right: 24, bottom: 120 },
      { display: "7", right: 0, bottom: 0 },
    ];
    assert.deepStrictEqual(
      Settings.decodeSettings(JSON.stringify({ server: SERVER, quickAccess })).settings.quickAccess,
      quickAccess,
    );
    assert.deepStrictEqual(
      Settings.decodeSettings(
        JSON.stringify({
          server: SERVER,
          quickAccess: [{ display: "7", right: "far", bottom: 0 }],
        }),
      ),
      {
        settings: { ...REMOTE, window: null, shortcut: null, appearance: "system" },
        dropped: ["quickAccess"],
      },
    );
  });

  it("keeps where the bots moved to, and drops a record of it that is not one", () => {
    const kept = Settings.decodeSettings(
      JSON.stringify({ mode: "local", server: LOCAL, moved: MOVED }),
    );
    assert.strictEqual(kept.settings.moved?.file, EXPORT);
    assert.deepStrictEqual(kept.dropped, []);
    const dropped = Settings.decodeSettings(
      JSON.stringify({ mode: "local", server: LOCAL, moved: { file: "", at: "yesterday" } }),
    );
    assert.isNull(dropped.settings.moved);
    assert.deepStrictEqual(dropped.dropped, ["moved"]);
  });
});

describe("moving the bots away from this computer", () => {
  it.effect(
    "stops their server, writes the export, keeps that they moved, and starts nothing here again",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
        const { choice, page, done, settings } = yield* setUp(file);
        assert.deepStrictEqual(yield* choice.moveAway(page, EXPORT, PASSPHRASE), {
          _tag: "exported",
        });
        assert.deepStrictEqual(done, [
          "stop local server",
          `export to ${EXPORT} (passphrase 30 long)`,
          `open home (server ${LOCAL})`,
        ]);
        assert.deepInclude((yield* settings.get).moved, { file: EXPORT, leftOut: LEFT_OUT });
        // A retry, an update's try again or phone access starts nothing now.
        assert.isTrue(Option.isNone(yield* choice.whileLocal(Effect.sync(() => done.push("ran")))));
        assert.notInclude(done, "ran");
        // Nor is a second export taken from the data that moved.
        assert.deepStrictEqual(yield* choice.moveAway(page, EXPORT, PASSPHRASE), {
          _tag: "failed",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts their server again, and says why, when the export fails", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
      const { choice, page, done, settings } = yield* setUp(
        file,
        null,
        true,
        Effect.succeed(LOCAL),
        "There is no room left on the disk.",
      );
      assert.deepStrictEqual(yield* choice.moveAway(page, EXPORT, PASSPHRASE), {
        _tag: "failed",
        reason: "There is no room left on the disk.",
      });
      assert.deepStrictEqual(done, [
        "stop local server",
        `export to ${EXPORT} (passphrase 30 long)`,
        "start local server",
      ]);
      assert.isNull((yield* settings.get).moved);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refuses a file in their data, which deleting it would delete, before anything stops",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
        const { choice, page, done, settings } = yield* setUp(file);
        assert.deepStrictEqual(yield* choice.moveAway(page, `${DATA}/export.tar.gz`, PASSPHRASE), {
          _tag: "refused",
          reason: "inside-data",
        });
        assert.deepStrictEqual(done, []);
        assert.isNull((yield* settings.get).moved);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is under way until the move is kept, and what waits for it waits that long", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
      const exportEnds = yield* Deferred.make<void>();
      const { choice, page, done, settings } = yield* setUp(
        file,
        null,
        true,
        Effect.succeed(LOCAL),
        undefined,
        Deferred.await(exportEnds),
      );
      assert.isFalse(yield* choice.moving);
      const move = yield* Effect.forkChild(choice.moveAway(page, EXPORT, PASSPHRASE));
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => done.length === 2 }));
      assert.isTrue(yield* choice.moving);
      const quit = yield* Effect.forkChild(choice.settled);
      yield* Effect.yieldNow;
      assert.isUndefined(quit.pollUnsafe());
      yield* Deferred.succeed(exportEnds, undefined);
      yield* Fiber.join(quit);
      // What quitting waited for is kept by then.
      assert.strictEqual((yield* settings.get).moved?.file, EXPORT);
      assert.isFalse(yield* choice.moving);
      assert.deepStrictEqual(yield* Fiber.join(move), { _tag: "exported" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps that they moved when this computer is chosen again, so nothing starts unasked",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(
          JSON.stringify({ mode: "remote", server: SERVER, moved: MOVED }),
        );
        const { choice, page, done, settings } = yield* setUp(file);
        assert.strictEqual(yield* choice.useThisComputer(page), "changed");
        assert.deepStrictEqual(done, [`clear (server ${SERVER})`, `open home (server ${LOCAL})`]);
        assert.deepInclude(yield* settings.get, { mode: "local", server: LOCAL });
        assert.strictEqual((yield* settings.get).moved?.file, EXPORT);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs them here again on their data, which starts their server", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(
        JSON.stringify({ mode: "local", server: LOCAL, moved: MOVED }),
      );
      const { choice, page, done, settings } = yield* setUp(file);
      assert.strictEqual(yield* choice.runHereAgain(page), "changed");
      assert.deepStrictEqual(done, ["start local server", `open home (server ${LOCAL})`]);
      const now = yield* settings.get;
      assert.isNull(now.moved);
      assert.strictEqual(now.server, LOCAL);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "deletes their data and asks again where the bots live, with the page's storage emptied",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(
          JSON.stringify({
            mode: "local",
            server: LOCAL,
            localDevice: { id: DEVICE, current: true },
            phoneAccess: true,
            moved: MOVED,
          }),
        );
        const { choice, page, done, settings } = yield* setUp(file);
        assert.strictEqual(yield* choice.deleteLocalData(page), "changed");
        assert.deepStrictEqual(done, [
          "delete local data",
          "clear (server none)",
          "open home (server none)",
        ]);
        const now = yield* settings.get;
        assert.deepInclude(now, {
          mode: null,
          server: null,
          localDevice: null,
          phoneAccess: false,
          moved: null,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "deletes their data while the page runs on the new server, and leaves the page there",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(
          JSON.stringify({ mode: "remote", server: SERVER, moved: MOVED }),
        );
        const { choice, page, done, settings } = yield* setUp(file);
        assert.strictEqual(yield* choice.deleteLocalData(page), "changed");
        assert.deepStrictEqual(done, ["delete local data"]);
        assert.deepInclude(yield* settings.get, { mode: "remote", server: SERVER, moved: null });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deletes nothing of bots that did not move away", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(JSON.stringify({ mode: "local", server: LOCAL }));
      const { choice, page, done } = yield* setUp(file);
      assert.strictEqual(yield* choice.deleteLocalData(page), "failed");
      assert.strictEqual(yield* choice.runHereAgain(page), "failed");
      assert.deepStrictEqual(done, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
