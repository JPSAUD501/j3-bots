// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A socket a crashed server left behind takes a listener from node:net.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import * as Home from "./Home.ts";

/** A fresh private home, with the paths the server derives from it. */
const freshHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  yield* fs.chmod(home, 0o700);
  const config: ServerConfigShape = {
    home,
    configFile: path.join(home, "config.json"),
    databasePath: path.join(home, "j3.sqlite"),
    engineHome: path.join(home, "engine"),
    host: "127.0.0.1",
    privateOnly: true,
    port: 3737,
    tls: Option.none(),
    enginePort: 3738,
    engineBinary: Option.none(),
    scriptedAgent: Option.none(),
    toolPort: 3739,
    webClient: { _tag: "bundled", directory: path.join(home, "web") },
    adminSocket: path.join(home, "admin.sock"),
  };
  return config;
});

const reserveIn = (config: ServerConfigShape) =>
  Home.reserve.pipe(Effect.provideService(ServerConfig, config));

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

/** A Unix socket at `path` that nothing listens on, as a killed server leaves it. */
const staleSocket = Effect.fn("staleSocket")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const listening = `${path}.listening`;
  const server = NodeNet.createServer();
  yield* Effect.callback<void>((resume) => {
    server.listen({ path: listening }, () => resume(Effect.void));
  });
  // A second name for the socket outlives the listener, which removes only
  // its own name when it closes.
  yield* fs.link(listening, path);
  yield* Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });
});

it.layer(NodeServices.layer)("home", (it) => {
  it.effect("is held by one server at a time, and free again once it stops", () =>
    Effect.gen(function* () {
      const config = yield* freshHome;
      const [first, second] = yield* Effect.all(
        [reserveIn(config).pipe(Effect.exit), reserveIn(config).pipe(Effect.exit)],
        { concurrency: 2 },
      );
      assert.strictEqual([first, second].filter(Exit.isSuccess).length, 1);
      assert.deepInclude(failure(Exit.isFailure(first) ? first : second), {
        _tag: "ServerAlreadyRunning",
      });
    }).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.gen(function* () {
          const config = yield* freshHome;
          yield* reserveIn(config).pipe(Effect.scoped);
          yield* reserveIn(config).pipe(Effect.scoped);
        }).pipe(Effect.scoped),
      ),
    ),
  );

  it.effect("removes a socket a stopped server left, and nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stale = yield* freshHome;
      yield* staleSocket(stale.adminSocket);
      yield* reserveIn(stale).pipe(Effect.scoped);
      assert.isFalse(yield* fs.exists(stale.adminSocket));

      const blocked = yield* freshHome;
      yield* fs.writeFileString(blocked.adminSocket, "notes");
      const exit = yield* reserveIn(blocked).pipe(Effect.scoped, Effect.exit);
      assert.deepInclude(failure(exit), { _tag: "HomeBlocked", reason: "not-a-socket" });
      assert.strictEqual(yield* fs.readFileString(blocked.adminSocket), "notes");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a home other users can open, before it creates anything in it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* freshHome;
      yield* fs.chmod(config.home, 0o750);
      const exit = yield* reserveIn(config).pipe(Effect.scoped, Effect.exit);
      const error = failure(exit);
      assert.deepInclude(error, { _tag: "HomeNotPrivate", reason: "open-to-others" });
      assert.include(Schema.is(Home.HomeNotPrivate)(error) ? error.fix : "", "chmod 700");
      assert.deepStrictEqual(yield* fs.readDirectory(config.home), []);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a home this user cannot search, as `chmod -R 600` leaves it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home } = yield* freshHome;
      yield* fs.chmod(home, 0o600);
      const error = yield* Home.checkPrivate(home).pipe(
        Effect.flip,
        Effect.ensuring(fs.chmod(home, 0o700).pipe(Effect.orDie)),
      );
      assert.strictEqual(error.reason, "closed-to-owner");
      assert.include(error.fix, "chmod 700");
    }).pipe(Effect.scoped),
  );

  it.effect("gives a fix only for a refusal it can name the repair of", () =>
    Effect.gen(function* () {
      // How Node reports each refusal of `access(home, W_OK)`.
      const refusal = (code: string, tag: PlatformError.SystemErrorTag) =>
        Home.checkWritable("/srv/j3").pipe(
          Effect.flip,
          Effect.provide(
            FileSystem.layerNoop({
              access: (path) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: tag,
                    module: "FileSystem",
                    method: "access",
                    pathOrDescriptor: path,
                    cause: Object.assign(new Error(`${code}: access '${path}'`), { code }),
                  }),
                ),
            }),
          ),
        );
      // The home is already this user's, with mode 0700: chmod cannot lift this refusal.
      const denied = yield* refusal("EACCES", "PermissionDenied");
      assert.include(denied.message, "EACCES: access '/srv/j3'");
      assert.isUndefined(denied.fix);
      const readOnly = yield* refusal("EROFS", "Unknown");
      assert.include(readOnly.message, "read-only");
      assert.include(readOnly.message, "journalctl");
      assert.notInclude(readOnly.message, "chmod");
      const failing = yield* refusal("EIO", "Unknown");
      assert.include(failing.message, "EIO: access '/srv/j3'");
      assert.isUndefined(failing.fix);
    }),
  );
});
