// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The server is started as the desktop app starts it: with node:child_process, a pipe at fd 3 and stdin as its lifeline.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { CommandId, HTTP_PATHS, J3Rpcs } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as AdminClient from "../src/admin/AdminClient.ts";
import { runPowerShell } from "../src/system/PowerShell.ts";
import { freePort } from "./host.ts";

// The server on Windows, run as the desktop app runs it: the built server on
// the Node J3 Bots pins, started by a Node parent that holds its stdin and a
// pipe at fd 3, its only admin channel there. Its home is named by its 8.3
// short name, as `%TEMP%` is under a profile whose name is long or has a
// space. It downloads the pinned engine and starts it; the parent gets the
// desktop's device over the pipe; a bot answers through the engine, from the
// scripted agent; `/shutdown` stops the server; and no process the server
// started is left. Needs the built server's entry point in J3_SERVER_ENTRY and
// the network, to download the engine.

const ENGINE_READY_WITHIN = Duration.minutes(3);
const TURN_WITHIN = Duration.minutes(1);
const STOPPED_WITHIN = Duration.seconds(60);

const SCRIPTED_AGENT = `${import.meta.dirname}/../../../packages/engine-t3/scripted-agent/agent.ts`;

const Processes = Schema.Array(
  Schema.Struct({ pid: Schema.Int, parent: Schema.Int, commandLine: Schema.NullOr(Schema.String) }),
);
const decodeProcesses = Schema.decodeUnknownEffect(Schema.fromJsonString(Processes));

/** Every process on the machine, with its parent and its command line. */
const processTable = runPowerShell(
  `$found = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {
  [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; commandLine = $_.CommandLine }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $found -Depth 3 -Compress))`,
  {},
).pipe(Effect.flatMap(decodeProcesses));

/** The processes `root` started, and theirs, by pid. */
const descendantsOf = (root: number, table: typeof Processes.Type) => {
  const found = new Set<number>();
  let added = true;
  while (added) {
    added = false;
    for (const { pid, parent } of table) {
      if (!found.has(pid) && (parent === root || found.has(parent))) {
        found.add(pid);
        added = true;
      }
    }
  }
  return found;
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const services = AdminClient.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe.runIf(process.platform === "win32")("the server on Windows", () => {
  it.live(
    "runs as the desktop's child: the engine, its device, a bot's turn, and a stop that leaves nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const admin = yield* AdminClient.AdminClient;
        const entry = yield* Config.String("J3_SERVER_ENTRY");
        const scratch = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "j3-windows-" }),
        );
        const long = path.join(scratch, "a folder with a long name");
        yield* fs.makeDirectory(long);
        const short = (yield* (yield* ChildProcessSpawner.ChildProcessSpawner).string(
          ChildProcess.make(`for %I in ("${long}") do @echo %~sI`, { shell: true }),
        )).trim();
        assert.notStrictEqual(short.toLowerCase(), long.toLowerCase(), "no 8.3 names here");
        const home = path.join(short, "j3");
        const port = yield* freePort;
        const env = {
          ...process.env,
          J3_HOME: home,
          J3_HOST: "127.0.0.1",
          J3_PORT: String(port),
          J3_TOOL_PORT: String(yield* freePort),
          J3_ENGINE_PORT: String(yield* freePort),
          J3_SCRIPTED_AGENT: path.resolve(SCRIPTED_AGENT),
        };

        let output = "";
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(
              process.execPath,
              [entry, "serve", "--admin-fd", "3", "--exit-with-stdin"],
              { env, stdio: ["pipe", "pipe", "pipe", "overlapped"] },
            ),
          ),
          (started) => Effect.sync(() => started.exitCode === null && started.kill()),
        );
        child.stdout?.on("data", (chunk) => (output += String(chunk)));
        child.stderr?.on("data", (chunk) => (output += String(chunk)));
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
        const end = child.stdio[3];
        if (!(end instanceof NodeNet.Socket))
          return yield* Effect.die("the child has no pipe at fd 3");
        const pipe = yield* AdminClient.openPipe(end);
        const serverPid = child.pid;
        if (serverPid === undefined)
          return yield* Effect.die(`the server did not start:\n${output}`);

        // No admin socket on Windows: the pipe is the only admin channel.
        const status = yield* admin
          .status(pipe, { within: Duration.minutes(1) })
          .pipe(Effect.flatMap((found) => Effect.fromOption(found)));
        assert.strictEqual(status.pid, serverPid, output);
        assert.isFalse(yield* fs.exists(path.join(home, "admin.sock")));

        // The desktop's device, without a code.
        const device = yield* admin
          .localDevice(pipe, { name: "This computer", replaces: null })
          .pipe(Effect.flatMap((found) => Effect.fromOption(found)));
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(
              NodeSocket.layerWebSocket(`ws://127.0.0.1:${port}${HTTP_PATHS.rpc}`, {
                headers: { authorization: `Bearer ${device.token}` },
              }),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        );
        const client = yield* RpcClient.make(J3Rpcs).pipe(Effect.provide(protocol));

        // The pinned engine, downloaded as a zip and unpacked by the server, ready with the scripted agent.
        yield* client["engine.subscribe"]().pipe(
          Stream.filter(
            (current) =>
              current.state._tag === "ready" &&
              current.providers.some(
                (provider) => provider.id === "scripted" && provider.status._tag === "ready",
              ),
          ),
          Stream.runHead,
          Effect.timeoutOrElse({
            duration: ENGINE_READY_WITHIN,
            orElse: () => Effect.die(`the engine was not ready; the server wrote:\n${output}`),
          }),
          Effect.flatMap((found) => Effect.fromOption(found)),
        );

        // One turn, through the engine.
        const bot = yield* client["bot.create"]({
          commandId: CommandId.make("windows-smoke-bot"),
          name: "Smoke",
        });
        const target = { _tag: "conversation", botId: bot.id } as const;
        const reply = yield* client["entries.subscribe"]({ target, after: null }).pipe(
          Stream.flatMap((frame) =>
            Stream.fromIterable(frame._tag === "snapshot" ? frame.entries : frame.upsert),
          ),
          Stream.filter(
            (entry) =>
              entry._tag === "message" && entry.author._tag === "bot" && entry.text === "Hello",
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* client["message.send"]({
          commandId: CommandId.make("windows-smoke-message"),
          target,
          text: "[[script:speak text=Hello]]",
          attachments: [],
        });
        assert.isTrue(Option.isSome(yield* Fiber.join(reply).pipe(Effect.timeout(TURN_WITHIN))));

        // What the server started, the engine first among them.
        const table = yield* processTable;
        const started = descendantsOf(serverPid, table);
        assert.isTrue(
          table.some(
            ({ pid, commandLine }) =>
              started.has(pid) && commandLine !== null && commandLine.includes("t3.exe"),
          ),
          "the engine is not among the server's processes",
        );

        // Stopped through the admin channel, as the desktop stops it.
        assert.isTrue(Option.isSome(yield* admin.shutdown(pipe)));
        const code = yield* Effect.promise(() => exited).pipe(
          Effect.timeoutOrElse({
            duration: STOPPED_WITHIN,
            orElse: () => Effect.die(`the server did not stop; it wrote:\n${output}`),
          }),
        );
        assert.strictEqual(code, 0, output);
        const left = yield* Effect.sync(() => [...started].filter(isRunning)).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (pids) => pids.length === 0,
          }),
          Effect.timeoutOption("10 seconds"),
        );
        assert.deepStrictEqual(
          Option.getOrElse(left, () => [...started].filter(isRunning)),
          [],
        );
        const holdsHome = (yield* processTable).filter(
          ({ commandLine }) =>
            commandLine !== null && commandLine.toLowerCase().includes(home.toLowerCase()),
        );
        assert.deepStrictEqual(holdsHome, []);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(Duration.minutes(10)) },
  );
});
