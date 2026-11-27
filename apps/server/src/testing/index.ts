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
import * as RefusedNames from "../web/RefusedNames.ts";
import * as TestDomain from "./domain.ts";
import * as TestUpdates from "./update.ts";

export { Attachments } from "../attachments/Attachments.ts";
export { CurrentDevice, DeviceAuth } from "../auth/DeviceAuth.ts";
export { Bots } from "../bots/Bots.ts";
export { Devices } from "../devices/Devices.ts";
export { Entries } from "../entries/Entries.ts";
export { Presence } from "../presence/Presence.ts";
export { Usage } from "../turns/Usage.ts";
export { Browser } from "../browser/Browser.ts";
export type { FakePageHost } from "@j3-bots/browser/testing";
export { botOpens, TestServerBrowser } from "./browser.ts";
export { TestCloudSpeech } from "./cloudSpeech.ts";
export { TestDiskSpace } from "./diskSpace.ts";
export { botAsks } from "./turns.ts";
export { recorded as recordedTelemetry } from "./telemetry.ts";
export { pastTurns, turnRecorded } from "./usage.ts";

/** Every handler of the contract, as the server answers it. */
type ServerHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof J3Rpcs>>;

/** What a tap may use: the domain, and the server's own handlers, to wrap. */
type TapServices = Layer.Success<typeof TestDomain.layer> | CurrentDevice | ServerHandlers;

/**
 * The server as a client meets it, for client tests: its HTTP routes and the
 * RPC and media sockets on a free loopback port, over the in-memory engine and a fresh
 * database. `taps` replaces handlers with ones that wrap the server's own
 * (`J3Rpcs.accessHandler`), for a test that watches a call, holds it or
 * refuses it at an exact point; every other call is the server's own. What
 * else the taps need (`R`), the layer needs.
 */
export const layer = <Tapped extends ServerHandlers, R = never>(
  taps: Layer.Layer<Tapped, never, TapServices | R>,
) =>
  Ports.serve(
    Layer.mergeAll(
      Http.routes,
      RpcSocket.layer(J3Rpcs, taps.pipe(Layer.provideMerge(Handlers.handlers))),
      MediaSocket.route,
    ),
    NodeHttpServer.layerTest,
    { logAddress: false },
  ).pipe(
    Layer.provide([TestUpdates.layer, RefusedNames.layer]),
    Layer.provideMerge(TestDomain.layer),
  );

/** The `http:` origin the test server listens on. */
export const origin = Effect.gen(function* () {
  const { address } = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(address)) {
    return yield* Effect.die("The test server listens on a TCP port");
  }
  return new URL(`http://127.0.0.1:${address.port}`);
});
