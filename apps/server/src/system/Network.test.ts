// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The guard acts on Node's own server and sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { guardConnections, isPrivateAddress } from "./Network.ts";

/**
 * What a client that sends a request to a guarded server reads back, and
 * whether the server's handler ever saw the request.
 */
const exchange = (allows: (localAddress: string) => boolean) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => response.end("served"));
      guardConnections(server, allows);
      server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.flatMap((server) =>
      Effect.callback<string>((resume) => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        let received = "";
        const socket = NodeNet.connect({ host: "127.0.0.1", port }, () =>
          socket.write("GET / HTTP/1.1\r\nHost: j3\r\nConnection: close\r\n\r\n"),
        );
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString();
        });
        socket.on("error", () => undefined);
        socket.on("close", () => resume(Effect.succeed(received)));
        return Effect.sync(() => socket.destroy());
      }),
    ),
    Effect.scoped,
  );

it.effect("closes, unread, a connection that reached an address plain HTTP must not serve", () =>
  Effect.gen(function* () {
    assert.include(yield* exchange(isPrivateAddress), "served");
    assert.strictEqual(yield* exchange(() => false), "");
  }),
);

it.effect("judges an IPv4-mapped address, as a dual-stack socket reports it, as IPv4", () =>
  Effect.sync(() => {
    assert.isTrue(isPrivateAddress("::ffff:10.0.0.4"));
    assert.isFalse(isPrivateAddress("::ffff:198.51.100.4"));
  }),
);
