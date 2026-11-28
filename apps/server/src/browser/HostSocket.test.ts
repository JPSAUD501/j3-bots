// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { serveHostOnSocket } from "@j3-bots/browser";
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import {
  BROWSER_HOST_PROTOCOL_VERSION,
  BrowserTabRef,
  type DeviceId,
  HTTP_PATHS,
  SocketTicketGrant,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as RefusedNames from "../web/RefusedNames.ts";
import { Browser } from "./Browser.ts";
import * as HostSocket from "./HostSocket.ts";

// The page host socket as a desktop app's browser reaches it: the real
// route, over a real socket, with a fake host at the other end.

let devicesPaired = 0;

/** A newly paired device and its token. */
const pairedDevice = Effect.gen(function* () {
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  return yield* devices.pair({ code, name: `Laptop ${++devicesPaired}` });
});

/** A fake desktop host for `device` with one tab open, named `tab`. */
const desktopWithTab = (device: DeviceId, tab: BrowserTabRef) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePageHost({ host: { kind: "desktop", device } });
    yield* fake.open({ tab, background: false, private: false });
    return fake;
  });

/** `host` dials the route with `token` as a bearer and serves the server until the socket ends. */
const dial = (host: FakePageHost, token: string) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address))
      return yield* Effect.die("The test server has no port.");
    const socket = yield* Socket.makeWebSocket(
      `ws://127.0.0.1:${address.port}${HTTP_PATHS.browserHost}`,
      { headers: { authorization: `Bearer ${token}` } },
    ).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
    return yield* serveHostOnSocket(host, socket).pipe(Effect.forkScoped);
  });

/** Whether the tab is listed now. */
const listed = (tab: BrowserTabRef) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const all = yield* browser.all.pipe(Stream.runHead);
    return all._tag === "Some" && all.value.tabs.some((each) => each.ref === tab);
  });

/** Waits until `check` holds, on the real clock these tests run on. */
const until = <R>(check: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 500; round++) {
      if (yield* check) return;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("The condition never held");
  });

const server = Ports.serve(
  Layer.mergeAll(Http.routes, HostSocket.route),
  NodeHttpServer.layerTest,
  {
    logAddress: false,
  },
).pipe(
  Layer.provide([TestUpdates.layer, RefusedNames.layer]),
  Layer.provideMerge(TestDomain.layer),
);

it.layer(server, { excludeTestServices: true })("page host socket", (it) => {
  it.effect("takes a device token as a bearer only, and asks a plain request to upgrade", () =>
    Effect.gen(function* () {
      const { token } = yield* pairedDevice;
      const missing = yield* HttpClient.get(HTTP_PATHS.browserHost);
      const wrong = yield* HttpClient.get(HTTP_PATHS.browserHost, {
        headers: { authorization: "Bearer not-a-device-token" },
      });
      const ticket = yield* HttpClientRequest.post(HTTP_PATHS.socketTicket).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${token}` }),
        HttpClient.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SocketTicketGrant)),
      );
      const byTicket = yield* HttpClient.get(
        `${HTTP_PATHS.browserHost}?ticket=${encodeURIComponent(ticket.ticket)}`,
      );
      const plain = yield* HttpClient.get(HTTP_PATHS.browserHost, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.deepStrictEqual(
        [missing.status, wrong.status, byTicket.status, plain.status],
        [401, 401, 401, 426],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("lists the tabs of the device's own desktop, until the device is revoked", () =>
    Effect.gen(function* () {
      const { deviceId, token } = yield* pairedDevice;
      const tab = BrowserTabRef.make("host-own-tab");
      const host = yield* desktopWithTab(deviceId, tab);
      const serving = yield* dial(host, token);
      yield* until(listed(tab));

      yield* (yield* DeviceAuth).revoke(deviceId);
      assert.strictEqual(yield* Fiber.join(serving), "closed");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "closes a host that says it is another device's desktop, or the server's, before listing a tab",
    () =>
      Effect.gen(function* () {
        const own = yield* pairedDevice;
        const other = yield* pairedDevice;
        const asOther = BrowserTabRef.make("host-as-other");
        const pretender = yield* desktopWithTab(other.deviceId, asOther);
        assert.strictEqual(yield* Fiber.join(yield* dial(pretender, own.token)), "closed");

        const asServer = BrowserTabRef.make("host-as-server");
        const fake = yield* makeFakePageHost({ host: { kind: "server" } });
        yield* fake.open({ tab: asServer, background: false, private: false });
        assert.strictEqual(yield* Fiber.join(yield* dial(fake, own.token)), "closed");
        assert.isFalse(yield* listed(asOther));
        assert.isFalse(yield* listed(asServer));
      }).pipe(Effect.scoped),
  );

  it.effect("closes a host that speaks another version of the protocol", () =>
    Effect.gen(function* () {
      const { deviceId, token } = yield* pairedDevice;
      const tab = BrowserTabRef.make("host-other-protocol");
      const fake = yield* desktopWithTab(deviceId, tab);
      const newer: FakePageHost = {
        ...fake,
        hello: Effect.map(fake.hello, (hello) => ({
          ...hello,
          protocol: BROWSER_HOST_PROTOCOL_VERSION + 1,
        })),
      };
      assert.strictEqual(yield* Fiber.join(yield* dial(newer, token)), "closed");
      assert.isFalse(yield* listed(tab));
    }).pipe(Effect.scoped),
  );
});
