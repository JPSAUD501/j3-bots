// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import { launchServerHost } from "./ServerHost.ts";

// The server's own browser against a page this test serves on the loopback:
// nothing leaves the machine.

/** A Chromium to drive; CI and the checks set it, and without one these tests are skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

/** The origin of a page served on the loopback, for as long as the scope lives. */
const localSite = Effect.gen(function* () {
  yield* HttpServer.serveEffect(
    Effect.succeed(
      HttpServerResponse.text("<!doctype html><title>Signed in</title>", {
        contentType: "text/html",
      }),
    ),
  );
  const { address } = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(address))
    return yield* Effect.die("The test server listens on TCP");
  return `http://127.0.0.1:${address.port}`;
});

describe.skipIf(executablePath === undefined)("the server's browser", () => {
  it.live(
    "a sign-out clears an origin's storage, and the sessionStorage of its open tab",
    () =>
      Effect.gen(function* () {
        if (executablePath === undefined) return;
        const origin = yield* localSite;
        const host = yield* launchServerHost({ executable: executablePath, platform: "linux64" });
        const tab = BrowserTabRef.make("tab-1");
        const evaluate = (expression: string) =>
          Effect.map(host.evaluate({ tab, expression, awaitPromise: false }), ({ value }) => value);

        yield* host.writeStorage([{ origin, localStorage: [{ name: "token", value: "t1" }] }]);
        yield* host.open({ tab, url: `${origin}/`, background: true, private: false });
        assert.strictEqual(
          yield* evaluate("sessionStorage.setItem('session', 's1'); localStorage.getItem('token')"),
          "t1",
        );

        yield* host.clearStorage({ origins: [origin] });
        const { origins } = yield* host.readStorage({ origins: [origin], indexedDb: false });
        assert.deepStrictEqual(origins, [{ origin, localStorage: [] }]);
        assert.strictEqual(yield* evaluate("sessionStorage.getItem('session')"), null);
        assert.strictEqual(yield* evaluate("localStorage.getItem('token')"), null);
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeHttpServer.layerTest])),
    60_000,
  );
});
