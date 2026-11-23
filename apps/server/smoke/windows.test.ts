// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The server is started as the desktop app starts it: with node:child_process, a pipe at fd 3 and stdin as its lifeline.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { CommandId, type EngineStatus, HTTP_PATHS, J3Rpcs } from "@j3-bots/contracts";
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
// scripted agent, which starts a stand-in harness that runs until it is
// ended. Then only the engine is ended, as in a crash: the harness must go
// with it, and the engine come back. The server is run twice on the same
// home, stopped once by `/shutdown` and once by the end of its stdin, as the
// desktop app stops it; each time no process the server started is left.
// Needs the built server's entry point in J3_SERVER_ENTRY and the network, to
// download the engine.

const ENGINE_READY_WITHIN = Duration.minutes(3);
const TURN_WITHIN = Duration.minutes(1);
const STOPPED_WITHIN = Duration.seconds(60);
const GONE_WITHIN = Duration.seconds(15);

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

/** The processes whose command line has `text` in it. */
const running = (table: typeof Processes.Type, text: string) =>
  table
    .filter(({ commandLine }) => commandLine !== null && commandLine.includes(text))
    .map(({ pid }) => pid);

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

/** Which of `pids` still run once they had `GONE_WITHIN` to end. */
const leftRunning = (pids: Iterable<number>) => {
  const all = [...pids];
  return Effect.sync(() => all.filter(isRunning)).pipe(
    Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: (left) => left.length === 0 }),
    Effect.timeoutOption(GONE_WITHIN),
    Effect.map(Option.getOrElse(() => all.filter(isRunning))),
  );
};

/**
 * The scripted agent, started through a file that first starts the stand-in
 * harness: a process that runs until it is ended, with `marker` in its
 * command line, which the agent does not wait for or end.
 */
const agentWithHarness = (agent: string, marker: string) => `
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(marker)}], {
  stdio: "ignore",
  detached: true,
}).unref();
await import(pathToFileURL(${JSON.stringify(agent)}).href);
`;

const services = AdminClient.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe.runIf(process.platform === "win32")("the server on Windows", () => {
  it.live(
    "runs as the desktop's child: the engine, its device, a bot's turn, a crash of the engine, and stops that leave nothing",
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
        const marker = `j3-smoke-harness-${path.basename(scratch)}`;
        const agent = path.join(scratch, "agent-with-harness.mjs");
        yield* fs.writeFileString(agent, agentWithHarness(path.resolve(SCRIPTED_AGENT), marker));
        const env = {
          ...process.env,
          J3_HOME: home,
          J3_HOST: "127.0.0.1",
          J3_PORT: String(yield* freePort),
          J3_TOOL_PORT: String(yield* freePort),
          J3_ENGINE_PORT: String(yield* freePort),
          J3_SCRIPTED_AGENT: agent,
        };
        const port = Number(env.J3_PORT);
        const botCommand = CommandId.make("windows-smoke-bot");
        let messages = 0;

        /** One run of the server, from its start to its stop by `stopBy`. */
        const run = (stopBy: "shutdown" | "stdin") =>
          Effect.gen(function* () {
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

            /** Whether the engine is ready, with the scripted agent. */
            const isReady = (current: EngineStatus) =>
              current.state._tag === "ready" &&
              current.providers.some(
                (provider) => provider.id === "scripted" && provider.status._tag === "ready",
              );
            const ready = (skipFirst: boolean) =>
              client["engine.subscribe"]().pipe(
                skipFirst ? Stream.dropWhile(isReady) : (stream) => stream,
                Stream.filter(isReady),
                Stream.runHead,
                Effect.timeoutOrElse({
                  duration: ENGINE_READY_WITHIN,
                  orElse: () =>
                    Effect.die(`the engine was not ready; the server wrote:\n${output}`),
                }),
                Effect.flatMap((found) => Effect.fromOption(found)),
              );

            // The pinned engine, downloaded as a zip and unpacked by the server the
            // first time, ready with the scripted agent.
            yield* ready(false);
            const bot = yield* client["bot.create"]({ commandId: botCommand, name: "Smoke" });
            const target = { _tag: "conversation", botId: bot.id } as const;

            /** One turn, through the engine. */
            const turn = Effect.gen(function* () {
              const text = `Hello${++messages}`;
              const reply = yield* client["entries.subscribe"]({ target, after: null }).pipe(
                Stream.flatMap((frame) =>
                  Stream.fromIterable(frame._tag === "snapshot" ? frame.entries : frame.upsert),
                ),
                Stream.filter(
                  (entry) =>
                    entry._tag === "message" && entry.author._tag === "bot" && entry.text === text,
                ),
                Stream.runHead,
                Effect.forkScoped,
              );
              yield* client["message.send"]({
                commandId: CommandId.make(`windows-smoke-message-${messages}`),
                target,
                text: `[[script:speak text=${text}]]`,
                attachments: [],
              });
              assert.isTrue(
                Option.isSome(yield* Fiber.join(reply).pipe(Effect.timeout(TURN_WITHIN))),
                output,
              );
            });
            yield* turn;

            // The engine among what the server started, and the stand-in harness under it.
            const before = yield* processTable;
            const startedBefore = descendantsOf(serverPid, before);
            // The engine is the `t3.exe` the server started whose parent is no `t3.exe` itself.
            const t3 = new Set(running(before, "t3.exe").filter((pid) => startedBefore.has(pid)));
            const [engine, ...others] = before
              .filter(({ pid, parent }) => t3.has(pid) && !t3.has(parent))
              .map(({ pid }) => pid);
            if (engine === undefined || others.length > 0)
              return yield* Effect.die("the server does not run exactly one engine");
            const harnesses = running(before, marker);
            assert.isNotEmpty(harnesses, "the stand-in harness does not run");

            // Only the engine ends, as in a crash: what it started goes with it,
            // and the server starts it again.
            const back = yield* Effect.forkScoped(ready(true));
            yield* Effect.sync(() => process.kill(engine, "SIGKILL"));
            assert.deepStrictEqual(
              yield* leftRunning(harnesses),
              [],
              "a harness outlived the engine",
            );
            yield* Fiber.join(back);
            yield* turn;

            const after = yield* processTable;
            const started = new Set([...startedBefore, ...descendantsOf(serverPid, after)]);
            const harnessesAfter = running(after, marker);
            assert.isNotEmpty(harnessesAfter, "the engine started again runs no stand-in harness");

            // Stopped as the desktop stops it.
            if (stopBy === "shutdown") assert.isTrue(Option.isSome(yield* admin.shutdown(pipe)));
            else yield* Effect.sync(() => child.stdin?.end());
            const code = yield* Effect.promise(() => exited).pipe(
              Effect.timeoutOrElse({
                duration: STOPPED_WITHIN,
                orElse: () => Effect.die(`the server did not stop; it wrote:\n${output}`),
              }),
            );
            assert.strictEqual(code, 0, output);
            assert.deepStrictEqual(yield* leftRunning([...started, ...harnessesAfter]), []);
            const holdsHome = (yield* processTable).filter(
              ({ commandLine }) =>
                commandLine !== null && commandLine.toLowerCase().includes(home.toLowerCase()),
            );
            assert.deepStrictEqual(holdsHome, []);
          }).pipe(Effect.scoped);

        yield* run("shutdown");
        yield* run("stdin");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: Duration.toMillis(Duration.minutes(15)) },
  );
});
