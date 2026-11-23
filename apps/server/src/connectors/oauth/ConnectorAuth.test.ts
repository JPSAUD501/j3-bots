// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { DeviceId, ServerOrigin } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ListenerStatus } from "../../admin/protocol.ts";
import { ServerConfig } from "../../config.ts";
import { Listener } from "../../listener.ts";
import * as TestDomain from "../../testing/domain.ts";
import { AS_ORIGIN, FakeAuthorizationServer, MCP_URL, requestGate } from "../../testing/oauth.ts";
import { ConnectorId } from "../../vault/ConnectorSecret.ts";
import { Vault } from "../../vault/Vault.ts";
import * as ConnectorAuth from "./ConnectorAuth.ts";

const PASSWORD = Redacted.make("correct horse battery");
const LAPTOP = DeviceId.make("device-laptop");
const PHONE = DeviceId.make("device-phone");
const NOTION = ConnectorId.make("conn_aaaaaaaaaaaaaaaa");

/** Every line logged while a test runs, at any level. */
const logged: Array<string> = [];
const recordLogs = Layer.merge(
  Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      logged.push(line);
    }),
  ]),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

/** The connectors' store as sign-ins see it: one OAuth connector, whose address is in the vault. */
const connectors = Layer.succeed(ConnectorAuth.OAuthConnectors, {
  signInOf: (id) => Effect.succeed(id === NOTION ? Option.some("oauth") : Option.none()),
  all: Effect.succeed([NOTION]),
});

const listenerAt = (address: string) =>
  Layer.effect(
    Listener,
    Effect.tap(Deferred.make<ListenerStatus>(), (bound) =>
      Deferred.succeed(bound, { scheme: "http", address, port: 3737, names: [] }),
    ),
  );

const withPublicOrigin = Layer.effect(
  ServerConfig,
  Effect.map(Effect.service(ServerConfig), (config) => ({
    ...config,
    publicOrigin: Option.some(ServerOrigin.make("https://bots.example.test")),
  })),
);

/**
 * Runs `use` with sign-ins against `fake`, over the test domain with its vault
 * set up and unlocked. The server listens on every interface unless `local`.
 */
const run = <A, E>(
  fake: FakeAuthorizationServer,
  use: Effect.Effect<A, E, ConnectorAuth.ConnectorAuth | Vault>,
  { local = false, publicOrigin = false } = {},
) =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* vault.connectorSecrets.put({
      connectorId: NOTION,
      address: Redacted.make(MCP_URL),
      oauth: null,
      headers: [],
      env: [],
    });
    return yield* use;
  }).pipe(
    Effect.provide(
      // This test's sign-ins, in place of the domain's (`fresh`, so the
      // domain's are not reused): against `fake`, for its one connector, with
      // the listener and the configuration it asks for.
      Layer.fresh(ConnectorAuth.layer).pipe(
        Layer.provide(fake.layer),
        Layer.provide(connectors),
        Layer.provide(listenerAt(local ? "127.0.0.1" : "0.0.0.0")),
        Layer.provide(publicOrigin ? withPublicOrigin : Layer.empty),
        Layer.provideMerge(TestDomain.layer),
        Layer.provideMerge(recordLogs),
      ),
    ),
  );

const auth = Effect.service(ConnectorAuth.ConnectorAuth);

/** The reason a refused request gives, or null when it succeeded. */
const refusal = <A, E>(exit: Exit.Exit<A, E>): string | null => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) return "defect";
  const value: unknown = error.value;
  if (typeof value === "object" && value !== null && "reason" in value) return String(value.reason);
  return typeof value === "object" && value !== null && "_tag" in value ? String(value._tag) : "?";
};

/** Signs in from the laptop with a pasted address, as the web client does. */
const signIn = (fake: FakeAuthorizationServer) =>
  Effect.gen(function* () {
    const service = yield* auth;
    const { authorizationUrl } = yield* service.begin({
      connectorId: NOTION,
      deviceId: LAPTOP,
      redirect: { _tag: "paste" },
    });
    const back = fake.authorize(authorizationUrl);
    yield* service.complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back) });
    return { authorizationUrl, back };
  });

const tokenRequests = (fake: FakeAuthorizationServer) =>
  fake.received.filter((request) => request.url === `${AS_ORIGIN}/token`);

const stateOf = Effect.gen(function* () {
  const service = yield* auth;
  const states = yield* Stream.runHead(service.states);
  return Option.getOrThrow(states).get(NOTION);
});

it.effect(
  "finds the authorization server in the specification's order, registers, and signs in with PKCE and the resource",
  () => {
    const fake = new FakeAuthorizationServer({
      resourceMetadata: "root",
      issuerPath: "/tenant",
      metadataAt: "oidc-appended",
    });
    return run(
      fake,
      Effect.gen(function* () {
        const { authorizationUrl } = yield* signIn(fake);
        const gets = fake.received
          .filter((request) => request.method === "GET")
          .map(({ url }) => url);
        assert.deepStrictEqual(gets, [
          "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
          "https://mcp.example.test/.well-known/oauth-protected-resource",
          `${AS_ORIGIN}/.well-known/oauth-authorization-server/tenant`,
          `${AS_ORIGIN}/.well-known/openid-configuration/tenant`,
          `${AS_ORIGIN}/tenant/.well-known/openid-configuration`,
        ]);
        const asked = new URL(authorizationUrl).searchParams;
        assert.strictEqual(asked.get("code_challenge_method"), "S256");
        assert.strictEqual(asked.get("resource"), MCP_URL);
        // The issuer's own path under the callback's.
        assert.strictEqual(
          asked.get("redirect_uri"),
          "http://127.0.0.1/oauth/callback/auth.example.test/tenant",
        );
        assert.lengthOf(asked.get("state") ?? "", 22);
        // A registered public client: PKCE is its only proof, and the fake checked it.
        const [registered] = [...fake.clients.values()];
        assert.strictEqual(registered?.method, "none");
        const [exchange] = tokenRequests(fake);
        const form = new URLSearchParams(exchange?.body);
        assert.strictEqual(form.get("grant_type"), "authorization_code");
        assert.strictEqual(form.get("resource"), MCP_URL);
        assert.lengthOf(form.get("code_verifier") ?? "", 43);
        const token = yield* (yield* auth).accessToken(NOTION);
        assert.strictEqual(Redacted.value(token), "access-3");
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
      }),
    );
  },
);

it.effect("reads the resource metadata the challenge names, and nothing before it", () => {
  const fake = new FakeAuthorizationServer({ resourceMetadata: "challenge" });
  return run(
    fake,
    Effect.gen(function* () {
      const { authorizationUrl } = yield* signIn(fake);
      const gets = fake.received
        .filter((request) => request.method === "GET")
        .map(({ url }) => url);
      assert.strictEqual(
        gets[0],
        "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      );
      assert.strictEqual(gets.length, 2);
      // The challenge's scope, not the metadata's list.
      assert.strictEqual(new URL(authorizationUrl).searchParams.get("scope"), "read write");
    }),
  );
});

it.effect("refuses a server without PKCE S256, another issuer or another resource", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [Partial<FakeAuthorizationServer["options"]>, string]> = [
      [{ s256: false }, "pkce-unsupported"],
      [{ claimedIssuer: "https://elsewhere.example.test" }, "issuer-mismatch"],
      [{ resource: "https://other.example.test/mcp" }, "resource-mismatch"],
      [{ registration: false }, "registration-unsupported"],
    ];
    for (const [options, reason] of cases) {
      const fake = new FakeAuthorizationServer(options);
      const exit = yield* run(
        fake,
        Effect.exit(
          Effect.flatMap(auth, (service) =>
            service.begin({ connectorId: NOTION, deviceId: LAPTOP, redirect: { _tag: "paste" } }),
          ),
        ),
      );
      assert.strictEqual(refusal(exit), reason);
      assert.isFalse(fake.received.some(({ url }) => url === `${AS_ORIGIN}/token`));
    }
  }),
);

it.effect(
  "finishes a sign-in only from the device that began it, once, within ten minutes, at its exact address",
  () => {
    const fake = new FakeAuthorizationServer();
    return run(
      fake,
      Effect.gen(function* () {
        const service = yield* auth;
        const begin = service.begin({
          connectorId: NOTION,
          deviceId: LAPTOP,
          redirect: { _tag: "relay", port: 41234 },
        });
        const complete = (deviceId: DeviceId, url: string) =>
          Effect.exit(service.complete({ _tag: "device", deviceId, url: Redacted.make(url) }));

        const back = fake.authorize((yield* begin).authorizationUrl);
        // A state no sign-in has.
        const forged = new URL(back);
        forged.searchParams.set("state", "forged");
        assert.strictEqual(refusal(yield* complete(LAPTOP, forged.href)), "unknown-sign-in");
        // Another device, which leaves the sign-in to the laptop.
        assert.strictEqual(refusal(yield* complete(PHONE, back)), "unknown-sign-in");
        // The server's callback takes only a sign-in that returns to it.
        const query = new URL(back).search.slice(1);
        assert.strictEqual(
          refusal(
            yield* Effect.exit(
              service.complete({
                _tag: "callback",
                path: new URL(back).pathname,
                query: Redacted.make(query),
              }),
            ),
          ),
          "unknown-sign-in",
        );
        // Another port than the relay's: refused, and the sign-in is spent.
        const wrongPort = new URL(back);
        wrongPort.port = "41235";
        assert.strictEqual(refusal(yield* complete(LAPTOP, wrongPort.href)), "address-mismatch");
        assert.strictEqual(refusal(yield* complete(LAPTOP, back)), "unknown-sign-in");

        // A fresh one, too late.
        const late = fake.authorize((yield* begin).authorizationUrl);
        yield* TestClock.adjust(Duration.minutes(10));
        assert.strictEqual(refusal(yield* complete(LAPTOP, late)), "unknown-sign-in");

        // A declined consent.
        const declined = fake.authorize((yield* begin).authorizationUrl, false);
        assert.strictEqual(refusal(yield* complete(LAPTOP, declined)), "denied");

        const good = fake.authorize((yield* begin).authorizationUrl);
        assert.strictEqual(refusal(yield* complete(LAPTOP, good)), null);
        // A relay's redirect is registered as it is: the dynamic client names its port.
        assert.deepStrictEqual([...fake.clients.values()][0]?.redirectUris, [
          "http://127.0.0.1:41234/oauth/callback/auth.example.test",
        ]);
      }),
    );
  },
);

it.effect("returns to the server's own callback only where a browser can reach it", () =>
  Effect.gen(function* () {
    const server = { connectorId: NOTION, deviceId: LAPTOP, redirect: { _tag: "server" } } as const;
    const lan = yield* run(
      new FakeAuthorizationServer(),
      Effect.exit(Effect.flatMap(auth, (service) => service.begin(server))),
    );
    assert.strictEqual(refusal(lan), "no-server-redirect");

    const fake = new FakeAuthorizationServer();
    yield* run(
      fake,
      Effect.gen(function* () {
        const service = yield* auth;
        // An answer that comes back by another authorization server's path is
        // not this sign-in's, though it carries its state (mix-up).
        const mixed = new URL(fake.authorize((yield* service.begin(server)).authorizationUrl));
        assert.strictEqual(
          refusal(
            yield* Effect.exit(
              service.complete({
                _tag: "callback",
                path: "/oauth/callback/elsewhere.example.test",
                query: Redacted.make(mixed.search.slice(1)),
              }),
            ),
          ),
          "address-mismatch",
        );
        const { authorizationUrl } = yield* service.begin(server);
        const back = new URL(fake.authorize(authorizationUrl));
        assert.strictEqual(
          `${back.origin}${back.pathname}`,
          "http://127.0.0.1:3737/oauth/callback/auth.example.test",
        );
        // A device cannot finish what returns to the server.
        assert.strictEqual(
          refusal(
            yield* Effect.exit(
              service.complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back.href) }),
            ),
          ),
          "unknown-sign-in",
        );
        yield* service.complete({
          _tag: "callback",
          path: back.pathname,
          query: Redacted.make(back.search.slice(1)),
        });
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
      }),
      { local: true },
    );

    const behindProxy = new FakeAuthorizationServer();
    yield* run(
      behindProxy,
      Effect.gen(function* () {
        const { authorizationUrl } = yield* Effect.flatMap(auth, (service) =>
          service.begin(server),
        );
        assert.strictEqual(
          new URL(authorizationUrl).searchParams.get("redirect_uri"),
          "https://bots.example.test/oauth/callback/auth.example.test",
        );
      }),
      { publicOrigin: true },
    );
  }),
);

it.effect("checks the issuer a server promises to name on the redirect", () => {
  const fake = new FakeAuthorizationServer({ issParameter: true });
  return run(
    fake,
    Effect.gen(function* () {
      const service = yield* auth;
      const { authorizationUrl } = yield* service.begin({
        connectorId: NOTION,
        deviceId: LAPTOP,
        redirect: { _tag: "paste" },
      });
      const back = new URL(fake.authorize(authorizationUrl));
      back.searchParams.delete("iss");
      const exit = yield* Effect.exit(
        service.complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back.href) }),
      );
      assert.strictEqual(refusal(exit), "issuer-mismatch");
      yield* signIn(fake);
    }),
  );
});

it.effect(
  "refreshes ahead of expiry, keeps a rotated refresh token, and keeps one a server does not rotate",
  () => {
    const fake = new FakeAuthorizationServer({ lifetime: 3600 });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        const service = yield* auth;
        const signedIn = yield* stateOf;
        assert.strictEqual(Redacted.value(yield* service.accessToken(NOTION)), "access-3");
        yield* TestClock.adjust(Duration.minutes(55));
        // A refresh is not a new sign-in.
        assert.deepStrictEqual(yield* stateOf, signedIn);
        // Five minutes ahead, the worker refreshed with the first refresh token, which the server ended.
        assert.strictEqual(tokenRequests(fake).length, 2);
        assert.strictEqual(
          new URLSearchParams(tokenRequests(fake)[1]?.body).get("refresh_token"),
          "refresh-4",
        );
        assert.isFalse(fake.refreshTokens.has("refresh-4"));
        assert.strictEqual(Redacted.value(yield* service.accessToken(NOTION)), "access-5");

        fake.options = { ...fake.options, rotate: false };
        yield* TestClock.adjust(Duration.minutes(60));
        assert.strictEqual(
          new URLSearchParams(tokenRequests(fake)[2]?.body).get("refresh_token"),
          "refresh-6",
        );
        assert.strictEqual(Redacted.value(yield* service.accessToken(NOTION)), "access-7");
        // A server that sent no new refresh token: the one it has goes on working.
        yield* TestClock.adjust(Duration.minutes(60));
        assert.strictEqual(
          new URLSearchParams(tokenRequests(fake)[3]?.body).get("refresh_token"),
          "refresh-6",
        );
      }),
    );
  },
);

it.effect(
  "refreshes one at a time, so calls that find the token expiring wait for the refresh under way",
  () => {
    // A token that lives 100 seconds is refreshed halfway, when it is already
    // within the minute that makes a call refresh it too.
    const fake = new FakeAuthorizationServer({ lifetime: 100 });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        const service = yield* auth;
        const gate = yield* requestGate();
        fake.gate = gate;
        // The worker's refresh starts, and its answer is held (for less than a call's timeout).
        yield* TestClock.adjust(Duration.seconds(50));
        yield* Deferred.await(gate.arrived);
        assert.strictEqual(tokenRequests(fake).length, 2);
        // Meanwhile three calls find the token expiring.
        const calls = yield* Effect.all(
          [service.accessToken(NOTION), service.accessToken(NOTION), service.accessToken(NOTION)],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate.open, undefined);
        const tokens = yield* Fiber.join(calls);
        assert.deepStrictEqual(tokens.map(Redacted.value), ["access-5", "access-5", "access-5"]);
        // The rotated refresh token was never sent twice.
        assert.strictEqual(tokenRequests(fake).length, 2);
      }),
    );
  },
);

it.effect(
  "tries a refresh again while the server is down, and is failing once the token expired",
  () => {
    const fake = new FakeAuthorizationServer({ lifetime: 600 });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        fake.options = { ...fake.options, down: true };
        yield* TestClock.adjust(Duration.minutes(5));
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
        yield* TestClock.adjust(Duration.minutes(5));
        assert.deepStrictEqual(yield* stateOf, { _tag: "failing", reason: "refresh-failed" });
        assert.strictEqual(
          refusal(yield* Effect.exit((yield* auth).accessToken(NOTION))),
          "refresh-failed",
        );
        const attempts = tokenRequests(fake).length;
        fake.options = { ...fake.options, down: false };
        yield* TestClock.adjust(Duration.minutes(15));
        assert.isAbove(tokenRequests(fake).length, attempts);
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
      }),
    );
  },
);

it.effect(
  "needs a new sign-in when the server refuses the refresh token, and drops a client it refuses",
  () => {
    const fake = new FakeAuthorizationServer({ lifetime: 600 });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        fake.refreshTokens.clear();
        yield* TestClock.adjust(Duration.minutes(5));
        assert.deepStrictEqual(yield* stateOf, { _tag: "needs-sign-in", reason: "expired" });
        const service = yield* auth;
        assert.strictEqual(refusal(yield* Effect.exit(service.accessToken(NOTION))), "NeedsSignIn");
        const vault = yield* Vault;
        const secret = Option.getOrThrow(yield* vault.connectorSecrets.get(NOTION));
        assert.isNull(secret.oauth?.tokens);
        // The client stays: signing in again needs no new registration.
        yield* signIn(fake);
        assert.strictEqual(fake.clients.size, 1);

        fake.clients.clear();
        assert.strictEqual(
          refusal(yield* Effect.exit(service.rejected(NOTION, Option.none(), fake.bearer))),
          "NeedsSignIn",
        );
        // A refused client goes with its tokens; the connector's address stays.
        const left = Option.getOrThrow(yield* vault.connectorSecrets.get(NOTION));
        assert.isNull(left.oauth);
        assert.strictEqual(left.address === null ? null : Redacted.value(left.address), MCP_URL);
      }),
    );
  },
);

it.effect(
  "refreshes a token the server refuses, and asks for the scope it lacks at the next sign-in",
  () => {
    const fake = new FakeAuthorizationServer();
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        const service = yield* auth;
        yield* service.rejected(NOTION, Option.some('Bearer error="invalid_token"'), fake.bearer);
        assert.strictEqual(tokenRequests(fake).length, 2);
        assert.strictEqual(Redacted.value(yield* service.accessToken(NOTION)), "access-5");

        const insufficient = 'Bearer error="insufficient_scope", scope="read write admin"';
        const exit = yield* Effect.exit(
          service.rejected(NOTION, Option.some(insufficient), fake.bearer),
        );
        assert.strictEqual(refusal(exit), "NeedsSignIn");
        // A refresh cannot widen a grant, so none was tried.
        assert.strictEqual(tokenRequests(fake).length, 2);
        const { authorizationUrl } = yield* signIn(fake);
        assert.strictEqual(new URL(authorizationUrl).searchParams.get("scope"), "read write admin");
        // Once granted, later sign-ins keep asking for it.
        const again = yield* service.begin({
          connectorId: NOTION,
          deviceId: LAPTOP,
          redirect: { _tag: "paste" },
        });
        assert.strictEqual(
          new URL(again.authorizationUrl).searchParams.get("scope"),
          "read write admin",
        );
      }),
    );
  },
);

it.effect(
  "revokes on disconnect where the server offers it, and forgets the tokens either way",
  () =>
    Effect.gen(function* () {
      const fake = new FakeAuthorizationServer();
      yield* run(
        fake,
        Effect.gen(function* () {
          yield* signIn(fake);
          const service = yield* auth;
          yield* service.disconnect(NOTION);
          assert.deepStrictEqual(fake.revoked, ["refresh-4", "access-3"]);
          assert.isNull(
            Option.getOrThrow(yield* (yield* Vault).connectorSecrets.get(NOTION)).oauth,
          );
          assert.isUndefined(yield* stateOf);
        }),
      );

      const silent = new FakeAuthorizationServer({ revocation: false });
      yield* run(
        silent,
        Effect.gen(function* () {
          yield* signIn(silent);
          yield* (yield* auth).disconnect(NOTION);
          assert.isNull(
            Option.getOrThrow(yield* (yield* Vault).connectorSecrets.get(NOTION)).oauth,
          );
        }),
      );
    }),
);

it.effect("signs in with the operator's own client, which nothing registers or replaces", () => {
  const fake = new FakeAuthorizationServer({ registration: false });
  fake.addClient("own-app", "own-secret");
  return run(
    fake,
    Effect.gen(function* () {
      const service = yield* auth;
      const own = {
        issuer: fake.issuer,
        clientId: "own-app",
        clientSecret: Option.some(Redacted.make("own-secret")),
      };
      // Registered at another server than the one the connector names: its
      // secret is not sent there.
      const elsewhere = yield* Effect.exit(
        service.useOperatorClient(NOTION, { ...own, issuer: "https://accounts.example.test" }),
      );
      assert.strictEqual(refusal(elsewhere), "issuer-mismatch");
      yield* service.useOperatorClient(NOTION, own);
      const { authorizationUrl } = yield* signIn(fake);
      assert.strictEqual(new URL(authorizationUrl).searchParams.get("client_id"), "own-app");
      // Its secret goes in a Basic header, which every server takes.
      const [exchange] = tokenRequests(fake);
      assert.strictEqual(exchange?.headers["authorization"], `Basic ${btoa("own-app:own-secret")}`);
      assert.isFalse(new URLSearchParams(exchange?.body).has("client_secret"));
      fake.clients.clear();
      yield* Effect.exit(service.rejected(NOTION, Option.none(), fake.bearer));
      const client = Option.getOrThrow(yield* (yield* Vault).connectorSecrets.get(NOTION)).oauth
        ?.client;
      assert.strictEqual(client?.clientId, "own-app");
    }),
  );
});

it.effect(
  "keeps every code, token, secret, verifier and state out of the log and out of errors",
  () => {
    logged.length = 0;
    const fake = new FakeAuthorizationServer({ lifetime: 600 });
    fake.addClient("own-app", "own-secret-value");
    return run(
      fake,
      Effect.gen(function* () {
        const { authorizationUrl, back } = yield* signIn(fake);
        const service = yield* auth;
        fake.options = { ...fake.options, down: true };
        yield* TestClock.adjust(Duration.minutes(10));
        const failed = yield* Effect.exit(service.accessToken(NOTION));
        fake.options = { ...fake.options, down: false };
        const replay = yield* Effect.exit(
          service.complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back) }),
        );
        yield* service.useOperatorClient(NOTION, {
          issuer: fake.issuer,
          clientId: "own-app",
          clientSecret: Option.some(Redacted.make("own-secret-value")),
        });
        yield* service.disconnect(NOTION);
        const asked = new URL(authorizationUrl).searchParams;
        const exchanged = new URLSearchParams(tokenRequests(fake)[0]?.body);
        const secrets = [
          ...fake.issued,
          "own-secret-value",
          btoa("own-app:own-secret-value"),
          asked.get("state") ?? "-",
          asked.get("code_challenge") ?? "-",
          exchanged.get("code_verifier") ?? "-",
        ];
        const shown = [
          ...logged,
          Exit.isFailure(failed) ? Cause.pretty(failed.cause) : "",
          Exit.isFailure(replay) ? Cause.pretty(replay.cause) : "",
        ].join("\n");
        assert.isNotEmpty(logged);
        for (const secret of secrets) assert.notInclude(shown, secret);
      }),
    );
  },
);

it.effect("drops a sign-in whose answer came back after the connector signed out", () => {
  const fake = new FakeAuthorizationServer();
  return run(
    fake,
    Effect.gen(function* () {
      const service = yield* auth;
      const { authorizationUrl } = yield* service.begin({
        connectorId: NOTION,
        deviceId: LAPTOP,
        redirect: { _tag: "paste" },
      });
      const back = fake.authorize(authorizationUrl);
      const gate = yield* requestGate();
      fake.gate = gate;
      const completing = yield* service
        .complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back) })
        .pipe(Effect.exit, Effect.forkChild);
      // The code is being exchanged when the operator signs the connector out.
      yield* Deferred.await(gate.arrived);
      yield* service.disconnect(NOTION);
      yield* Deferred.succeed(gate.open, undefined);
      assert.strictEqual(refusal(yield* Fiber.join(completing)), "unknown-sign-in");
      const secret = Option.getOrThrow(yield* (yield* Vault).connectorSecrets.get(NOTION));
      assert.isNull(secret.oauth);
      assert.isUndefined(yield* stateOf);
    }),
  );
});

it.effect("gives up on a token answer whose body never ends", () => {
  const fake = new FakeAuthorizationServer();
  return run(
    fake,
    Effect.gen(function* () {
      const service = yield* auth;
      const { authorizationUrl } = yield* service.begin({
        connectorId: NOTION,
        deviceId: LAPTOP,
        redirect: { _tag: "paste" },
      });
      const back = fake.authorize(authorizationUrl);
      fake.options = { ...fake.options, stall: true };
      const completing = yield* service
        .complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back) })
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(15));
      assert.strictEqual(refusal(yield* Fiber.join(completing)), "unreachable");
    }),
  );
});

it.effect("uses a token without a refresh token until it expires, then needs a sign-in", () => {
  const fake = new FakeAuthorizationServer({ lifetime: 45, refresh: false });
  return run(
    fake,
    Effect.gen(function* () {
      yield* signIn(fake);
      const service = yield* auth;
      // Within the minute a call would refresh in, it is still good.
      assert.strictEqual(Redacted.value(yield* service.accessToken(NOTION)), fake.issued.at(-1));
      assert.strictEqual((yield* stateOf)?._tag, "signed-in");
      yield* TestClock.adjust(Duration.seconds(45));
      assert.strictEqual(refusal(yield* Effect.exit(service.accessToken(NOTION))), "NeedsSignIn");
      assert.strictEqual((yield* stateOf)?._tag, "needs-sign-in");
      assert.lengthOf(tokenRequests(fake), 1);
    }),
  );
});

it.effect(
  "saves a rotated refresh token that came back after the vault locked, once it unlocks",
  () => {
    const fake = new FakeAuthorizationServer({ lifetime: 100 });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        const vault = yield* Vault;
        const service = yield* auth;
        const gate = yield* requestGate();
        fake.gate = gate;
        // The worker's refresh is waiting for its answer when the vault locks.
        yield* TestClock.adjust(Duration.seconds(50));
        yield* Deferred.await(gate.arrived);
        assert.strictEqual(tokenRequests(fake).length, 2);
        yield* vault.lock;
        fake.gate = null;
        // The server rotates the refresh token, which the locked vault cannot
        // take. The lock waits for the refresh to end before it shows.
        const locked = yield* service.states.pipe(
          Stream.filter((states) => states.get(NOTION)?._tag === "vault-locked"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Deferred.succeed(gate.open, undefined);
        yield* Fiber.join(locked);
        yield* vault.unlock(PASSWORD);
        // The next refresh sends the rotated token, which the server still knows.
        yield* service.rejected(NOTION, Option.none(), fake.bearer);
        assert.strictEqual(tokenRequests(fake).length, 3);
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
      }),
    );
  },
);

it.effect("follows the vault: locked, then each connector's state again once unlocked", () => {
  const fake = new FakeAuthorizationServer({ lifetime: 600 });
  return run(
    fake,
    Effect.gen(function* () {
      yield* signIn(fake);
      const vault = yield* Vault;
      const service = yield* auth;
      const changes = yield* service.states.pipe(
        Stream.map((states) => states.get(NOTION)?._tag),
        Stream.changes,
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* vault.lock;
      assert.strictEqual(refusal(yield* Effect.exit(service.accessToken(NOTION))), "VaultLocked");
      yield* vault.unlock(PASSWORD);
      assert.deepStrictEqual(
        [...(yield* Fiber.join(changes))],
        ["signed-in", "vault-locked", "signed-in"],
      );
      // The refresh it had scheduled came back with the unlock.
      yield* TestClock.adjust(Duration.minutes(5));
      assert.strictEqual(tokenRequests(fake).length, 2);
    }),
  );
});

it.effect("gives an issuer written with a trailing slash a callback of its own", () => {
  const fake = new FakeAuthorizationServer({ issuerPath: "/tenant/" });
  return run(
    fake,
    Effect.gen(function* () {
      const service = yield* auth;
      const { authorizationUrl } = yield* service.begin({
        connectorId: NOTION,
        deviceId: LAPTOP,
        redirect: { _tag: "paste" },
      });
      const back = new URL(fake.authorize(authorizationUrl));
      assert.strictEqual(
        `${back.origin}${back.pathname}`,
        "http://127.0.0.1/oauth/callback/auth.example.test/tenant/",
      );
      // The issuer without the slash is another one, and so is its path.
      back.pathname = "/oauth/callback/auth.example.test/tenant";
      const exit = yield* Effect.exit(
        service.complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back.href) }),
      );
      assert.strictEqual(refusal(exit), "address-mismatch");
    }),
  );
});

it.effect("drops a sign-in still being prepared when the connector is removed", () => {
  const fake = new FakeAuthorizationServer();
  return run(
    fake,
    Effect.gen(function* () {
      const service = yield* auth;
      const vault = yield* Vault;
      const gate = yield* requestGate("/register");
      fake.gate = gate;
      const beginning = yield* service
        .begin({ connectorId: NOTION, deviceId: LAPTOP, redirect: { _tag: "paste" } })
        .pipe(Effect.exit, Effect.forkChild);
      // The client is being registered when the operator removes the connector.
      yield* Deferred.await(gate.arrived);
      yield* service.disconnect(NOTION);
      yield* vault.connectorSecrets.remove(NOTION);
      yield* Deferred.succeed(gate.open, undefined);
      assert.strictEqual(refusal(yield* Fiber.join(beginning)), "unknown-sign-in");
      assert.isTrue(Option.isNone(yield* vault.connectorSecrets.get(NOTION)));
    }),
  );
});

it.effect("revokes the rotated tokens a locked vault could not take, when it disconnects", () => {
  const fake = new FakeAuthorizationServer({ lifetime: 100 });
  return run(
    fake,
    Effect.gen(function* () {
      yield* signIn(fake);
      const vault = yield* Vault;
      const service = yield* auth;
      const gate = yield* requestGate();
      fake.gate = gate;
      yield* TestClock.adjust(Duration.seconds(50));
      yield* Deferred.await(gate.arrived);
      yield* vault.lock;
      fake.gate = null;
      const locked = yield* service.states.pipe(
        Stream.filter((states) => states.get(NOTION)?._tag === "vault-locked"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.succeed(gate.open, undefined);
      yield* Fiber.join(locked);
      // The rotated refresh token is the grant; the vault only has the one it replaced.
      const rotated = fake.issued.filter((token) => token.startsWith("refresh")).at(-1);
      const exit = yield* Effect.exit(service.disconnect(NOTION));
      assert.include(fake.revoked, rotated);
      assert.strictEqual(fake.refreshTokens.size, 0);
      // Forgetting them needs the vault: the disconnect fails, to be tried again.
      assert.strictEqual(refusal(exit), "vault-locked");
    }),
  );
});

it.effect(
  "waits before trying again when a refresh answers a token that has already expired",
  () => {
    const fake = new FakeAuthorizationServer({ lifetime: 100 });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        const service = yield* auth;
        fake.options = { ...fake.options, lifetime: 0 };
        // Halfway through the token's life the worker refreshes, and gets an expired one.
        yield* TestClock.adjust(Duration.seconds(50));
        assert.strictEqual(tokenRequests(fake).length, 2);
        yield* TestClock.adjust(Duration.seconds(29));
        assert.strictEqual(tokenRequests(fake).length, 2);
        // The first retry's wait is over; the refresh token the server rotated still works.
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(tokenRequests(fake).length, 3);
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
        // No call is given a token that has expired.
        const exit = yield* Effect.exit(service.accessToken(NOTION));
        assert.strictEqual(refusal(exit), "refresh-failed");
      }),
    );
  },
);

it.effect("asks again for every scope calls were refused for, and those it has", () => {
  const fake = new FakeAuthorizationServer();
  return run(
    fake,
    Effect.gen(function* () {
      yield* signIn(fake);
      const service = yield* auth;
      for (const scope of ["admin", "audit"]) {
        const challenge = `Bearer error="insufficient_scope", scope="${scope}"`;
        const exit = yield* Effect.exit(
          service.rejected(NOTION, Option.some(challenge), fake.bearer),
        );
        assert.strictEqual(refusal(exit), "NeedsSignIn");
      }
      const { authorizationUrl } = yield* service.begin({
        connectorId: NOTION,
        deviceId: LAPTOP,
        redirect: { _tag: "paste" },
      });
      assert.strictEqual(
        new URL(authorizationUrl).searchParams.get("scope"),
        "read write admin audit",
      );
    }),
  );
});

it.effect("goes on to the next metadata address when one fails, and says so when all do", () =>
  Effect.gen(function* () {
    const oauth = "/.well-known/oauth-authorization-server";
    const fake = new FakeAuthorizationServer({ metadataAt: "oidc-inserted", failing: [oauth] });
    yield* run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
      }),
    );
    const down = new FakeAuthorizationServer({
      failing: [oauth, "/.well-known/openid-configuration"],
    });
    const exit = yield* run(
      down,
      Effect.exit(
        Effect.flatMap(auth, (service) =>
          service.begin({ connectorId: NOTION, deviceId: LAPTOP, redirect: { _tag: "paste" } }),
        ),
      ),
    );
    assert.strictEqual(refusal(exit), "unreachable");
  }),
);

it.effect(
  "leaves a newer sign-in alone when a request with the token it replaced is refused",
  () => {
    const fake = new FakeAuthorizationServer({ refresh: false });
    return run(
      fake,
      Effect.gen(function* () {
        yield* signIn(fake);
        const service = yield* auth;
        const replaced = fake.bearer;
        // The operator signs in again while a request with the first token is under way.
        yield* signIn(fake);
        const current = fake.bearer;
        yield* service.rejected(NOTION, Option.some('Bearer error="invalid_token"'), replaced);
        assert.strictEqual((yield* stateOf)?._tag, "signed-in");
        assert.deepStrictEqual(
          Option.some(Redacted.value(yield* service.accessToken(NOTION))),
          Option.map(current, Redacted.value),
        );
        assert.lengthOf(tokenRequests(fake), 2);
        // The current token, refused, still signs the connector out: it has no refresh token.
        const exit = yield* Effect.exit(
          service.rejected(NOTION, Option.some('Bearer error="invalid_token"'), current),
        );
        assert.strictEqual(refusal(exit), "NeedsSignIn");
      }),
    );
  },
);
