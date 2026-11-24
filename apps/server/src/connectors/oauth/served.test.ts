// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- one request is written by hand, in a form no HTTP client sends.
import * as Net from "node:net";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { ConnectorRpcs, HTTP_PATHS } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Devices } from "../../devices/Devices.ts";
import * as Http from "../../http.ts";
import * as Listener from "../../listener.ts";
import * as TestDomain from "../../testing/domain.ts";
import * as TestUpdates from "../../testing/update.ts";
import { addOAuthConnector, NOTION, TestOAuth, unresolvable } from "../../testing/oauth.ts";
import { Vault } from "../../vault/Vault.ts";
import * as WebClient from "../../web/WebClient.ts";

/** Every line the server logs while these tests run, at any level, as JSON. */
const logged: Array<string> = [];
const recordLogs = Layer.merge(
  Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      logged.push(line);
    }),
  ]),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

// The client listener as the server runs it, on a port the system chooses.
it.layer(
  Http.serve(Listener.layer, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(WebClient.statusLayer),
    Layer.provide(TestUpdates.layer),
    Layer.provideMerge(TestDomain.servedLayer.pipe(Layer.provide(unresolvable))),
  ),
  { excludeTestServices: true },
)("a connector's sign-in, served", (it) => {
  it.effect(
    "finishes from the device's relayed address and at the server's callback, and logs none of it",
    () =>
      Effect.gen(function* () {
        const devices = yield* Devices;
        const { code } = yield* devices.startPairing;
        const { token } = yield* devices.pair({ code, name: "Laptop" });
        const bound = yield* Deferred.await(yield* Listener.Listener);
        const origin = `http://${bound.address}:${bound.port}`;
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(
              NodeSocket.layerWebSocket(`ws://${bound.address}:${bound.port}${HTTP_PATHS.rpc}`, {
                headers: { authorization: `Bearer ${token}` },
              }),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        );
        const client = yield* RpcClient.make(ConnectorRpcs).pipe(Effect.provide(protocol));
        const fake = yield* TestOAuth;
        yield* (yield* Vault).setup(Redacted.make("correct horse battery"));
        yield* addOAuthConnector;

        // A relayed address: the device's loopback listener caught it.
        const relayed = yield* client["connector.beginSignIn"]({
          connectorId: NOTION,
          redirect: { _tag: "relay", port: 41234 },
        });
        const caught = fake.authorize(Redacted.value(relayed.authorizationUrl));
        assert.isTrue(
          caught.startsWith("http://127.0.0.1:41234/oauth/callback/auth.example.test?"),
        );
        yield* client["connector.completeSignIn"]({ url: Redacted.make(caught) });
        // Used once: the same address again names no sign-in.
        const again = yield* Effect.exit(
          client["connector.completeSignIn"]({ url: Redacted.make(caught) }),
        );
        assert.isTrue(Exit.isFailure(again));

        // The server's own callback, which the browser reaches on loopback here.
        const served = yield* client["connector.beginSignIn"]({
          connectorId: NOTION,
          redirect: { _tag: "server" },
        });
        const back = fake.authorize(Redacted.value(served.authorizationUrl));
        assert.isTrue(back.startsWith(`${origin}/oauth/callback/auth.example.test?`));
        // A device cannot finish a sign-in that returns to the server.
        const fromDevice = yield* Effect.exit(
          client["connector.completeSignIn"]({ url: Redacted.make(back) }),
        );
        assert.isTrue(Exit.isFailure(fromDevice));
        const page = yield* HttpClient.execute(
          HttpClientRequest.get(back, { headers: { "accept-language": "pt-BR,pt;q=0.9" } }),
        );
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers["referrer-policy"], "no-referrer");
        assert.include(yield* page.text, "Conectado");
        const replayed = yield* HttpClient.execute(HttpClientRequest.get(back));
        assert.strictEqual(replayed.status, 400);

        // A client may name the whole address in its request line (absolute form).
        const absolute = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              let answer = "";
              const socket = Net.connect(bound.port, bound.address, () =>
                socket.end(
                  `GET ${origin}/oauth/callback/auth.example.test?code=absolute-code&state=absolute-state HTTP/1.1\r\n` +
                    `Host: ${bound.address}:${bound.port}\r\nConnection: close\r\n\r\n`,
                ),
              );
              socket.setEncoding("utf8");
              socket.on("data", (chunk: string) => {
                answer += chunk;
              });
              socket.on("end", () => resolve(answer));
              socket.on("error", reject);
            }),
        );
        assert.match(absolute, /^HTTP\/1\.1 400/);

        const secret = Option.getOrThrow(yield* (yield* Vault).connectorSecrets.get(NOTION));
        assert.isNotNull(secret.oauth?.tokens);

        // Nothing of either sign-in reached a log line or a failure.
        const shown = [
          ...logged,
          Exit.isFailure(again) ? Cause.pretty(again.cause) : "",
          Exit.isFailure(fromDevice) ? Cause.pretty(fromDevice.cause) : "",
        ];
        const values = [
          "absolute-code",
          "absolute-state",
          ...fake.issued,
          ...[...fake.clients].flatMap(([, { secret }]) => (secret === null ? [] : [secret])),
          new URL(caught).searchParams.get("state") ?? "",
          new URL(back).searchParams.get("state") ?? "",
          ...fake.received.flatMap(({ body }) => {
            const verifier = new URLSearchParams(body).get("code_verifier");
            return verifier === null ? [] : [verifier];
          }),
        ];
        assert.isAbove(values.length, 6);
        for (const line of shown) {
          for (const value of values) assert.notInclude(line, value);
        }
        // The request log names the callback, without its query.
        assert.isTrue(logged.some((line) => line.includes('"/oauth/callback"')));
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
  );
});
