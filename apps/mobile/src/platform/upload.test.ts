// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The servers the upload meets are plain node:http servers on loopback.
import { assert, describe, it } from "@effect/vitest";
import type { UploadRequest } from "@j3-bots/client-runtime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeHttp from "node:http";
import { makeUploader } from "./upload.ts";

/**
 * A loopback server answering every request with `status` and `headers`, at
 * the attachments address it gives, with the bodies that reached it; closed
 * with the scope.
 */
const serve = (status: number, headers: Record<string, string> = {}) => {
  const received: Array<string> = [];
  return Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          received.push(body);
          response.writeHead(status, headers).end();
        });
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.die("not an IP listener")
        : Effect.succeed({ url: `http://127.0.0.1:${address.port}/attachments`, received });
    }),
  );
};

const upload = makeUploader(globalThis.fetch);
const request = (url: string): UploadRequest => ({
  method: "POST",
  url,
  headers: { authorization: "Bearer a-fictional-token", "content-type": "text/plain" },
  body: new Blob(["the file"], { type: "text/plain" }),
  onProgress: () => {},
});

describe("the phone's upload", () => {
  it.effect("sends the file to the server and returns where its answer came from", () =>
    Effect.gen(function* () {
      const server = yield* serve(200);
      const response = yield* upload(request(server.url));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.url, server.url);
      assert.deepStrictEqual(server.received, ["the file"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a redirect, so the file and the token never reach where it points", () =>
    Effect.gen(function* () {
      const elsewhere = yield* serve(200);
      const server = yield* serve(307, { location: elsewhere.url });
      const exit = yield* Effect.exit(upload(request(server.url)));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(elsewhere.received, []);
    }).pipe(Effect.scoped),
  );
});
