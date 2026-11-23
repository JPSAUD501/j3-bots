// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A listen that takes a port, for the scan to find it taken.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AclUnreadable, type FolderAcl } from "@j3-bots/server/windows-acl";
import * as Home from "./home.ts";

const freshFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-home-" });
});

const notAsked: Home.WindowsAcl = {
  read: () => Effect.die("the ACL is asked on Windows only"),
  createPrivate: () => Effect.die("the ACL is set on Windows only"),
};
const linux: Home.HomeSystem = { platform: "linux", acl: notAsked };

/** Windows, whose access lists say `acl` of every folder. */
const windowsWith = (acl: Home.WindowsAcl["read"]): Home.HomeSystem => ({
  platform: "win32",
  acl: { read: acl, createPrivate: () => Effect.die("nothing is created") },
});

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const OTHER_USER = "S-1-5-21-1004336348-1177238915-682003330-1002";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";
const FULL_CONTROL = 0x1f01ff;
const READ_AND_EXECUTE = 0x1200a9;

const rule = (sid: string, rights: number) => ({
  sid,
  allow: true,
  rights,
  inherited: false,
  inheritOnly: false,
});

/** The list a home created private has. */
const privateAcl: FolderAcl = {
  user: USER,
  groups: [USERS],
  owner: USER,
  protected: true,
  rules: [rule(USER, FULL_CONTROL), rule(SYSTEM, FULL_CONTROL), rule(ADMINISTRATORS, FULL_CONTROL)],
};

describe("checking the server's home", () => {
  it.effect("accepts a home only this user can open, and one not made yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      yield* Home.checkHome(home, linux);
      yield* fs.makeDirectory(home, { mode: 0o700 });
      yield* fs.chmod(home, 0o700);
      yield* Home.checkHome(home, linux);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a home its group or others can open, and says how to close it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      for (const mode of [0o750, 0o705]) {
        yield* fs.chmod(home, mode);
        const refusal = yield* Effect.flip(Home.checkHome(home, linux));
        assert.strictEqual(refusal.reason, "open-to-others");
        assert.include(refusal.fix, "chmod 700");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a home this user may not read, write and open, as its server would", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.chmod(home, 0o600);
      const refusal = yield* Effect.flip(Home.checkHome(home, linux));
      yield* fs.chmod(home, 0o700);
      assert.strictEqual(refusal.reason, "closed-to-owner");
      assert.include(refusal.fix, "chmod 700");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a home that is a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      yield* fs.writeFileString(home, "");
      assert.strictEqual((yield* Effect.flip(Home.checkHome(home, linux))).reason, "not-a-folder");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("on Windows, accepts a home its access list keeps private", () =>
    Effect.gen(function* () {
      yield* Home.checkHome(
        yield* freshFolder,
        windowsWith(() => Effect.succeed(privateAcl)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "on Windows, refuses a home by what its access list says, with the command that repairs it",
    () =>
      Effect.gen(function* () {
        const home = yield* freshFolder;
        const cases: ReadonlyArray<readonly [FolderAcl, string, ReadonlyArray<string>]> = [
          [
            { ...privateAcl, rules: [...privateAcl.rules, rule(USERS, READ_AND_EXECUTE)] },
            "open-to-others",
            [`icacls "${home}" /inheritance:r`, `/remove "*${USERS}"`],
          ],
          [
            { ...privateAcl, owner: OTHER_USER },
            "not-owned",
            [`takeown /F "${home}" /R`, "icacls"],
          ],
          [
            { ...privateAcl, rules: [rule(USER, READ_AND_EXECUTE), rule(SYSTEM, FULL_CONTROL)] },
            "closed-to-owner",
            [`/grant:r "*${USER}:(OI)(CI)F"`],
          ],
        ];
        for (const [acl, reason, fix] of cases) {
          const refusal = yield* Effect.flip(
            Home.checkHome(
              home,
              windowsWith(() => Effect.succeed(acl)),
            ),
          );
          assert.strictEqual(refusal.reason, reason);
          for (const part of fix) assert.include(refusal.fix, part);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("on Windows, refuses a home whose access list cannot be read, saying why", () =>
    Effect.gen(function* () {
      const home = yield* freshFolder;
      const refusal = yield* Effect.flip(
        Home.checkHome(
          home,
          windowsWith((folder) =>
            Effect.fail(new AclUnreadable({ folder, detail: "Access to the path is denied." })),
          ),
        ),
      );
      assert.strictEqual(refusal.reason, "unverifiable");
      assert.include(refusal.message, "Access to the path is denied.");
      assert.include(refusal.fix, "PowerShell");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("creating the server's home", () => {
  /** Windows, where a private folder is created by `createPrivate`, which these record. */
  const recordingWindows = (acl: FolderAcl) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const created: Array<string> = [];
      const system: Home.HomeSystem = {
        platform: "win32",
        acl: {
          read: () => Effect.succeed(acl),
          createPrivate: (folder) =>
            fs.makeDirectory(folder).pipe(
              Effect.orDie,
              Effect.andThen(() => created.push(folder)),
            ),
        },
      };
      return { system, created };
    });
  const ports = Effect.succeed({ port: 3750, toolPort: 3751, enginePort: 3752 });

  it.effect("on Windows, creates a missing home with its private list, in folders made first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "server", "home");
      const { system, created } = yield* recordingWindows(privateAcl);
      yield* Home.prepareHome(home, system, ports);
      assert.deepStrictEqual(created, [home]);
      assert.include(yield* fs.readFileString(path.join(home, "config.json")), '"port": 3750');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("on Windows, writes nothing in a home that is not private once created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      const { system } = yield* recordingWindows({
        ...privateAcl,
        rules: [...privateAcl.rules, rule(USERS, READ_AND_EXECUTE)],
      });
      const refusal = yield* Effect.flip(Home.prepareHome(home, system, ports));
      assert.strictEqual(refusal._tag, "HomeNotPrivate");
      assert.isFalse(yield* fs.exists(path.join(home, "config.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("on Windows, keeps a home that is there, already checked, as it is", () =>
    Effect.gen(function* () {
      const home = yield* freshFolder;
      const { system, created } = yield* recordingWindows(privateAcl);
      yield* Home.prepareHome(home, system, ports);
      assert.deepStrictEqual(created, []);
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
        linux,
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
        linux,
        Effect.succeed({ port: 3750, toolPort: 3751, enginePort: 3752 }),
      );
      const before = yield* fs.readFileString(path.join(home, "config.json"));
      const port = yield* Home.prepareHome(home, linux, Effect.die("ports are not chosen again"));
      assert.strictEqual(port, 3750);
      assert.strictEqual(yield* fs.readFileString(path.join(home, "config.json")), before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the server's default port from a config.json that names none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.writeFileString(`${home}/config.json`, '{"engine": {}}');
      assert.strictEqual(yield* Home.prepareHome(home, linux, Effect.die("not chosen")), 3737);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a config.json it cannot read, rather than replace it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.writeFileString(`${home}/config.json`, "{ port: 37");
      const error = yield* Effect.flip(Home.prepareHome(home, linux, Effect.die("not chosen")));
      assert.strictEqual(error._tag, "HomeConfigUnreadable");
      assert.strictEqual(yield* fs.readFileString(`${home}/config.json`), "{ port: 37");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Root reads a file of any mode, so the refusal cannot be seen as root.
  it.effect.skipIf(process.getuid?.() === 0)(
    "refuses a config.json this user may not read, and leaves it as it was",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* freshFolder;
        const file = `${home}/config.json`;
        yield* fs.writeFileString(file, '{"port": 3790}');
        yield* fs.chmod(file, 0o000);
        const error = yield* Effect.flip(Home.prepareHome(home, linux, Effect.die("not chosen")));
        assert.strictEqual(error._tag, "HomeConfigUnreadable");
        assert.include(error.message, "cannot read");
        yield* fs.chmod(file, 0o600);
        assert.strictEqual(yield* fs.readFileString(file), '{"port": 3790}');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a config.json that cannot be read as a file, rather than replace it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.makeDirectory(`${home}/config.json`);
      const error = yield* Effect.flip(Home.prepareHome(home, linux, Effect.die("not chosen")));
      assert.strictEqual(error._tag, "HomeConfigUnreadable");
      assert.isTrue((yield* fs.stat(`${home}/config.json`)).type === "Directory");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("starting on the port the app keeps", () => {
  it.effect("writes a config.json that went missing again, on that port", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(yield* freshFolder, "home");
      const taken = new Set([3747]);
      const port = yield* Home.prepareKeptHome(home, linux, 3790, (port) =>
        Effect.succeed(!taken.has(port)),
      );
      assert.strictEqual(port, 3790);
      const written = yield* fs.readFileString(path.join(home, "config.json"));
      assert.include(written, '"port": 3790');
      assert.include(written, '"toolPort": 3748');
      assert.include(written, '"enginePort": 3749');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a config.json that sets another port, and says how to repair it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* freshFolder;
      yield* fs.writeFileString(`${home}/config.json`, '{"port": 3800}');
      const error = yield* Effect.flip(
        Home.prepareKeptHome(home, linux, 3790, () => Effect.die("not chosen")),
      );
      assert.strictEqual(error._tag, "HomePortMoved");
      if (error._tag === "HomePortMoved") assert.include(error.fix, '"port" back to 3790');
      assert.strictEqual(yield* fs.readFileString(`${home}/config.json`), '{"port": 3800}');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
