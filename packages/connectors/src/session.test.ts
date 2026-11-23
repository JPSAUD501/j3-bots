// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { NeedsSignIn } from "./errors.ts";
import type { UrlPolicy } from "./guard.ts";
import {
  type CallCredentials,
  type ConnectorCredentials,
  DEFAULT_SESSION_LIMITS,
  openSession,
  type SessionLimits,
} from "./session.ts";
import { type FakeOptions, fakeMcpServer } from "./testing/fakeMcpServer.ts";

// The fake listens on loopback over plain HTTP, as a command connector's server would.
const POLICY: UrlPolicy = {
  loopback: "allow-http",
  privateNetwork: "refuse",
  redirects: "recheck",
};

const TOKEN = "tok_live_0123456789abcdef";
const RENEWED = "tok_live_renewed_fedcba9876";
const API_KEY = "key_9f8e7d6c5b4a39281706";

const fixed = (credentials: CallCredentials): ConnectorCredentials => ({
  current: Effect.succeed(credentials),
  rejected: () => Effect.fail(new NeedsSignIn()),
});

const bearer = (token: string): CallCredentials => ({
  bearer: Option.some(Redacted.make(token)),
  headers: [{ name: "X-Api-Key", value: Redacted.make(API_KEY) }],
});

const echo: FakeOptions["call"] = (name, args) => ({
  _tag: "result",
  text: `${name} ${JSON.stringify(args)}`,
});

const open = (
  url: string,
  credentials: ConnectorCredentials,
  limits: Partial<SessionLimits> = {},
  onToolsChanged: Effect.Effect<void> = Effect.void,
) =>
  openSession({
    url: new URL(url),
    policy: POLICY,
    credentials,
    limits: { ...DEFAULT_SESSION_LIMITS, ...limits },
    client: { name: "j3-bots-test", version: "0.0.0" },
    onToolsChanged,
  });

/** Everything an error could leak through: its message, its fields and its JSON. */
const leaks = (error: unknown, secrets: ReadonlyArray<string>) => {
  const seen = `${String(error)} ${JSON.stringify(error)} ${error instanceof Error ? error.message : ""}`;
  return secrets.filter((secret) => seen.includes(secret));
};

describe("openSession", () => {
  it.effect("adds the token and headers from the store to every request, and calls tools", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMcpServer({ tools: [{ name: "search" }], call: echo });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)));
      const tools = yield* session.listTools;
      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        ["search"],
      );
      const answer = yield* session.callTool({ name: "search", arguments: { q: "x" } });
      assert.deepStrictEqual(answer, { text: 'search {"q":"x"}', isError: false, cut: false });
      assert.isAbove(fake.requests.length, 2);
      for (const request of fake.requests) {
        assert.strictEqual(request.headers.authorization, `Bearer ${TOKEN}`);
        assert.strictEqual(request.headers["x-api-key"], API_KEY);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "renews a refused token once, and needs a sign-in when the new one is refused too",
    () =>
      Effect.gen(function* () {
        let accepted = RENEWED;
        const current = yield* Ref.make(TOKEN);
        const fake = yield* fakeMcpServer({
          tools: [{ name: "search" }],
          call: echo,
          authorize: (authorization) => authorization === `Bearer ${accepted}`,
        });
        const renewals = yield* Ref.make(0);
        const credentials: ConnectorCredentials = {
          current: Effect.map(Ref.get(current), bearer),
          rejected: () =>
            Ref.update(renewals, (n) => n + 1).pipe(Effect.andThen(Ref.set(current, RENEWED))),
        };
        const session = yield* open(fake.url, credentials);
        assert.strictEqual(yield* Ref.get(renewals), 1);
        yield* session.listTools;

        // The service ends the sign-in: the renewed token is refused as well.
        accepted = "nothing anyone holds";
        const error = yield* Effect.flip(session.callTool({ name: "search", arguments: {} }));
        assert.strictEqual(error._tag, "NeedsSignIn");
        assert.strictEqual(yield* Ref.get(renewals), 2);
        assert.deepStrictEqual(leaks(error, [TOKEN, RENEWED, API_KEY]), []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "asks for a sign-in with more scope when the server answers 403 insufficient_scope",
    () =>
      Effect.gen(function* () {
        const challenge = 'Bearer error="insufficient_scope", scope="issues:write"';
        const fake = yield* fakeMcpServer({
          tools: [{ name: "search" }],
          call: echo,
          authorize: (authorization) => authorization === `Bearer ${RENEWED}`,
          refusal: { status: 403, challenge },
        });
        const current = yield* Ref.make(TOKEN);
        const seen = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([]);
        const credentials: ConnectorCredentials = {
          current: Effect.map(Ref.get(current), bearer),
          rejected: (wwwAuthenticate) =>
            Ref.update(seen, (all) => [...all, wwwAuthenticate]).pipe(
              Effect.andThen(Ref.set(current, RENEWED)),
            ),
        };
        const session = yield* open(fake.url, credentials);
        yield* session.listTools;
        assert.deepStrictEqual(yield* Ref.get(seen), [Option.some(challenge)]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a stored header that would start another header or replace the transport's",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMcpServer({ tools: [], call: echo });
        for (const header of [
          { name: "X-Api-Key", value: `${API_KEY}\r\nX-Injected: 1` },
          { name: "X-Api-Key\r\nX-Injected", value: API_KEY },
          { name: "Mcp-Session-Id", value: API_KEY },
          { name: "Host", value: "elsewhere.example" },
        ]) {
          const credentials = fixed({
            bearer: Option.none(),
            headers: [{ name: header.name, value: Redacted.make(header.value) }],
          });
          const error = yield* Effect.flip(open(fake.url, credentials));
          assert.deepStrictEqual(
            { tag: error._tag, reason: error._tag === "AuthFailing" ? error.reason : null },
            { tag: "AuthFailing", reason: "secret-unusable" },
          );
          assert.deepStrictEqual(leaks(error, [API_KEY]), []);
        }
        assert.strictEqual(fake.requests.length, 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "takes the connector's secrets out of an answer that echoes them, and cuts a long one",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMcpServer({
          tools: [{ name: "whoami" }],
          call: (_, __, headers) => ({
            _tag: "result",
            text: `you sent ${headers.authorization} and ${headers["x-api-key"]}`,
          }),
        });
        const session = yield* open(fake.url, fixed(bearer(TOKEN)), { maxResultCharacters: 40 });
        const answer = yield* session.callTool({ name: "whoami", arguments: {} });
        assert.deepStrictEqual(leaks(answer.text, [TOKEN, API_KEY]), []);
        assert.isTrue(answer.cut);
        assert.strictEqual(answer.text, "you sent Bearer [redacted] and [redacted");
      }).pipe(Effect.scoped),
  );

  it.effect("stops reading an answer larger than the guard reads", () =>
    Effect.gen(function* () {
      const huge = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "x".repeat(200_000) }] },
      });
      const fake = yield* fakeMcpServer({ tools: [], call: () => ({ _tag: "raw", body: huge }) });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)), {
        guard: { ...DEFAULT_SESSION_LIMITS.guard, maxResponseBytes: 64 * 1024 },
      });
      const error = yield* Effect.flip(session.callTool({ name: "big", arguments: {} }));
      assert.strictEqual(error._tag, "ResponseTooLarge");
    }).pipe(Effect.scoped),
  );

  it.effect("gives up on a call that outlasts its deadline", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMcpServer({ tools: [], call: () => ({ _tag: "hang" }) });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)));
      const call = yield* Effect.forkChild(
        Effect.flip(session.callTool({ name: "slow", arguments: {} })),
      );
      yield* fake.callArrived;
      yield* TestClock.adjust(DEFAULT_SESSION_LIMITS.callDeadline);
      const error = yield* Fiber.join(call);
      assert.strictEqual(error._tag, "TimedOut");
    }).pipe(Effect.scoped),
  );

  it.effect("tells the server to stop a call that is interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMcpServer({ tools: [], call: () => ({ _tag: "hang" }) });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)));
      const call = yield* Effect.forkChild(session.callTool({ name: "slow", arguments: {} }));
      yield* fake.callArrived;
      yield* Fiber.interrupt(call);
      yield* fake.cancelled;
    }).pipe(Effect.scoped),
  );

  it.effect("hears when the server's tools change", () =>
    Effect.gen(function* () {
      const changed = yield* Deferred.make<void>();
      const fake = yield* fakeMcpServer({ tools: [{ name: "search" }], call: echo });
      const session = yield* open(
        fake.url,
        fixed(bearer(TOKEN)),
        {},
        Deferred.succeed(changed, undefined),
      );
      yield* session.listTools;
      // The session opens its stream for server messages after the handshake.
      yield* fake.streamOpened;
      fake.setTools([{ name: "search" }, { name: "delete_everything" }]);
      fake.notifyToolsChanged();
      yield* Deferred.await(changed);
      assert.deepStrictEqual(
        (yield* session.listTools).map((tool) => tool.name),
        ["search", "delete_everything"],
      );
    }).pipe(Effect.scoped),
  );
});
