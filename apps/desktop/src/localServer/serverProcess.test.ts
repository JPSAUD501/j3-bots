// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerProcess from "./serverProcess.ts";

/**
 * A stand-in for the server: it answers `/status` on fd 3 with its own pid,
 * logs to both of its outputs, and ends as `ending` says.
 */
const standIn = (ending: string) => `
import * as net from "node:net";
import * as http from "node:http";
const pipe = new net.Socket({ fd: 3, readable: true, writable: true });
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ version: "0.3.0", pid: process.pid, listener: { port: 3747 }, engine: { state: { _tag: "ready" } } }));
});
server.keepAliveTimeout = 0;
server.emit("connection", pipe);
console.log(JSON.stringify({ level: "INFO", message: "listening" }));
${ending}
`;

const setUp = (script: string, logBefore: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-process-" });
    const entry = path.join(folder, "bin.mjs");
    const logFile = path.join(folder, "server.log");
    yield* fs.writeFileString(entry, script);
    yield* fs.writeFileString(logFile, logBefore);
    const server = yield* ServerProcess.launch({
      node: process.execPath,
      entry,
      env: {},
      logFile,
      platform: process.platform,
    });
    return { server, logFile };
  });

describe("the server process", () => {
  it.live("serves its admin channel on the inherited pipe, and logs straight to its file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { server, logFile } = yield* setUp(
        standIn(
          `setTimeout(() => { console.error("Other users can open the home. Run chmod 700."); process.exit(78); }, 300);`,
        ),
        "an earlier start's line\n",
      );
      const status = yield* server.admin.status();
      assert.strictEqual(status.pid, server.pid);
      const exit = yield* server.exited;
      assert.strictEqual(exit.code, 78);
      const tail = yield* server.logTail;
      assert.notInclude(tail, "an earlier start's line");
      assert.include(tail, '"message":"listening"');
      assert.include(tail, "Other users can open the home. Run chmod 700.");
      const written = yield* fs.readFileString(logFile);
      assert.isTrue(written.startsWith("an earlier start's line\n"));
      assert.include(written, "Run chmod 700.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps only the last part of a long output, from a whole line", () =>
    Effect.gen(function* () {
      const { server } = yield* setUp(
        standIn(
          `for (let i = 0; i < 2000; i += 1) console.log("line " + i); setTimeout(() => process.exit(1), 100);`,
        ),
        "",
      );
      yield* server.exited;
      const tail = yield* server.logTail;
      assert.isAtMost(Buffer.byteLength(tail), 8192);
      assert.isTrue(tail.startsWith("line "));
      assert.isTrue(tail.trimEnd().endsWith("line 1999"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
