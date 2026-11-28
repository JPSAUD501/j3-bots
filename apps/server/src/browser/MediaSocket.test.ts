// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import {
  BrowserServerFrame,
  BrowserTabRef,
  HTTP_PATHS,
  SocketTicketGrant,
} from "@j3-bots/contracts";
import { makeFakePageHost } from "@j3-bots/browser/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as Listener from "../listener.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as RefusedNames from "../web/RefusedNames.ts";
import * as WebClient from "../web/WebClient.ts";
import { Browser } from "./Browser.ts";
import * as MediaSocket from "./MediaSocket.ts";
import { MAX_SOCKET_BUFFER_BYTES } from "./MediaSocket.ts";

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(BrowserServerFrame));

/** What a client's socket received: a picture, a frame, or the code it was closed with. */
type Received =
  | { readonly _tag: "picture"; readonly bytes: Uint8Array }
  | { readonly _tag: "frame"; readonly frame: BrowserServerFrame }
  | { readonly _tag: "closed"; readonly code: number };

const socketUrl = (query: string) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die("The test server listens on a TCP port");
    }
    return `ws://127.0.0.1:${address.port}${HTTP_PATHS.browser}${query}`;
  });

/** A media socket, open in the test's scope: what it received, in order, and a way to talk. */
const open = (query: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(yield* socketUrl(query), { headers }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const received = yield* Queue.unbounded<Received>();
    yield* Stream.fromEffectRepeat(reader.pull).pipe(
      Stream.flatMap((chunks) => Stream.fromIterable(chunks)),
      Stream.runForEach((chunk) =>
        Queue.offer(
          received,
          typeof chunk === "string"
            ? { _tag: "frame", frame: decodeFrame(chunk) }
            : { _tag: "picture", bytes: chunk },
        ),
      ),
      Effect.catch((error) =>
        Queue.offer(received, {
          _tag: "closed",
          code: error.reason._tag === "SocketCloseError" ? error.reason.code : 0,
        }),
      ),
      Effect.forkScoped,
    );
    /** The next message, passing over who acts on the tab and pings, which these tests do not follow. */
    const next: Effect.Effect<Received> = Effect.gen(function* () {
      while (true) {
        const message = yield* Queue.take(received);
        if (
          message._tag !== "frame" ||
          (message.frame.type !== "control" && message.frame.type !== "ping")
        ) {
          return message;
        }
      }
    });
    return {
      next,
      send: (text: string) => writer.write(text).pipe(Effect.orDie),
    };
  });

const ticketFor = (token: string) =>
  HttpClientRequest.post(HTTP_PATHS.socketTicket).pipe(
    HttpClientRequest.setHeaders({ authorization: `Bearer ${token}` }),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SocketTicketGrant)),
    Effect.map((grant) => grant.ticket),
  );

let scenes = 0;

/** Waits until `check` holds, on the real clock these tests run on. */
const until = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 500; round++) {
      if (yield* check) return;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("The condition never held");
  });

/**
 * A paired device whose app's browser is attached for the test's scope, and
 * a tab the person opened there. `picture` sets what each picture of the
 * tab's screencast holds from then on.
 */
const scene = Effect.gen(function* () {
  const n = ++scenes;
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  const paired = yield* devices.pair({ code, name: `Laptop ${n}` });
  const fake = yield* makeFakePageHost({ host: { kind: "desktop", device: paired.deviceId } });
  let jpeg: Uint8Array | null = null;
  const browser = yield* Browser;
  yield* browser.attachHost(
    {
      ...fake,
      screencast: (input) =>
        fake
          .screencast(input)
          .pipe(Stream.map((frame) => (jpeg === null ? frame : { ...frame, jpeg }))),
    },
    yield* fake.hello.pipe(Effect.orDie),
  );
  const ref = BrowserTabRef.make(`media-tab-${n}`);
  yield* browser.openForPerson({ device: paired.deviceId, ref, url: "https://example.com/" });
  const callsOf = (call: string) =>
    Effect.map(fake.calls, (calls) => calls.filter((each) => each.call === call).length);
  return {
    host: fake,
    deviceId: paired.deviceId,
    token: paired.token,
    ref,
    callsOf,
    /** Once a socket watches the tab, paints the next picture of it. */
    paint: until(Effect.map(callsOf("tab.screencast"), (count) => count > 0)).pipe(
      Effect.andThen(fake.paint(ref)),
    ),
    picture: (bytes: Uint8Array) =>
      Effect.sync(() => {
        jpeg = bytes;
      }),
  };
});

const server = Ports.serve(
  Layer.mergeAll(Http.routes, MediaSocket.route),
  NodeHttpServer.layerTest,
  { logAddress: false },
).pipe(
  Layer.provide([TestUpdates.layer, RefusedNames.layer]),
  Layer.provideMerge(TestDomain.layer),
);

it.layer(server, { excludeTestServices: true })("media socket", (it) => {
  it.effect("refuses an upgrade without a valid credential", () =>
    Effect.gen(function* () {
      const { ref } = yield* scene;
      const path = `${HTTP_PATHS.browser}?ref=${ref}`;
      const missing = yield* HttpClient.get(path);
      const wrong = yield* HttpClient.get(path, {
        headers: { authorization: "Bearer not-a-device-token" },
      });
      assert.strictEqual(missing.status, 401);
      assert.strictEqual(wrong.status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("asks a request that is no upgrade to upgrade", () =>
    Effect.gen(function* () {
      const { token, ref } = yield* scene;
      const plain = yield* HttpClient.get(`${HTTP_PATHS.browser}?ref=${ref}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(plain.status, 426);
    }).pipe(Effect.scoped),
  );

  it.effect("shows the tab to a ticket's device, once, and passes on only what decodes", () =>
    Effect.gen(function* () {
      const { token, ref, paint, callsOf, host } = yield* scene;
      const ticket = encodeURIComponent(yield* ticketFor(token));
      const client = yield* open(`?ref=${ref}&ticket=${ticket}`);

      yield* paint;
      assert.deepStrictEqual(yield* client.next, {
        _tag: "frame",
        frame: { type: "viewport", width: 1280, height: 800 },
      });
      assert.deepStrictEqual(yield* client.next, {
        _tag: "picture",
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      });

      yield* client.send("not json");
      yield* client.send(JSON.stringify({ type: "clipboard", text: "a password" }));
      yield* client.send(JSON.stringify({ type: "navigate", url: "file:///etc/passwd" }));
      yield* client.send(JSON.stringify({ type: "text", text: "hello" }));
      yield* client.send(JSON.stringify({ type: "ack" }));
      // Answered after everything sent before it.
      yield* client.send(JSON.stringify({ type: "probe", x: 1, y: 2 }));
      assert.deepStrictEqual(yield* client.next, {
        _tag: "frame",
        frame: { type: "probe", x: 1, y: 2, editable: false },
      });
      assert.strictEqual(yield* callsOf("tab.input"), 1);
      assert.strictEqual(yield* callsOf("tab.navigate"), 0);
      assert.deepStrictEqual(yield* host.acked, [{ tab: ref, frame: 1 }]);

      const replayed = yield* HttpClient.get(`${HTTP_PATHS.browser}?ref=${ref}&ticket=${ticket}`);
      assert.strictEqual(replayed.status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("closes a socket whose query is invalid, and says a tab it does not know is gone", () =>
    Effect.gen(function* () {
      const { token } = yield* scene;
      const bearer = { authorization: `Bearer ${token}` };
      const tooWide = yield* open(`?ref=tab&maxWidth=9000`, bearer);
      assert.deepStrictEqual(yield* tooWide.next, { _tag: "closed", code: 1008 });
      const unknown = yield* open(`?ref=no-such-tab`, bearer);
      assert.deepStrictEqual(yield* unknown.next, { _tag: "frame", frame: { type: "gone" } });
      assert.deepStrictEqual(yield* unknown.next, { _tag: "closed", code: 1000 });
    }).pipe(Effect.scoped),
  );

  it.effect("closes the device's sockets when it is revoked, and refuses it after", () =>
    Effect.gen(function* () {
      const { deviceId, token, ref, paint } = yield* scene;
      const bearer = { authorization: `Bearer ${token}` };
      const client = yield* open(`?ref=${ref}`, bearer);
      yield* paint;
      yield* client.next;

      yield* (yield* DeviceAuth).revoke(deviceId);

      while ((yield* client.next)._tag !== "closed") {
        // Pictures already on their way.
      }
      const refused = yield* HttpClient.get(`${HTTP_PATHS.browser}?ref=${ref}`, {
        headers: bearer,
      });
      assert.strictEqual(refused.status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a client a picture would leave owing more than its socket may hold", () =>
    Effect.gen(function* () {
      const { token, ref, paint, picture } = yield* scene;
      const client = yield* open(`?ref=${ref}`, { authorization: `Bearer ${token}` });

      const fits = new Uint8Array(MAX_SOCKET_BUFFER_BYTES / 2).fill(7);
      yield* picture(fits);
      yield* paint;
      yield* client.next;
      const shown = yield* client.next;
      assert.strictEqual(shown._tag === "picture" ? shown.bytes.byteLength : 0, fits.byteLength);
      yield* client.send(JSON.stringify({ type: "ack" }));

      yield* picture(new Uint8Array(MAX_SOCKET_BUFFER_BYTES).fill(7));
      yield* paint;
      assert.strictEqual((yield* client.next)._tag, "closed");
    }).pipe(Effect.scoped),
  );
});

// The client listener as the server runs it, whose socket server bounds what a client sends.
it.layer(
  Http.serve(Listener.layer, { logAddress: false }).pipe(
    Layer.provide([WebClient.statusLayer, RefusedNames.layer]),
    Layer.provide(TestUpdates.layer),
    Layer.provideMerge(TestDomain.servedLayer),
  ),
  { excludeTestServices: true },
)("media socket on the client listener", (it) => {
  it.effect(
    "closes a socket whose client sends a message over the limit, and keeps one at it",
    () =>
      Effect.gen(function* () {
        const { token, ref, callsOf } = yield* scene;
        const bearer = { authorization: `Bearer ${token}` };
        const client = yield* open(`?ref=${ref}`, bearer);

        // At the limit: read, found not to be a frame, and dropped.
        yield* client.send("x".repeat(Listener.MAX_SOCKET_MESSAGE_BYTES));
        yield* client.send(JSON.stringify({ type: "text", text: "hello" }));
        yield* until(Effect.map(callsOf("tab.input"), (count) => count === 1));

        yield* client.send("x".repeat(Listener.MAX_SOCKET_MESSAGE_BYTES + 1));
        assert.deepStrictEqual(yield* client.next, { _tag: "closed", code: 1009 });
      }).pipe(Effect.scoped),
  );
});
