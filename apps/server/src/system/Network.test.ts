// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The guard acts on Node's own server and sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import { ServerOrigin } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  guardConnections,
  isPrivateAddress,
  isServedHost,
  Network,
  reachableOrigins,
} from "./Network.ts";

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

it.effect(
  "offers the private addresses of real interfaces for every interface, and names over HTTPS",
  () =>
    Effect.gen(function* () {
      const lan = { scheme: "http", address: "0.0.0.0", port: 3737, names: [] } as const;
      assert.deepStrictEqual(yield* reachableOrigins(lan, Option.none()), [
        "http://192.168.0.20:3737",
        "http://10.0.0.7:3737",
      ]);
      assert.deepStrictEqual(
        yield* reachableOrigins({ ...lan, address: "192.168.0.20" }, Option.none()),
        ["http://192.168.0.20:3737"],
      );
      const https = { scheme: "https", address: "0.0.0.0", names: ["j3.example.com"] } as const;
      assert.deepStrictEqual(yield* reachableOrigins({ ...https, port: 8443 }, Option.none()), [
        "https://j3.example.com:8443",
      ]);
      // As a browser writes it, so a link carries the origin a page there has.
      assert.deepStrictEqual(yield* reachableOrigins({ ...https, port: 443 }, Option.none()), [
        "https://j3.example.com",
      ]);
      assert.deepStrictEqual(
        yield* reachableOrigins({ ...https, port: 443, names: [] }, Option.none()),
        [],
      );

      // A public origin comes first, and once.
      const reached = (origin: string) => Option.some(ServerOrigin.make(origin));
      assert.deepStrictEqual(yield* reachableOrigins(lan, reached("https://bots.example.com")), [
        "https://bots.example.com",
        "http://192.168.0.20:3737",
        "http://10.0.0.7:3737",
      ]);
      assert.deepStrictEqual(
        yield* reachableOrigins({ ...https, port: 443 }, reached("https://j3.example.com")),
        ["https://j3.example.com"],
      );
    }).pipe(
      Effect.provideService(
        Network,
        Network.of({
          ipv4Addresses: Effect.succeed([
            { interface: "lo", address: "127.0.0.1", internal: true },
            { interface: "eth0", address: "192.168.0.20", internal: false },
            { interface: "docker0", address: "172.17.0.1", internal: false },
            { interface: "wlan0", address: "10.0.0.7", internal: false },
          ]),
        }),
      ),
    ),
);

it.effect("serves a Host no web page can rebind to this machine, and no other", () =>
  Effect.sync(() => {
    const none = Option.none();
    for (const host of [
      "127.0.0.1:3737",
      "LOCALHOST:3737",
      "[::1]:3737",
      "[::ffff:127.0.0.1]:3737",
      // The Android emulator's alias for its host's loopback.
      "10.0.2.2:3737",
      "100.101.102.103:3737",
      // Through a proxy on another port.
      "127.0.0.1:8080",
      "localhost",
    ]) {
      assert.isTrue(isServedHost(host, none), host);
    }
    for (const host of [
      undefined,
      "",
      "evil.example:3737",
      // Names that resolve to loopback are names all the same.
      "127.0.0.1.nip.io:3737",
      "localhost.evil.example:3737",
      // Only an authority: a user or a path could hide a name before an address.
      "evil.example@127.0.0.1:3737",
      "127.0.0.1:3737/evil.example",
      "127.0.0.1:99999",
      "::1",
    ]) {
      assert.isFalse(isServedHost(host, none), String(host));
    }
    const behindProxy = Option.some(ServerOrigin.make("https://bots.example.com"));
    assert.isTrue(isServedHost("bots.example.com", behindProxy));
    assert.isTrue(isServedHost("Bots.Example.com:8443", behindProxy));
    assert.isFalse(isServedHost("bots.example.com.evil.example", behindProxy));
  }),
);
