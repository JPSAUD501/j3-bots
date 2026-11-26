// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { InMemoryResponseCacheStore } from "@modelcontextprotocol/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION } from "@j3-bots/contracts";
import { NeedsSignIn } from "./errors.ts";
import type { UrlPolicy } from "./guard.ts";
import {
  type CallCredentials,
  type ConnectorCredentials,
  DEFAULT_SESSION_LIMITS,
  type ListKind,
  openSession,
  type SessionLimits,
  scrubberOf,
} from "./session.ts";
import { TASKS_EXTENSION } from "./tasks.ts";
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
  hidden: [],
});

const echo: FakeOptions["call"] = (name, args) => ({
  _tag: "result",
  text: `${name} ${JSON.stringify(args)}`,
});

const open = (
  url: string,
  credentials: ConnectorCredentials,
  limits: Partial<SessionLimits> = {},
  onListChanged: (kind: ListKind) => Effect.Effect<void> = () => Effect.void,
) =>
  openSession({
    url: new URL(url),
    policy: POLICY,
    credentials,
    limits: { ...DEFAULT_SESSION_LIMITS, ...limits },
    client: { name: "j3-bots-test", version: "0.0.0" },
    cache: new InMemoryResponseCacheStore(),
    onListChanged,
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
      assert.deepStrictEqual(answer, {
        text: 'search {"q":"x"}',
        isError: false,
        cut: false,
        result: { content: [{ type: "text", text: 'search {"q":"x"}' }], isError: false },
      });
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
        type Refusal = readonly [Option.Option<string>, string];
        const seen = yield* Ref.make<ReadonlyArray<Refusal>>([]);
        const credentials: ConnectorCredentials = {
          current: Effect.map(Ref.get(current), bearer),
          rejected: (wwwAuthenticate, sent) =>
            Ref.update(seen, (all): ReadonlyArray<Refusal> => [
              ...all,
              [
                wwwAuthenticate,
                Option.match(sent.bearer, { onNone: () => "", onSome: Redacted.value }),
              ],
            ]).pipe(Effect.andThen(Ref.set(current, RENEWED))),
        };
        const session = yield* open(fake.url, credentials);
        yield* session.listTools;
        // The refusal names the token it refused, so one renewed meanwhile is not renewed again.
        assert.deepStrictEqual(yield* Ref.get(seen), [[Option.some(challenge), TOKEN]]);
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
            hidden: [],
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
        // The whole answer an app is given is not cut, and has no secret either.
        assert.deepStrictEqual(leaks(JSON.stringify(answer.result), [TOKEN, API_KEY]), []);
        assert.include(JSON.stringify(answer.result), "Bearer [redacted] and [redacted]");
      }).pipe(Effect.scoped),
  );

  it.effect("gives an app a structured answer without a short secret, and still as JSON", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMcpServer({
        tools: [{ name: "lock" }],
        call: () => ({
          _tag: "result",
          text: "set",
          structuredContent: { pin: 4096, note: "PIN:\n4096", page: 2 },
        }),
      });
      const credentials = fixed({ ...bearer(TOKEN), hidden: [Redacted.make("4096")] });
      const session = yield* open(fake.url, credentials);
      const answer = yield* session.callTool({ name: "lock", arguments: {} });
      assert.deepInclude(answer.result, {
        structuredContent: { pin: "[redacted]", note: "PIN:\n[redacted]", page: 2 },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tells the server it shows apps, and reads a tool's app without its secrets", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMcpServer({
        tools: [{ name: "stock", _meta: { ui: { resourceUri: "ui://stock" } } }],
        call: echo,
        resources: (uri) =>
          uri === "ui://stock"
            ? [{ uri, mimeType: MCP_APP_MIME_TYPE, text: `<p>key ${API_KEY}</p>` }]
            : uri === "ui://stock-blob"
              ? [
                  {
                    uri,
                    mimeType: MCP_APP_MIME_TYPE,
                    blob: Buffer.from(`<p>key ${API_KEY}</p>`).toString("base64"),
                  },
                ]
              : undefined,
      });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)));
      assert.deepInclude(fake.clientCapabilities[0], {
        extensions: {
          [TASKS_EXTENSION]: {},
          [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
        },
      });
      const [tool] = yield* session.listTools;
      assert.deepStrictEqual(tool?.ui, { resourceUri: "ui://stock" });
      const read = yield* session.readAppResource("ui://stock", 64 * 1024);
      assert.deepStrictEqual(read, {
        contents: [
          { uri: "ui://stock", mimeType: MCP_APP_MIME_TYPE, text: "<p>key [redacted]</p>" },
        ],
      });
      // A document sent as base64 is scrubbed as its text.
      assert.deepStrictEqual(yield* session.readAppResource("ui://stock-blob", 64 * 1024), {
        contents: [
          {
            uri: "ui://stock-blob",
            mimeType: MCP_APP_MIME_TYPE,
            blob: Buffer.from("<p>key [redacted]</p>").toString("base64"),
          },
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("gives no resource larger than it was asked for", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMcpServer({
        tools: [],
        call: echo,
        resources: (uri) => [{ uri, mimeType: MCP_APP_MIME_TYPE, text: "y".repeat(2_000) }],
      });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)));
      assert.isNull(yield* session.readAppResource("ui://big", 1_000));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "takes out the token a call was sent with, though the store holds another by its answer",
    () =>
      Effect.gen(function* () {
        let token = TOKEN;
        const fake = yield* fakeMcpServer({
          tools: [{ name: "whoami" }],
          call: (_, __, headers) => {
            // The sign-in renews its token while the call runs.
            token = RENEWED;
            return { _tag: "result", text: `you sent ${headers.authorization}` };
          },
        });
        const credentials: ConnectorCredentials = {
          current: Effect.sync(() => bearer(token)),
          rejected: () => Effect.fail(new NeedsSignIn()),
        };
        const session = yield* open(fake.url, credentials);
        const answer = yield* session.callTool({ name: "whoami", arguments: {} });
        assert.strictEqual(answer.text, "you sent Bearer [redacted]");
      }).pipe(Effect.scoped),
  );

  it.effect("takes the connector's secrets and its address' query out of the tools it lists", () =>
    Effect.gen(function* () {
      const query = "addr_7e6d5c4b3a291807";
      const fake = yield* fakeMcpServer({
        tools: [
          {
            name: "search",
            description: `Searches with ${API_KEY} at ?key=${query}`,
            inputSchema: {
              type: "object",
              properties: { token: { type: "string", default: TOKEN } },
            },
          },
          { name: API_KEY, description: "Named for the key." },
        ],
        call: echo,
      });
      const session = yield* open(`${fake.url}?key=${query}`, fixed(bearer(TOKEN)));
      const tools = yield* session.listTools;
      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        ["search"],
      );
      assert.deepStrictEqual(leaks(JSON.stringify(tools), [TOKEN, API_KEY, query]), []);
    }).pipe(Effect.scoped),
  );

  it.effect("reads a listing page by page, and stops at one past its budget", () =>
    Effect.gen(function* () {
      const tools = Array.from({ length: 10 }, (_, n) => ({
        name: `tool_${n}`,
        description: "d".repeat(900),
        inputSchema: { type: "object", description: "s".repeat(4_000) },
      }));
      const fake = yield* fakeMcpServer({ tools, call: echo, pageSize: 2 });
      const pages = () => fake.requests.filter((request) => request.rpc === "tools/list").length;

      const whole = yield* open(fake.url, fixed(bearer(TOKEN)));
      assert.deepStrictEqual(
        (yield* whole.listTools).map((tool) => tool.name),
        tools.map((tool) => tool.name),
      );
      assert.strictEqual(pages(), 5);

      // About three tools' worth of answers: the second page passes it, and the third is never asked for.
      const bounded = yield* open(fake.url, fixed(bearer(TOKEN)), { maxCatalogBytes: 15_000 });
      const error = yield* Effect.flip(bounded.listTools);
      assert.strictEqual(error._tag, "ResponseTooLarge");
      assert.strictEqual(pages(), 7);
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

  it.effect(
    "ends a call that is stopped or outlasts its deadline, and closes its request at a server that ignores cancellation",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMcpServer({ tools: [], call: () => ({ _tag: "hang" }) });
        const session = yield* open(fake.url, fixed(bearer(TOKEN)));
        const slow = session.callTool({ name: "slow", arguments: {} });
        for (let round = 1; round <= 3; round++) {
          const stopped = yield* Effect.forkChild(slow);
          yield* fake.held(2 * round - 1);
          yield* Fiber.interrupt(stopped);

          const late = yield* Effect.forkChild(Effect.flip(slow));
          yield* fake.held(2 * round);
          yield* TestClock.adjust(DEFAULT_SESSION_LIMITS.callDeadline);
          assert.strictEqual((yield* Fiber.join(late))._tag, "TimedOut");
        }
        // The server is told, and ignores it; every request it held is closed all the same.
        yield* fake.cancelled;
        yield* fake.released;
      }).pipe(Effect.scoped),
  );

  it.effect("hears when the server's tools change", () =>
    Effect.gen(function* () {
      const changed = yield* Deferred.make<void>();
      const fake = yield* fakeMcpServer({ tools: [{ name: "search" }], call: echo });
      const session = yield* open(fake.url, fixed(bearer(TOKEN)), {}, (kind) =>
        kind === "tools" ? Deferred.succeed(changed, undefined) : Effect.void,
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

describe("scrubberOf", () => {
  it("finds a value as given and as a JSON string holds it", () => {
    const secret = 'pa"ss\\word-42';
    const scrub = scrubberOf([secret]);
    assert.strictEqual(scrub(`token ${secret}`), "token [redacted]");
    assert.strictEqual(scrub(JSON.stringify({ token: secret })), '{"token":"[redacted]"}');
  });

  it("takes a short secret out only where it stands as a word of its own", () => {
    const scrub = scrubberOf([], ["4096"]);
    assert.strictEqual(scrub("PIN 4096, set."), "PIN [redacted], set.");
    assert.strictEqual(scrub('{"pin":"4096"}'), '{"pin":"[redacted]"}');
    // After a JSON escape, as a structured answer's text holds it.
    assert.strictEqual(
      scrub(JSON.stringify({ note: "PIN:\n4096" })),
      '{"note":"PIN:\\n[redacted]"}',
    );
    // Inside a longer number or word it is ordinary text.
    assert.strictEqual(scrub("order 140960 and v4096b"), "order 140960 and v4096b");
  });

  it("leaves ordinary text alone: a short value not known to be a secret, and one too short to look for", () => {
    const scrub = scrubberOf(["info"], ["abc"]);
    assert.strictEqual(scrub("info: abc"), "info: abc");
  });
});
