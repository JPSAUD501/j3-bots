// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The server is started as the desktop app starts it, with node:child_process, a pipe at fd 3 and stdin as its lifeline; node:fs opens a FIFO to hand it instead; node:net holds a port another program has, which node:http then fails to listen on.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import { CliError } from "effect/cli";
import * as Migrator from "effect/sql/Migrator";
import * as AdminClient from "../admin/AdminClient.ts";
import * as Socket from "../admin/socket.ts";
import * as Home from "../home/Home.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import * as Ports from "../system/Ports.ts";
import { startFailure } from "./serve.ts";

const SERVER = `${import.meta.dirname}/../bin.ts`;

/** Long enough for a server to start, migrate a new database and stop again. */
const WITHIN = Duration.seconds(60);

/** A listener on a port the system picked, closed when the scope ends. */
const listenAnywhere = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);

/**
 * A server's three ports, which no one listens on now and which all differ:
 * the tool and engine ports cannot be 0. Every listener stays open until all
 * three are known, so the system cannot hand out a port it already gave.
 */
const serverPorts = Effect.all(
  { port: listenAnywhere, tool: listenAnywhere, engine: listenAnywhere },
  { concurrency: "unbounded" },
).pipe(Effect.scoped);

/**
 * A new home in a scratch folder, and the environment that points a server
 * at it. The engine it names does not exist, so it never becomes ready;
 * nothing here needs it.
 */
const newHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "j3-serve-" });
  const home = path.join(scratch, "home");
  const ports = yield* serverPorts;
  const env = {
    ...process.env,
    J3_HOME: home,
    J3_HOST: "127.0.0.1",
    J3_PORT: String(ports.port),
    J3_TOOL_PORT: String(ports.tool),
    J3_ENGINE_PORT: String(ports.engine),
    J3_ENGINE_BINARY: path.join(scratch, "no-engine"),
  };
  return { scratch, home, env };
});

/**
 * `command <args>` with `fd3` at its descriptor 3, killed if a test leaves it
 * running: its exit code once it ends by itself, and what it wrote.
 */
const spawnChild = Effect.fn("spawnChild")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  fd3: "overlapped" | "ignore" | number,
) {
  let output = "";
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(command, args, {
        env,
        stdio: ["pipe", "pipe", "pipe", fd3],
      }),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  );
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    child,
    /** The exit code, once it ended by itself. */
    exited: Effect.promise(() => exit).pipe(
      Effect.timeoutOrElse({
        duration: WITHIN,
        orElse: () => Effect.die(`it did not stop; it wrote:\n${output}`),
      }),
    ),
    /** What it wrote, for a failure's message. */
    output: () => output,
  };
});

/** The parent's end of `child`'s descriptor 3, as the admin channel. */
const pipeOf = (child: NodeChildProcess.ChildProcess) => {
  const end = child.stdio[3];
  return end instanceof NodeNet.Socket
    ? AdminClient.openPipe(end)
    : Effect.die("the child has no pipe at fd 3");
};

/**
 * `j3-bots serve --admin-fd 3 --exit-with-stdin` on a new home, as the desktop
 * app runs it: its stdin and fd 3 are pipes this process holds, and fd 3 is
 * spawned `"overlapped"`, which on Linux and macOS is a socket pair.
 */
const startServer = Effect.gen(function* () {
  const { home, env } = yield* newHome;
  const server = yield* spawnChild(
    process.execPath,
    [SERVER, "serve", "--admin-fd", "3", "--exit-with-stdin"],
    env,
    "overlapped",
  );
  return { ...server, home, pipe: yield* pipeOf(server.child) };
});

/**
 * Listens on TCP, puts that listening socket at descriptor 3, and becomes the
 * command its arguments name. In Python, since Node hands a child a server's
 * socket only through IPC.
 */
const OVER_TCP = `
import os, socket, sys
listening = socket.create_server(("127.0.0.1", 0))
if listening.fileno() != 3:
    os.dup2(listening.fileno(), 3)
os.set_inheritable(3, True)
os.execv(sys.argv[1], sys.argv[1:])
`;

/** Whether the server left the home free: its lock released and its socket gone. */
const assertReleased = Effect.fn("assertReleased")(function* (home: string) {
  const path = yield* Path.Path;
  yield* Home.holdHome(home).pipe(Effect.scoped);
  assert.strictEqual(yield* Socket.probe(path.join(home, HOME_ENTRIES.adminSocket)), "absent");
});

const services = AdminClient.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("serve, as the desktop app runs it", () => {
  it.live(
    "serves the admin channel on the inherited socket pair, and stops when stdin ends",
    () =>
      Effect.gen(function* () {
        const admin = yield* AdminClient.AdminClient;
        const path = yield* Path.Path;
        const server = yield* startServer;
        // Asked before it listens: the request waits in the pipe until it serves.
        const status = yield* admin.status(server.pipe, { within: WITHIN });
        assert.strictEqual(Option.getOrUndefined(status)?.pid, server.child.pid, server.output());

        const grant = yield* admin.localDevice(server.pipe, {
          name: "This computer",
          replaces: null,
        });
        assert.isTrue(Option.isSome(grant));
        const adminSocket = path.join(server.home, HOME_ENTRIES.adminSocket);
        if (Socket.hasAdminSocket(process.platform)) {
          // The admin socket serves the same routes, and sees the same server.
          const overSocket = yield* admin.status(adminSocket);
          assert.strictEqual(Option.getOrUndefined(overSocket)?.pairedDevices, 1);
        } else {
          assert.strictEqual(yield* Socket.probe(adminSocket), "absent");
        }

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
        const status = yield* admin.status(server.pipe, { within: WITHIN });
        assert.isTrue(Option.isSome(status), server.output());

        assert.isTrue(Option.isSome(yield* admin.shutdown(server.pipe)));
        assert.strictEqual(yield* server.exited, 0, server.output());
        yield* assertReleased(server.home);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(WITHIN) * 2 },
  );

  it.live("gives up on a channel that never answers, and closes it", () =>
    Effect.gen(function* () {
      const admin = yield* AdminClient.AdminClient;
      // A child that holds fd 3 and never reads it.
      const silent = yield* spawnChild(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        process.env,
        "overlapped",
      );
      const pipe = yield* pipeOf(silent.child);
      const unanswered = yield* admin
        .status(pipe, { within: Duration.millis(200) })
        .pipe(Effect.flip);
      assert.strictEqual(unanswered._tag, "AdminRequestFailed");
      // The unanswered request would be read as the next one's answer: the channel is gone.
      assert.isTrue(Option.isNone(yield* admin.status(pipe)));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  // Not on Windows, where no parent can put a socket at a child's descriptor
  // 3: libuv there hands a child only pipes and consoles as stdio
  // (src/win/process-stdio.c, read on v1.x at f08538c).
  it.live.skipIf(process.platform === "win32")(
    "refuses to start on a listening TCP socket",
    () =>
      Effect.gen(function* () {
        const { home, env } = yield* newHome;
        const server = yield* spawnChild(
          "python3",
          ["-c", OVER_TCP, process.execPath, SERVER, "serve", "--admin-fd", "3"],
          env,
          "ignore",
        );
        assert.notStrictEqual(yield* server.exited, 0, server.output());
        assert.include(server.output(), "--admin-fd 3 cannot carry the admin channel");
        assert.include(server.output(), "it is a TCP socket");
        yield* assertReleased(home);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(WITHIN) * 2 },
  );

  it.live.skipIf(process.platform === "win32")(
    "refuses to start on a FIFO",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { scratch, home, env } = yield* newHome;
        const fifo = path.join(scratch, "fifo");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        // Open for reading and writing, which does not wait for a writer.
        const fd = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFs.openSync(fifo, "r+")),
          (fd) => Effect.sync(() => NodeFs.closeSync(fd)),
        );
        const server = yield* spawnChild(
          process.execPath,
          [SERVER, "serve", "--admin-fd", "3"],
          env,
          fd,
        );
        assert.notStrictEqual(yield* server.exited, 0, server.output());
        assert.include(server.output(), "it is a FIFO or a one-way pipe, not a socket pair");
        yield* assertReleased(home);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(WITHIN) * 2 },
  );
});

// The desktop app tells a start the server refused from a crash by its exit
// status: it shows a refusal and does not start the server again.

describe("how a failed start ends", () => {
  it("ends a start refused for the home with status 78 and the home's own message", () => {
    const refusal = new Home.HomeNotPrivate({ home: "/data/home", reason: "open-to-others" });
    const failure = startFailure(refusal);
    assert.strictEqual(failure[Runtime.errorExitCode], 78);
    assert.strictEqual(failure[CliError.userMessage], refusal.message);
  });

  it("ends a database a newer release migrated as refused", () => {
    const failure = startFailure(
      new Migrator.MigrationError({ kind: "BadState", message: "newer" }),
    );
    assert.strictEqual(failure[Runtime.errorExitCode], 78);
  });

  it.effect("ends a start whose port another program holds as refused, naming the port", () =>
    Effect.gen(function* () {
      const held = yield* Effect.acquireRelease(
        Effect.callback<NodeNet.Server>((resume) => {
          const server = NodeNet.createServer();
          server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );
      const address = held.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      const listenFailed = yield* Effect.flip(
        Layer.build(
          Ports.listen(
            () => NodeHttp.createServer(),
            { host: "127.0.0.1", port },
            { label: "the server", setting: "port", host: "127.0.0.1", port },
            "/data/home/config.json",
          ),
        ),
      );
      const failure = startFailure(listenFailed);
      assert.strictEqual(failure[Runtime.errorExitCode], 78);
      assert.include(
        failure[CliError.userMessage],
        `Port ${port}, for the server, is in use by another program.`,
      );
    }).pipe(Effect.scoped),
  );

  it("ends a listen that failed for another reason as one the app may start again after", () => {
    const tooManyFiles = { _tag: "ListenFailed", code: "EMFILE", message: "EMFILE" };
    const failure = startFailure(tooManyFiles);
    assert.notStrictEqual(failure[Runtime.errorExitCode], 78);
  });

  it("ends any other failure as one the app may start again after", () => {
    const failure = startFailure(
      new Migrator.MigrationError({ kind: "Failed", message: "disk I/O error" }),
    );
    assert.notStrictEqual(failure[Runtime.errorExitCode], 78);
  });
});
