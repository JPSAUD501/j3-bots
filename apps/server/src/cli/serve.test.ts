// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The server is started as the desktop app starts it, with node:child_process, a pipe at fd 3 and stdin as its lifeline; node:fs opens a FIFO to hand it instead; node:net holds a port another program has, which node:http then fails to listen on.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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

/** The ids a stand-in engine writes once it runs: its own, and its harness's. */
const Started = Schema.Struct({ engine: Schema.Int, harness: Schema.Int });
const decodeStarted = Schema.decodeUnknownEffect(Schema.fromJsonString(Started));

/**
 * What a stand-in engine on Windows finds before it starts anything, by
 * comparing kernel objects, never asking a file anything: the ids of its
 * parent and of its parent's parent; how many file objects it holds; and how
 * many of them it finds again in its own handles, in its parent's, in its
 * grandparent's, and in its parent's but not its grandparent's. Or why it
 * could not look.
 */
const SharedFiles = Schema.Union([
  Schema.Struct({
    parent: Schema.Int,
    grandparent: Schema.Int,
    files: Schema.Int,
    withSelf: Schema.Int,
    withParent: Schema.Int,
    withGrandparent: Schema.Int,
    withParentAlone: Schema.Int,
  }),
  Schema.Struct({ error: Schema.String }),
]);
const decodeSharedFiles = Schema.decodeUnknownEffect(Schema.fromJsonString(SharedFiles));

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

/**
 * A stand-in for the engine in `folder`, for `J3_ENGINE_BINARY`: a Node
 * script that starts a harness that runs until it is ended, writes both ids
 * to `started` (`Started`), and runs until it is ended. Elsewhere `sh` runs
 * it; on Windows a program must, as Node starts no batch file without a
 * shell, so a small C# program, compiled by Windows' own compiler as the job
 * launcher is, starts it and waits for it. That program first writes to
 * `shared` what it shares with the processes above it (`SharedFiles`),
 * trying every handle value up to 64 Ki, past any a process this small or
 * the server has. It takes no account of its arguments, so the server's
 * first run of the engine's binary, its CLI minting the engine's credential,
 * is the stand-in that reports. It never answers, so the
 * server never finds it ready, and starts it as it starts the engine: on
 * Windows, through the job launcher.
 */
const standInEngine = Effect.fn("standInEngine")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const started = path.join(folder, "started.json");
  const shared = path.join(folder, "shared.json");
  const script = path.join(folder, "engine.cjs");
  yield* fs.writeFileString(
    script,
    [
      `const { spawn } = require("node:child_process");`,
      `const fs = require("node:fs");`,
      `const harness = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      // The program the server started: on Windows the C# program below, elsewhere this one, which sh became.
      `const engine = process.platform === "win32" ? process.ppid : process.pid;`,
      `fs.writeFileSync(${JSON.stringify(`${started}.partial`)}, JSON.stringify({ engine, harness: harness.pid }));`,
      `fs.renameSync(${JSON.stringify(`${started}.partial`)}, ${JSON.stringify(started)});`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  if (process.platform === "win32") {
    /** `value` as a C# verbatim string. */
    const verbatim = (value: string) => `@"${value.replaceAll('"', '""')}"`;
    const source = path.join(folder, "engine.cs");
    yield* fs.writeFileString(
      source,
      String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

class Engine {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation {
    public IntPtr ExitStatus;
    public IntPtr Peb;
    public IntPtr Affinity;
    public IntPtr BasePriority;
    public IntPtr Id;
    public IntPtr ParentId;
  }

  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref BasicInformation information, int length, out int returned);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr handle, int informationClass, IntPtr information, int length, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr first, IntPtr second);

  const uint DuplicateAccess = 0x40;
  const uint QueryLimitedAccess = 0x1000;
  const uint SameAccess = 2;
  const int TypeInformation = 2;

  // The process that started 'process', as Windows recorded it.
  static int ParentOf(IntPtr process) {
    BasicInformation information = new BasicInformation();
    int returned;
    int status = NtQueryInformationProcess(process, 0, ref information, Marshal.SizeOf(typeof(BasicInformation)), out returned);
    if (status != 0) throw new Exception("NtQueryInformationProcess " + status);
    return information.ParentId.ToInt32();
  }

  // Whether 'handle' names a file object, by its type, which the object manager
  // answers itself: no file system or driver is asked anything.
  static bool IsFile(IntPtr handle) {
    IntPtr buffer = Marshal.AllocHGlobal(4096);
    try {
      int returned;
      if (NtQueryObject(handle, TypeInformation, buffer, 4096, out returned) != 0) return false;
      int length = Marshal.ReadInt16(buffer);
      return Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, IntPtr.Size), length / 2) == "File";
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static List<IntPtr> OwnFiles() {
    List<IntPtr> files = new List<IntPtr>();
    for (long value = 4; value < 0x10000; value += 4) {
      IntPtr handle = new IntPtr(value);
      uint flags;
      if (GetHandleInformation(handle, out flags) && IsFile(handle)) files.Add(handle);
    }
    return files;
  }

  // Which of 'own' process 'id' holds too: each of its handles, copied
  // here, against each of them, as objects.
  static List<long> SharedWith(int id, List<IntPtr> own) {
    IntPtr process = OpenProcess(DuplicateAccess, false, id);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
    List<long> shared = new List<long>();
    try {
      for (long value = 4; value < 0x10000; value += 4) {
        IntPtr copy;
        if (!DuplicateHandle(process, new IntPtr(value), GetCurrentProcess(), out copy, 0, false, SameAccess)) continue;
        try {
          foreach (IntPtr handle in own) {
            if (!shared.Contains(handle.ToInt64()) && CompareObjectHandles(handle, copy)) shared.Add(handle.ToInt64());
          }
        } finally {
          CloseHandle(copy);
        }
      }
    } finally {
      CloseHandle(process);
    }
    return shared;
  }

  static string Report() {
    try {
      List<IntPtr> own = OwnFiles();
      int parent = ParentOf(GetCurrentProcess());
      IntPtr parentProcess = OpenProcess(QueryLimitedAccess, false, parent);
      if (parentProcess == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
      int grandparent;
      try {
        grandparent = ParentOf(parentProcess);
      } finally {
        CloseHandle(parentProcess);
      }
      List<long> withSelf = SharedWith(Process.GetCurrentProcess().Id, own);
      List<long> withParent = SharedWith(parent, own);
      List<long> withGrandparent = SharedWith(grandparent, own);
      int parentAlone = 0;
      foreach (long handle in withParent) if (!withGrandparent.Contains(handle)) parentAlone++;
      return "{\"parent\":" + parent + ",\"grandparent\":" + grandparent + ",\"files\":" + own.Count + ",\"withSelf\":" + withSelf.Count + ",\"withParent\":" + withParent.Count + ",\"withGrandparent\":" + withGrandparent.Count + ",\"withParentAlone\":" + parentAlone + "}";
    } catch (Exception error) {
      return "{\"error\":\"" + error.Message.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
    }
  }

  static int Main() {
    File.WriteAllText(${verbatim(`${shared}.partial`)}, Report());
    File.Move(${verbatim(`${shared}.partial`)}, ${verbatim(shared)});
    ProcessStartInfo start = new ProcessStartInfo(${verbatim(process.execPath)}, ${verbatim(`"${script}"`)});
    start.UseShellExecute = false;
    Process script = Process.Start(start);
    script.WaitForExit();
    return script.ExitCode;
  }
}
`,
    );
    const command = path.join(folder, "engine.exe");
    const compiler = path.join(
      yield* Config.String("SystemRoot").pipe(Config.withDefault("C:\\Windows")),
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) =>
          NodeChildProcess.execFile(
            compiler,
            ["/nologo", "/target:exe", `/out:${command}`, source],
            { windowsHide: true },
            (error) => (error === null ? resolve() : reject(error)),
          ),
        ),
    );
    return { command, started, shared };
  }
  const command = path.join(folder, "engine");
  yield* fs.writeFileString(command, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  yield* fs.chmod(command, 0o755);
  return { command, started, shared };
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

  // On Linux and macOS a process the server started outlives it, so the pipe
  // closing once the server is killed, while the engine and its harness still
  // run, shows that neither holds it. On Windows Node puts every child it does
  // not detach in a job that ends with it, and the engine's own job ends with
  // the launcher: the engine ends with the server. There the stand-in that
  // the server first runs, its CLI, compares its file objects with the
  // server's and with those of the process that started the server, this
  // one. A child gets every handle its parent may pass on, since the libuv of
  // the Node the server pins names no list of them (1.52.1,
  // src/win/process.c), so the handles this process may pass on reach it
  // through the server, and are its and the server's both. fd 3 is not: this
  // process closed its copy of the child's end once the server started, and
  // the server's Node made it one it does not pass on, as it does every
  // descriptor it inherits (`uv_disable_stdio_inheritance`,
  // deps/uv/src/win/process-stdio.c, read in Node v26.13.1). So no file it
  // shares with the server may be one it does not share with this process.
  // It asks no file anything: a query on a synchronous file object can wait
  // in the kernel for as long as another process's I/O holds it, and a
  // process with a thread waiting there does not end when killed.
  it.live(
    "hands the pipe to none of the processes it starts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { scratch, env } = yield* newHome;
        const engine = yield* standInEngine(scratch);
        const server = yield* spawnChild(
          process.execPath,
          [SERVER, "serve", "--admin-fd", "3", "--exit-with-stdin"],
          { ...env, J3_ENGINE_BINARY: engine.command },
          "overlapped",
        );
        const pipe = server.child.stdio[3];
        if (!(pipe instanceof NodeNet.Socket)) return yield* Effect.die("no pipe at fd 3");
        const closed = new Promise<void>((resolve) => pipe.once("close", () => resolve()));
        pipe.resume();

        const started = yield* fs.readFileString(engine.started).pipe(
          Effect.flatMap(decodeStarted),
          Effect.retry(Schedule.spaced("100 millis")),
          Effect.timeoutOrElse({
            duration: WITHIN,
            orElse: () =>
              fs.exists(engine.shared).pipe(
                Effect.orElseSucceed(() => false),
                Effect.flatMap((compared) =>
                  Effect.die(
                    `the engine did not start${compared ? ", though it wrote what it shares" : ""}; the server wrote:\n${server.output()}`,
                  ),
                ),
              ),
          }),
        );
        // Both are ended, and gone, before their folder is removed: Windows
        // removes no program's file while it runs.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [started.engine, started.harness]) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // Already gone.
              }
            }
          }).pipe(
            Effect.andThen(
              Effect.sync(() => isRunning(started.engine) || isRunning(started.harness)).pipe(
                Effect.repeat({
                  while: (running) => running,
                  schedule: Schedule.spaced("100 millis"),
                }),
                Effect.timeoutOption(Duration.seconds(10)),
              ),
            ),
          ),
        );

        if (process.platform === "win32") {
          // Written before the engine started its script, which wrote `started`.
          const found = yield* fs
            .readFileString(engine.shared)
            .pipe(Effect.flatMap(decodeSharedFiles));
          if ("error" in found)
            return yield* Effect.die(`the engine could not look: ${found.error}`);
          const report = JSON.stringify(found);
          // The server's own child, which its CLI is.
          assert.strictEqual(found.parent, server.child.pid, `the engine's parent: ${report}`);
          assert.strictEqual(found.grandparent, process.pid, `the server's parent: ${report}`);
          // What the comparison finds when there is something to find.
          assert.isAbove(found.files, 0, `the engine holds no file: ${report}`);
          assert.strictEqual(
            found.withSelf,
            found.files,
            `the engine missed its own files: ${report}`,
          );
          assert.strictEqual(
            found.withParentAlone,
            0,
            `the engine holds a file the server holds and this process does not: ${report}`,
          );
        }

        server.child.kill("SIGKILL");
        yield* Effect.promise(() => closed).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () =>
              Effect.die(
                "the pipe stayed open once the server ended: a process it started holds it",
              ),
          }),
        );
        if (process.platform !== "win32") {
          assert.isTrue(isRunning(started.engine), "the stand-in engine ended with the server");
          assert.isTrue(isRunning(started.harness), "the stand-in harness ended with the server");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

  it.effect(
    "ends a start on a home another server still holds as one the app may start again after",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        yield* Home.holdHome(home);
        const held = yield* Home.holdHome(home).pipe(Effect.scoped, Effect.flip);
        const failure = startFailure(held);
        assert.notStrictEqual(failure[Runtime.errorExitCode], 78);
        assert.strictEqual(failure[CliError.userMessage], held.message);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("ends any other failure as one the app may start again after", () => {
    const failure = startFailure(
      new Migrator.MigrationError({ kind: "Failed", message: "disk I/O error" }),
    );
    assert.notStrictEqual(failure[Runtime.errorExitCode], 78);
  });
});
