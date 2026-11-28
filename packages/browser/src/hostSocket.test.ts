// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { BrowserTabRef } from "@j3-bots/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import { type HostSocketEnd, pageHostOnSocket, serveHostOnSocket } from "./hostSocket.ts";
import type { PageHost } from "./PageHost.ts";
import { makeFakePageHost } from "./testing/index.ts";

const TAB = BrowserTabRef.make("tab-1");

/**
 * A loopback server whose upgrade hands each socket to `accepted`, as the
 * J3 Bots server's route does, and a host that dialed it, serving a fake.
 * As the test ends the host's side lets go first, then the server's.
 */
const linked = (
  accepted: (socket: Socket.Socket) => Effect.Effect<void, never, Scope.Scope>,
  silence?: number,
) =>
  Effect.gen(function* () {
    // The server's side of each socket lets go once the test is done.
    const done = yield* Deferred.make<void>();
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const socket = yield* Effect.orDie(request.upgrade);
        yield* Effect.raceFirst(accepted(socket), Deferred.await(done));
        return HttpServerResponse.empty();
      }),
    );
    // Released before the server, which waits for its handlers.
    yield* Effect.addFinalizer(() => Deferred.succeed(done, undefined));
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address))
      return yield* Effect.die("The test server has no port.");
    const fake = yield* makeFakePageHost();
    const dialed = yield* Socket.makeWebSocket(`ws://127.0.0.1:${address.port}/`).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    const serving: Fiber.Fiber<HostSocketEnd> = yield* Effect.acquireRelease(
      Effect.forkDetach(serveHostOnSocket(fake, dialed, { silence })),
      (fiber) => Fiber.interrupt(fiber),
    );
    return { fake, serving };
  });

const withServer = <A, E>(effect: Effect.Effect<A, E, HttpServer.HttpServer | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(NodeHttpServer.layerTest)));

it.live("answers the server's calls and streams its events over the socket it dialed", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<PageHost>();
    const { fake } = yield* linked((socket) =>
      Effect.gen(function* () {
        const { host } = yield* pageHostOnSocket(socket);
        yield* Deferred.succeed(reached, host);
        return yield* Effect.never;
      }),
    );
    const host = yield* Deferred.await(reached);
    const page = yield* host.open({
      tab: TAB,
      url: "https://example.test/",
      background: false,
      private: false,
    });
    assert.strictEqual(page.tab, TAB);
    const event = yield* host.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
    // Until the call reaches the host, what it sends would be lost.
    while (!(yield* fake.calls).some(({ call }) => call === "host.events")) yield* Effect.yieldNow;
    yield* host.navigate({ tab: TAB, to: { kind: "url", url: "https://example.test/two" } });
    const [changed] = yield* Fiber.join(event);
    assert.strictEqual(changed?.type, "tab.changed");
  }).pipe(withServer),
);

it.live("ends when the server closes the socket, so the host dials again", () =>
  Effect.gen(function* () {
    const { serving } = yield* linked((socket) =>
      Effect.gen(function* () {
        // The handshake completes as the server starts reading.
        yield* socket.reader;
        const writer = yield* socket.writer;
        yield* writer.write(new Socket.CloseEvent(1000));
      }).pipe(Effect.ignore),
    );
    assert.strictEqual(yield* Fiber.join(serving), "closed");
  }).pipe(withServer),
);

it.live("ends when the server falls silent, though the socket stays open", () =>
  Effect.gen(function* () {
    // The server holds the socket open and never writes: no ping comes.
    const { serving } = yield* linked(
      (socket) => Effect.andThen(socket.reader, Effect.never).pipe(Effect.ignore),
      1_500,
    );
    assert.strictEqual(yield* Fiber.join(serving), "silent");
  }).pipe(withServer),
);
