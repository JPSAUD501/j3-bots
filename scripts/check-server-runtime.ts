// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off -- a build script run by plain Node, outside any Effect program.
//
// Checks the server runtime a desktop package carries, on the machine it is
// for, as the release and CI run it once the package is built:
//
//   node scripts/check-server-runtime.ts <folder> --version <version>
//
// - its files and release.json, as the packaging hook checks them, for this
//   machine's platform and J3 Bots <version>;
// - its Node runs and is the pinned release;
// - the server on it prints `j3-bots v<version>` for --version;
// - the server starts: it answers /health, then stops when its stdin ends,
//   as the desktop app stops the server it runs (`--exit-with-stdin`), on
//   Windows too, where a signal would end it without running its finalizers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";
import * as NodeUtil from "node:util";
import {
  checkServerRuntime,
  hostPlatform,
  nodeExecutable,
  platformBuild,
} from "./release-layout.ts";

/**
 * How long the server may take to answer /health, and then to stop. A server
 * still running 15 s after its stop began writes what keeps it running, which
 * a stop that times out here prints with the rest of what it wrote.
 */
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

const { values, positionals } = NodeUtil.parseArgs({
  options: { version: { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const [folder] = positionals;
const version = values.version;
if (folder === undefined || positionals.length !== 1 || version === undefined) {
  throw new Error(
    "Usage: node scripts/check-server-runtime.ts <folder> --version <version>, with J3 Bots' version, such as 0.3.0.",
  );
}
const platform = hostPlatform();
if (platform === undefined || !platformBuild(platform).serverRuntime) {
  throw new Error(
    `No server runtime runs on this machine (${process.platform}-${process.arch}), so there is none to check here.`,
  );
}

const manifest = checkServerRuntime(folder, { platform, version });
const node = nodeExecutable(folder, platform);
const bin = NodePath.join(folder, "server", "bin.mjs");

const expectPrinted = (what: string, args: ReadonlyArray<string>, expected: string) => {
  const printed = NodeChildProcess.execFileSync(node, args, { encoding: "utf8" }).trim();
  if (printed !== expected) {
    throw new Error(`${what} printed '${printed}' for --version, not '${expected}'.`);
  }
  console.log(`${what}: ${printed}`);
};
expectPrinted("Its Node", ["--version"], `v${manifest.node}`);
expectPrinted("Its server", [bin, "--version"], `j3-bots v${version}`);

/** Ports no one listens on now, held together while they are found so that each differs. */
const freePorts = async (count: number) => {
  const servers = Array.from({ length: count }, () => NodeNet.createServer());
  const ports = await Promise.all(
    servers.map(
      (server) =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address !== null && typeof address === "object") resolve(address.port);
            else reject(new Error("A port listened on has no address."));
          });
        }),
    ),
  );
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  return ports;
};

const answers = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
};

/** Starts the server, waits for it to answer /health, and stops it as the desktop app does. */
const checkStarts = async () => {
  // A home of its own, so that the check leaves nothing behind on the machine.
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j3-runtime-"));
  try {
    const [port, toolPort, enginePort] = await freePorts(3);
    const server = NodeChildProcess.spawn(node, [bin, "serve", "--exit-with-stdin"], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        J3_HOME: NodePath.join(home, "j3"),
        J3_HOST: "127.0.0.1",
        J3_PORT: String(port),
        J3_TOOL_PORT: String(toolPort),
        J3_ENGINE_PORT: String(enginePort),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    server.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    server.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<string>((resolve) =>
      server.once("exit", (code, signal) => resolve(signal ?? `code ${code}`)),
    );
    const failed = (problem: string) =>
      new Error(`The server ${problem}. It wrote:\n${output.trimEnd() || "(nothing)"}`);

    const started = Date.now();
    while (!(await answers(`http://127.0.0.1:${port}/health`))) {
      const ended = await Promise.race([exited, NodeTimers.setTimeout(100, undefined)]);
      if (ended !== undefined) throw failed(`exited (${ended}) before it answered /health`);
      if (Date.now() - started > START_TIMEOUT_MS) {
        server.kill("SIGKILL");
        throw failed(`did not answer /health within ${START_TIMEOUT_MS / 1000} s`);
      }
    }
    const answered = Date.now() - started;

    const stopping = Date.now();
    server.stdin.end();
    const how = await Promise.race([exited, NodeTimers.setTimeout(STOP_TIMEOUT_MS, "timeout")]);
    if (how === "timeout") {
      server.kill("SIGKILL");
      throw failed(`did not stop within ${STOP_TIMEOUT_MS / 1000} s of its stdin's end`);
    }
    if (how !== "code 0") throw failed(`stopped with ${how} when its stdin ended, not code 0`);
    console.log(
      `Its server started: /health answered ${answered} ms after it was run, and it stopped (${how}) ${Date.now() - stopping} ms after its stdin ended.`,
    );
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
};

await checkStarts();
