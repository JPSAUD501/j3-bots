// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A listen that takes a port, for the scan to find it taken.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Home from "./home.ts";

const freshFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-home-" });
});

const onlyThisUser = () => Effect.succeed(true);
const openToOthers = () => Effect.succeed(false);
const notAsked = () => Effect.die("the ACL is asked on Windows only");

describe("checking the server's home", () => {
  it.effect("accepts a home only this user can open, and one not made yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      yield* Home.checkHome(home, "linux", notAsked);
      yield* fs.makeDirectory(home, { mode: 0o700 });
      yield* fs.chmod(home, 0o700);
      yield* Home.checkHome(home, "linux", notAsked);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a home its group or others can open, and says how to close it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      for (const mode of [0o750, 0o705]) {
        yield* fs.chmod(home, mode);
        const refusal = yield* Effect.flip(Home.checkHome(home, "linux", notAsked));
        assert.strictEqual(refusal.reason, "open-to-others");
        assert.include(refusal.fix, "chmod 700");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a home that is a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      yield* fs.writeFileString(home, "");
      assert.strictEqual(
        (yield* Effect.flip(Home.checkHome(home, "linux", notAsked))).reason,
        "not-a-folder",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("on Windows, asks the folder's ACL, and refuses what it cannot check", () =>
    Effect.gen(function* () {
      const home = yield* freshFolder;
      yield* Home.checkHome(home, "win32", onlyThisUser);
      assert.strictEqual(
        (yield* Effect.flip(Home.checkHome(home, "win32", openToOthers))).reason,
        "unchecked",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("choosing the server's ports", () => {
  it.effect("takes the three lowest free ports from 3747 up", () =>
    Effect.gen(function* () {
      const taken = new Set([3747, 3749]);
      const ports = yield* Home.choosePorts((port) => Effect.succeed(!taken.has(port)));
      assert.deepStrictEqual(ports, { port: 3748, toolPort: 3750, enginePort: 3751 });
    }),
  );

  it.effect("fails when fewer than three are free", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Home.choosePorts((port) => Effect.succeed(port === 3747)));
      assert.strictEqual(error._tag, "NoFreePorts");
    }),
  );

  it.live("counts a port taken on loopback alone as taken", () =>
    Effect.gen(function* () {
      const server = NodeNet.createServer();
      const port = yield* Effect.callback<number>((resume) => {
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
          const address = server.address();
          resume(
            Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
          );
        });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
      assert.isFalse(yield* Home.isFree(port));
    }).pipe(Effect.scoped),
  );
});

describe("preparing the server's config.json", () => {
  it.effect("writes it once, private, for loopback with the ports chosen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      const port = yield* Home.prepareHome(
        home,
        Effect.succeed({ port: 3750, toolPort: 3751, enginePort: 3752 }),
      );
      assert.strictEqual(port, 3750);
      const file = path.join(home, "config.json");
      const written = yield* fs.readFileString(file);
      assert.include(written, '"host": "127.0.0.1"');
      assert.include(written, '"enginePort": 3752');
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
      assert.strictEqual((yield* fs.stat(home)).mode & 0o777, 0o700);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the port of a home prepared before, so the page's origin stays", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      yield* Home.prepareHome(
        home,
        Effect.succeed({ port: 3750, toolPort: 3751, enginePort: 3752 }),
      );
      const before = yield* fs.readFileString(path.join(home, "config.json"));
      const port = yield* Home.prepareHome(home, Effect.die("ports are not chosen again"));
      assert.strictEqual(port, 3750);
      assert.strictEqual(yield* fs.readFileString(path.join(home, "config.json")), before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the server's default port from a config.json that names none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.writeFileString(`${home}/config.json`, '{"engine": {}}');
      assert.strictEqual(yield* Home.prepareHome(home, Effect.die("not chosen")), 3737);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a config.json it cannot read, rather than replace it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.writeFileString(`${home}/config.json`, "{ port: 37");
      const error = yield* Effect.flip(Home.prepareHome(home, Effect.die("not chosen")));
      assert.strictEqual(error._tag, "HomeConfigUnreadable");
      assert.strictEqual(yield* fs.readFileString(`${home}/config.json`), "{ port: 37");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
