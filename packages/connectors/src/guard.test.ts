// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The guard is tested against Node's own HTTP server, on loopback.
import * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isPublicAddress } from "./address.ts";
import { ResponseTooLarge, UrlRefused } from "./errors.ts";
import {
  checkUrl,
  DEFAULT_GUARD,
  makeGuardedFetch,
  type Resolver,
  type UrlPolicy,
} from "./guard.ts";

const REMOTE: UrlPolicy = { loopback: "refuse", privateNetwork: "refuse", redirects: "recheck" };
const CONFIRMED: UrlPolicy = { ...REMOTE, privateNetwork: "allow" };
const COMMAND: UrlPolicy = {
  loopback: "allow-http",
  privateNetwork: "refuse",
  redirects: "recheck",
};

const refusal = (url: string, policy: UrlPolicy) => {
  const result = checkUrl(url, policy);
  return Result.isFailure(result) ? result.failure.reason : "allowed";
};

/** A loopback HTTP server answering with `handler`, counting the connections it accepted. */
const serve = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: NodeHttp.Server;
      readonly port: number;
      connections: number;
    }>((resume) => {
      const server = NodeHttp.createServer(handler);
      const state = { server, port: 0, connections: 0 };
      server.on("connection", () => {
        state.connections++;
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        state.port = address !== null && typeof address === "object" ? address.port : 0;
        resume(Effect.succeed(state));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

const isRefused = Schema.is(UrlRefused);

const failureOf = (promise: () => Promise<unknown>) =>
  Effect.promise(() =>
    promise().then(
      () => null,
      (error: unknown) => error,
    ),
  );

describe("checkUrl", () => {
  it("takes only https with no user information to a host that isn't private", () => {
    assert.strictEqual(refusal("https://mcp.example.com/mcp", REMOTE), "allowed");
    assert.strictEqual(refusal("https://93.184.215.14/mcp", REMOTE), "allowed");
    assert.strictEqual(refusal("http://mcp.example.com/mcp", REMOTE), "not-https");
    assert.strictEqual(refusal("ftp://mcp.example.com/", REMOTE), "not-https");
    assert.strictEqual(refusal("not a url", REMOTE), "invalid-url");
    assert.strictEqual(refusal("https://user:secret@mcp.example.com/", REMOTE), "userinfo");
    assert.strictEqual(refusal("https://user@mcp.example.com/", REMOTE), "userinfo");
  });

  it("refuses private, loopback, link-local and reserved literals, however they are written", () => {
    for (const host of [
      "169.254.169.254",
      "127.0.0.1",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:a9fe:a9fe]",
      "[64:ff9b::a00:1]",
      "[2002:a00:1::]",
      "2130706433",
      "0x7f.1",
      "localhost",
      "api.localhost",
    ]) {
      assert.strictEqual(refusal(`https://${host}/mcp`, REMOTE), "private-address", host);
    }
  });

  it("says when only the operator's confirmation stands between a URL and their own network", () => {
    for (const host of ["10.0.0.1", "192.168.1.1", "172.16.5.4", "100.64.0.1", "[fd00::1]"]) {
      assert.strictEqual(refusal(`https://${host}/mcp`, REMOTE), "private-network", host);
    }
  });

  it("reaches a private network only when the operator confirmed it, and never loopback or link-local", () => {
    assert.strictEqual(refusal("https://192.168.1.20/mcp", CONFIRMED), "allowed");
    assert.strictEqual(refusal("https://[fd12::5]/mcp", CONFIRMED), "allowed");
    assert.strictEqual(refusal("https://169.254.169.254/mcp", CONFIRMED), "private-address");
    assert.strictEqual(refusal("https://127.0.0.1/mcp", CONFIRMED), "private-address");
    assert.strictEqual(refusal("http://192.168.1.20/mcp", CONFIRMED), "not-https");
  });

  it("lets a command connector use plain HTTP to loopback, and nothing else", () => {
    assert.strictEqual(refusal("http://127.0.0.1:7777/mcp", COMMAND), "allowed");
    assert.strictEqual(refusal("http://[::1]:7777/mcp", COMMAND), "allowed");
    assert.strictEqual(refusal("http://localhost:7777/mcp", COMMAND), "allowed");
    assert.strictEqual(refusal("http://mcp.example.com/mcp", COMMAND), "not-https");
    assert.strictEqual(refusal("http://192.168.1.1/mcp", COMMAND), "not-https");
    assert.strictEqual(refusal("https://10.0.0.1/mcp", COMMAND), "private-address");
  });
});

describe("isPublicAddress", () => {
  it("counts only public unicast", () => {
    assert.isTrue(isPublicAddress("93.184.215.14"));
    assert.isTrue(isPublicAddress("2606:4700::1111"));
    assert.isFalse(isPublicAddress("::ffff:10.0.0.1"));
    assert.isFalse(isPublicAddress("2001:db8::1"));
    assert.isFalse(isPublicAddress("ff02::1"));
    assert.isFalse(isPublicAddress("224.0.0.1"));
    assert.isFalse(isPublicAddress("mcp.example.com"));
  });
});

describe("makeGuardedFetch", () => {
  it.effect("refuses a name that resolves to a private address, without connecting", () =>
    Effect.gen(function* () {
      const target = yield* serve((_, response) => response.end("reached"));
      // The name passes the URL check; only its addresses, resolved at connect time, show where it leads.
      const rebinding: Resolver = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
      const fetch = yield* makeGuardedFetch(REMOTE, { ...DEFAULT_GUARD, resolve: rebinding });
      const error = yield* failureOf(() => fetch(`https://rebound.example:${target.port}/mcp`));
      assert.isTrue(isRefused(error) && error.reason === "private-address");
      assert.strictEqual(target.connections, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a name with any private address among its public ones", () =>
    Effect.gen(function* () {
      const mixed: Resolver = () =>
        Promise.resolve([
          { address: "93.184.215.14", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ]);
      const fetch = yield* makeGuardedFetch(REMOTE, { ...DEFAULT_GUARD, resolve: mixed });
      const error = yield* failureOf(() => fetch("https://mixed.example/mcp"));
      assert.isTrue(isRefused(error) && error.reason === "private-network");
    }).pipe(Effect.scoped),
  );

  it.effect("checks a name each time it connects, so a later private answer is refused", () =>
    Effect.gen(function* () {
      const target = yield* serve((_, response) => response.end("reached"));
      const answers = ["127.0.0.1", "169.254.169.254"];
      // Loopback is allowed for a command connector; the second lookup of the same name turns link-local.
      const rebinding: Resolver = () =>
        Promise.resolve([{ address: answers.shift() ?? "169.254.169.254", family: 4 }]);
      const fetch = yield* makeGuardedFetch(COMMAND, { ...DEFAULT_GUARD, resolve: rebinding });
      const first = yield* Effect.promise(() =>
        fetch(`https://localhost:${target.port}/`).then(
          () => "answered",
          () => "failed",
        ),
      );
      // The first lookup is loopback and allowed: it connects (TLS to a plain server then fails).
      assert.strictEqual(first, "failed");
      assert.strictEqual(target.connections, 1);
      const second = yield* failureOf(() => fetch(`https://localhost:${target.port}/`));
      assert.isTrue(isRefused(second) && second.reason === "private-address");
      assert.strictEqual(target.connections, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("hands back a redirect to be checked again, or refuses it", () =>
    Effect.gen(function* () {
      const target = yield* serve((_, response) => {
        response.writeHead(302, { location: "http://10.0.0.7/admin" });
        response.end();
      });
      const url = `http://127.0.0.1:${target.port}/mcp`;
      const recheck = yield* makeGuardedFetch(COMMAND);
      const answer = yield* Effect.promise(() => recheck(url, { redirect: "follow" }));
      assert.strictEqual(answer.status, 302);
      const location = answer.headers.get("location") ?? "";
      const followed = yield* failureOf(() => recheck(location));
      assert.isTrue(isRefused(followed) && followed.reason === "not-https");

      const refuse = yield* makeGuardedFetch({ ...COMMAND, redirects: "refuse" });
      const refused = yield* failureOf(() => refuse(url));
      assert.isTrue(isRefused(refused) && refused.reason === "redirect");
    }).pipe(Effect.scoped),
  );

  it.effect("stops reading an answer past its size limit", () =>
    Effect.gen(function* () {
      const target = yield* serve((_, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("x".repeat(64 * 1024));
      });
      const fetch = yield* makeGuardedFetch(COMMAND, { ...DEFAULT_GUARD, maxResponseBytes: 1024 });
      const answer = yield* Effect.promise(() => fetch(`http://127.0.0.1:${target.port}/`));
      const error = yield* failureOf(() => answer.text());
      assert.isTrue(Schema.is(ResponseTooLarge)(error));
    }).pipe(Effect.scoped),
  );

  it.effect("sends the method, headers and body it was given", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const target = yield* serve((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        request.on("end", () => {
          seen.push(`${request.method} ${request.headers["x-probe"]} ${body}`);
          response.end("ok");
        });
      });
      const fetch = yield* makeGuardedFetch(COMMAND);
      const answer = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${target.port}/mcp`, {
          method: "POST",
          headers: { "x-probe": "1" },
          body: '{"jsonrpc":"2.0"}',
        }),
      );
      assert.strictEqual(yield* Effect.promise(() => answer.text()), "ok");
      assert.deepStrictEqual(seen, ['POST 1 {"jsonrpc":"2.0"}']);
    }).pipe(Effect.scoped),
  );
});
