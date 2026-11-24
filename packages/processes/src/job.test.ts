// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The launcher is a real program on disk, started as the server starts it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { inJob, jobLauncher } from "./job.ts";

/** A compile can take a while on a busy computer. */
const SLOW = 120_000;

const ARGS = ["plain", String.raw`C:\Users\Sam Lee\J3 Bots`, 'a "quoted" word', "", "C:\\ends\\"];

/** Runs `program` through the launcher in relay mode with `input`; what it wrote, and its exit code. */
const relay = (launcher: string, input: string) =>
  new Promise<{ readonly output: string; readonly code: number | null }>((resolve) => {
    const { command, args } = inJob(
      launcher,
      process.execPath,
      [
        "-e",
        `let read = ""; process.stdin.on("data", (chunk) => { read += chunk; });
         process.stdin.on("end", () => { process.stdout.write(JSON.stringify([read, process.argv.slice(1)])); process.exit(3); });`,
        ...ARGS,
      ],
      "relay",
    );
    const child = NodeChildProcess.spawn(command, [...args], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ output, code }));
    child.stdin.end(input);
  });

describe.runIf(process.platform === "win32")("jobLauncher", () => {
  it(
    "compiles the launcher once, for every start that asks at the same time and every later one",
    async () => {
      const home = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "j3-job-"));
      const environment = { ...process.env, LOCALAPPDATA: home };
      const [first, second] = await Promise.all([
        jobLauncher(environment),
        jobLauncher(environment),
      ]);
      assert.strictEqual(first, second);
      const compiled = (await NodeFs.stat(first)).mtimeMs;
      assert.strictEqual(await jobLauncher(environment), first);
      assert.strictEqual((await NodeFs.stat(first)).mtimeMs, compiled);
      // Nothing of the compile is left beside it.
      assert.deepStrictEqual(await NodeFs.readdir(NodePath.dirname(first)), [
        NodePath.basename(first),
      ]);

      const { output, code } = await relay(first, "from the caller");
      assert.deepStrictEqual(JSON.parse(output), ["from the caller", ARGS]);
      assert.strictEqual(code, 3);
    },
    SLOW,
  );
});
