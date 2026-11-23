// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The server is started as the desktop app starts it: with node:child_process, a pipe at fd 3 and stdin as its lifeline.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AdminClient from "../admin/AdminClient.ts";
import * as Socket from "../admin/socket.ts";
import * as Home from "../home/Home.ts";
import { HOME_ENTRIES } from "../home/entries.ts";

const SERVER = `${import.meta.dirname}/../bin.ts`;

/** Long enough for a server to start, migrate a new database and stop again. */
const WITHIN = Duration.seconds(60);

/** A port no one listens on now: the tool and engine ports cannot be 0. */
const freePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

/**
 * `j3-bots serve --admin-fd 3 --exit-with-stdin` on a new home, as the desktop
 * app runs it: its stdin and fd 3 are pipes this process holds. The engine it
 * is pointed at does not exist, so it never becomes ready; nothing here needs
 * it. Killed if a test leaves it running.
 */
const startServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "j3-serve-" });
  const home = path.join(scratch, "home");
  const env = {
    ...process.env,
    J3_HOME: home,
    J3_HOST: "127.0.0.1",
    J3_PORT: String(yield* freePort),
    J3_TOOL_PORT: String(yield* freePort),
    J3_ENGINE_PORT: String(yield* freePort),
    J3_ENGINE_BINARY: path.join(scratch, "no-engine"),
  };
  let output = "";
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        process.execPath,
        [SERVER, "serve", "--admin-fd", "3", "--exit-with-stdin"],
        { env, stdio: ["pipe", "pipe", "pipe", "overlapped"] },
      ),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  );
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const end = child.stdio[3];
  if (!(end instanceof NodeNet.Socket)) return yield* Effect.die("the child has no pipe at fd 3");
  const pipe = yield* AdminClient.openPipe(end);
  return {
    home,
    child,
    pipe,
    /** The exit code, once the server ended by itself. */
    exited: Effect.promise(() => exit).pipe(
      Effect.timeoutOrElse({
        duration: WITHIN,
        orElse: () => Effect.die(`the server did not stop; it wrote:\n${output}`),
      }),
    ),
    /** What it wrote, for a failure's message. */
    output: () => output,
  };
});

/** Whether the server left the home free: its lock released and its socket gone. */
const assertReleased = Effect.fn("assertReleased")(function* (home: string) {
  const path = yield* Path.Path;
  yield* Home.holdHome(home).pipe(Effect.scoped);
  assert.strictEqual(yield* Socket.probe(path.join(home, HOME_ENTRIES.adminSocket)), "absent");
});

const services = AdminClient.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("serve, as the desktop app runs it", () => {
  it.live(
    "serves the admin channel on the inherited pipe, and stops when stdin ends",
    () =>
      Effect.gen(function* () {
        const admin = yield* AdminClient.AdminClient;
        const path = yield* Path.Path;
        const server = yield* startServer;
        // Asked before it listens: the request waits in the pipe until it serves.
        const status = yield* admin.status(server.pipe);
        assert.strictEqual(Option.getOrUndefined(status)?.pid, server.child.pid, server.output());

        const grant = yield* admin.localDevice(server.pipe, {
          name: "This computer",
          replaces: null,
        });
        assert.isTrue(Option.isSome(grant));
        // The admin socket serves the same routes, and sees the same server.
        const overSocket = yield* admin.status(path.join(server.home, HOME_ENTRIES.adminSocket));
        assert.strictEqual(Option.getOrUndefined(overSocket)?.pairedDevices, 1);

        server.child.stdin?.end();
        assert.strictEqual(yield* server.exited, 0, server.output());
        yield* assertReleased(server.home);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(WITHIN) * 2 },
  );

  it.live(
    "stops when asked on the admin channel, though stdin is still open",
    () =>
      Effect.gen(function* () {
        const admin = yield* AdminClient.AdminClient;
        const server = yield* startServer;
        assert.isTrue(Option.isSome(yield* admin.status(server.pipe)), server.output());

        assert.isTrue(Option.isSome(yield* admin.shutdown(server.pipe)));
        assert.strictEqual(yield* server.exited, 0, server.output());
        yield* assertReleased(server.home);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(WITHIN) * 2 },
  );
});
