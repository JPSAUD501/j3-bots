// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { J3Rpcs } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { CurrentDevice } from "../auth/DeviceAuth.ts";
import * as MediaSocket from "../browser/MediaSocket.ts";
import * as Http from "../http.ts";
import * as Handlers from "../rpc/handlers.ts";
import * as RpcSocket from "../RpcSocket.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "./domain.ts";
import * as TestUpdates from "./update.ts";

export { Attachments } from "../attachments/Attachments.ts";
export { CurrentDevice, DeviceAuth } from "../auth/DeviceAuth.ts";
export { Bots } from "../bots/Bots.ts";
export { Devices } from "../devices/Devices.ts";
export { Entries } from "../entries/Entries.ts";
export { Presence } from "../presence/Presence.ts";
export { botHasTabs, type FakeViewer, TestBrowserControl, ViewerClosed } from "./browser.ts";

/** The RPCs of the contract this server does not answer yet. */
export type UnservedRpcs = Exclude<
  RpcGroup.Rpcs<typeof J3Rpcs>,
  RpcGroup.Rpcs<typeof Handlers.ServedRpcs>
>;

/**
 * The connector requests, which the server does not serve yet, answered as it
 * answers them: with a defect. For a client test that does not fake them.
 */
export const connectorsUnserved = Layer.mergeAll(
  J3Rpcs.toLayerHandler("connectors.list", () => Effect.die("Not served")),
  J3Rpcs.toLayerHandler("connectors.search", () => Effect.die("Not served")),
  J3Rpcs.toLayerHandler("connectors.get", () => Effect.die("Not served")),
);

/** What the domain offers the handlers of the RPCs it does not serve yet. */
type DomainServices = Layer.Success<typeof TestDomain.layer> | CurrentDevice;

/**
 * The server as a client meets it, for client tests: its HTTP routes and the
 * RPC and media sockets on a free loopback port, over the in-memory engine and a fresh
 * database. `unserved` answers the RPCs the server does not serve yet, so a
 * client can be tested against the whole contract.
 */
export const layer = (unserved: Layer.Layer<Rpc.ToHandler<UnservedRpcs>, never, DomainServices>) =>
  Ports.serve(
    Layer.mergeAll(
      Http.routes,
      RpcSocket.layer(J3Rpcs, Layer.mergeAll(Handlers.handlers, unserved)),
      MediaSocket.route,
    ),
    NodeHttpServer.layerTest,
    { logAddress: false },
  ).pipe(Layer.provide(TestUpdates.layer), Layer.provideMerge(TestDomain.layer));

/** The `http:` origin the test server listens on. */
export const origin = Effect.gen(function* () {
  const { address } = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(address)) {
    return yield* Effect.die("The test server listens on a TCP port");
  }
  return new URL(`http://127.0.0.1:${address.port}`);
});
