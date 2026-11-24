// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import {
  BrowserServerFrame,
  type BrowserTabRef,
  CommandId,
  HTTP_PATHS,
  SocketTicketGrant,
} from "@j3-bots/contracts";
import { EngineTabId } from "@j3-bots/engine-t3";
import { TestBrowserControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { Bots } from "../bots/Bots.ts";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import { engineSession } from "../testing/turns.ts";
import { BrowserTabs } from "./BrowserTabs.ts";
import * as MediaSocket from "./MediaSocket.ts";

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
    return {
      next: Queue.take(received),
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

/** A paired device, and a bot with one tab open, which the server has listed. */
const scene = Effect.gen(function* () {
  const n = ++scenes;
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  const paired = yield* devices.pair({ code, name: `Laptop ${n}` });
  const bot = yield* (yield* Bots).create({
    commandId: CommandId.make(`create-${n}`),
    draft: { name: `Scout ${n}` },
  });
  const session = yield* engineSession(bot.id);
  const browser = yield* TestBrowserControl;
  yield* browser.setTabs([
    {
      id: EngineTabId.make(`tab-${n}`),
      sessionId: session,
      url: "https://example.com/",
      title: "Example",
      loading: false,
      activeAt: n,
    },
  ]);
  const listed = yield* (yield* BrowserTabs).subscribe(bot.id, paired.deviceId).pipe(
    Stream.filter((frame) => frame.tabs.length === 1),
    Stream.runHead,
    Effect.orDie,
  );
  const tab = Option.getOrThrow(listed).tabs[0];
  if (tab === undefined) return yield* Effect.die("The bot's tab is listed");
  const ref: BrowserTabRef = tab.ref;
  return { browser, deviceId: paired.deviceId, token: paired.token, ref };
});

const server = Ports.serve(
  Layer.mergeAll(Http.routes, MediaSocket.route),
  NodeHttpServer.layerTest,
  { logAddress: false },
).pipe(Layer.provide(TestUpdates.layer), Layer.provideMerge(TestDomain.layer));

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
    }),
  );

  it.effect("shows the tab to a ticket's device, once, and passes on only what decodes", () =>
    Effect.gen(function* () {
      const { browser, token, ref } = yield* scene;
      const ticket = encodeURIComponent(yield* ticketFor(token));
      const client = yield* open(`?ref=${ref}&ticket=${ticket}`);
      const viewer = yield* browser.nextViewer;

      const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
      yield* viewer.emit({ _tag: "viewport", width: 1280, height: 800 });
      yield* viewer.emit({ _tag: "frame", jpeg });
      assert.deepStrictEqual(yield* client.next, {
        _tag: "frame",
        frame: { type: "viewport", width: 1280, height: 800 },
      });
      assert.deepStrictEqual(yield* client.next, { _tag: "picture", bytes: jpeg });

      yield* client.send("not json");
      yield* client.send(JSON.stringify({ type: "clipboard", text: "a password" }));
      yield* client.send(JSON.stringify({ type: "navigate", url: "file:///etc/passwd" }));
      yield* client.send(JSON.stringify({ type: "text", text: "hello" }));
      yield* client.send(JSON.stringify({ type: "ack" }));
      yield* viewer.emit({ _tag: "viewport", width: 1280, height: 800 });
      yield* client.next;
      assert.deepStrictEqual(yield* viewer.inputs, [{ type: "text", text: "hello" }]);
      assert.strictEqual(yield* viewer.acks, 1);

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
      const { browser, deviceId, token, ref } = yield* scene;
      const bearer = { authorization: `Bearer ${token}` };
      const client = yield* open(`?ref=${ref}`, bearer);
      const viewer = yield* browser.nextViewer;

      yield* (yield* DeviceAuth).revoke(deviceId);

      assert.deepStrictEqual(yield* client.next, { _tag: "closed", code: 1008 });
      yield* viewer.released;
      const refused = yield* HttpClient.get(`${HTTP_PATHS.browser}?ref=${ref}`, {
        headers: bearer,
      });
      assert.strictEqual(refused.status, 401);
    }).pipe(Effect.scoped),
  );
});
