// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { CuratedKey, RegistryName } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import * as Registry from "./Registry.ts";
import * as Sources from "./Sources.ts";

/** How the registry answers one request: a status and a body, after a while or at once, or never. */
interface Answered {
  readonly status: number;
  readonly body: string;
  readonly after?: Duration.Duration;
}
type Answer = Answered | "never";

const json = (body: unknown): Answered => ({ status: 200, body: JSON.stringify(body) });

const server = (name: string, url: string | null, extra: Record<string, unknown> = {}) => ({
  server: {
    name,
    description: `About ${name}`,
    version: "1.0.0",
    ...(url === null ? {} : { remotes: [{ type: "streamable-http", url }] }),
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  ...extra,
});

const page = (servers: ReadonlyArray<unknown>, nextCursor?: string) =>
  json({
    servers,
    metadata: { count: servers.length, ...(nextCursor === undefined ? {} : { nextCursor }) },
  });

/**
 * The registry as the network delivers it: every request is recorded, and
 * answered as the test says; by default, with an empty page.
 */
class RegistryWire extends Context.Service<
  RegistryWire,
  {
    readonly requests: Array<URL>;
    answer: (url: URL, n: number) => Answer;
  }
>()("@j3-bots/server/connectors/sources/Registry.test/RegistryWire") {}

const wire = Layer.effectContext(
  Effect.sync(() => {
    const state = RegistryWire.of({ requests: [], answer: () => page([]) });
    const client = HttpClient.make((request, url) => {
      state.requests.push(url);
      const answer = state.answer(url, state.requests.length);
      if (answer === "never") return Effect.never;
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(answer.body, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        }),
      );
      return answer.after === undefined
        ? Effect.succeed(response)
        : Effect.as(Effect.sleep(answer.after), response);
    });
    return Context.make(RegistryWire, state).pipe(Context.add(HttpClient.HttpClient, client));
  }),
);

const registryLayer = Registry.layer.pipe(Layer.provideMerge(wire));
const sourcesLayer = Sources.layer.pipe(Layer.provideMerge(registryLayer));

const answering = (answer: (url: URL, n: number) => Answer) =>
  Effect.gen(function* () {
    const state = yield* RegistryWire;
    state.answer = answer;
    return state;
  });

describe("the registry search", () => {
  it.effect(
    "reads a few pages at most, and ranks entries whose publisher owns their host first",
    () =>
      Effect.gen(function* () {
        const state = yield* answering((url, n) =>
          page(
            [
              server(`ai.wrapper/notion-${n}`, "https://wrapper.example.net/mcp"),
              server(`com.notion/mcp-${n}`, "https://mcp.notion.com/mcp"),
              // Gone, or without a name J3 Bots can address: never offered.
              server(`ai.gone/notion-${n}`, "https://gone.example.net/mcp", {
                _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
              }),
              { server: { description: "no name" } },
            ],
            `cursor-${n}`,
          ),
        );
        const registry = yield* Registry.McpRegistry;
        const found = yield* registry.search("  Notion ");
        assert.strictEqual(state.requests.length, Registry.MAX_PAGES);
        const [first, second] = state.requests;
        assert.strictEqual(first?.searchParams.get("search"), "notion");
        assert.strictEqual(first?.searchParams.get("version"), "latest");
        assert.isFalse(first?.searchParams.has("cursor"));
        assert.strictEqual(second?.searchParams.get("cursor"), "cursor-1");
        assert.deepStrictEqual(
          found.map((entry) => [entry.name, entry.owner]),
          [
            ["com.notion/mcp-1", "notion.com"],
            ["com.notion/mcp-2", "notion.com"],
            ["com.notion/mcp-3", "notion.com"],
            ["ai.wrapper/notion-1", null],
            ["ai.wrapper/notion-2", null],
            ["ai.wrapper/notion-3", null],
          ],
        );
      }).pipe(Effect.provide(registryLayer)),
  );

  it.effect("answers the same query from its cache for an hour, then asks again", () =>
    Effect.gen(function* () {
      const state = yield* answering(() =>
        page([server("com.notion/mcp", "https://mcp.notion.com/mcp")]),
      );
      const registry = yield* Registry.McpRegistry;
      // Asked at once by two searches: one request.
      yield* Effect.all([registry.search("notion"), registry.search("NOTION")], {
        concurrency: "unbounded",
      });
      assert.strictEqual(state.requests.length, 1);
      yield* TestClock.adjust(Duration.subtract(Registry.SEARCH_TTL, Duration.seconds(1)));
      yield* registry.search("notion");
      assert.strictEqual(state.requests.length, 1);
      yield* TestClock.adjust(Duration.seconds(2));
      yield* registry.search("notion");
      assert.strictEqual(state.requests.length, 2);
    }).pipe(Effect.provide(registryLayer)),
  );

  it.effect("gives up on a registry that does not answer, and remembers that for a minute", () =>
    Effect.gen(function* () {
      const state = yield* answering(() => "never");
      const registry = yield* Registry.McpRegistry;
      const search = yield* Effect.forkChild(registry.search("notion").pipe(Effect.exit));
      yield* TestClock.adjust(Registry.REQUEST_TIMEOUT);
      const exit = yield* Fiber.join(search);
      assert.isTrue(Exit.isFailure(exit));

      state.answer = () => page([server("com.notion/mcp", "https://mcp.notion.com/mcp")]);
      assert.isTrue(Exit.isFailure(yield* registry.search("notion").pipe(Effect.exit)));
      assert.strictEqual(state.requests.length, 1);
      yield* TestClock.adjust(Registry.FAILURE_TTL);
      assert.lengthOf(yield* registry.search("notion"), 1);
    }).pipe(Effect.provide(registryLayer)),
  );

  it.effect("keeps what it read when a later page is larger than it reads", () =>
    Effect.gen(function* () {
      const huge = "x".repeat(Registry.MAX_ANSWER_BYTES);
      yield* answering((_, n) =>
        n === 1
          ? page([server("com.notion/mcp", "https://mcp.notion.com/mcp")], "next")
          : json({ servers: [], filler: huge }),
      );
      const registry = yield* Registry.McpRegistry;
      assert.lengthOf(yield* registry.search("notion"), 1);
    }).pipe(Effect.provide(registryLayer)),
  );

  it.effect("stops reading pages when its time is spent, and keeps what it read", () =>
    Effect.gen(function* () {
      // Each page takes three seconds: the third would end past the budget.
      const state = yield* answering((_, n) => ({
        ...page([server(`com.notion/mcp-${n}`, "https://mcp.notion.com/mcp")], `cursor-${n}`),
        after: Duration.seconds(3),
      }));
      const registry = yield* Registry.McpRegistry;
      const search = yield* Effect.forkChild(registry.search("notion"));
      for (let second = 0; second < Duration.toSeconds(Registry.SEARCH_BUDGET); second++) {
        yield* TestClock.adjust(Duration.seconds(1));
      }
      const found = yield* Fiber.join(search);
      assert.strictEqual(state.requests.length, 3);
      assert.deepStrictEqual(
        found.map((entry) => entry.name),
        ["com.notion/mcp-1", "com.notion/mcp-2"],
      );
    }).pipe(Effect.provide(registryLayer)),
  );

  it.effect("reads one entry by name, and has none for a name the registry does not know", () =>
    Effect.gen(function* () {
      const state = yield* answering((url) =>
        url.pathname.endsWith("/com.notion%2Fmcp/versions/latest")
          ? json(server("com.notion/mcp", "https://mcp.notion.com/mcp"))
          : { status: 404, body: JSON.stringify({ title: "Not Found" }) },
      );
      const registry = yield* Registry.McpRegistry;
      const notion = yield* registry.get(RegistryName.make("com.notion/mcp"));
      assert.strictEqual(Option.getOrNull(notion)?.owner, "notion.com");
      assert.isTrue(Option.isNone(yield* registry.get(RegistryName.make("com.example/none"))));
      yield* registry.get(RegistryName.make("com.notion/mcp"));
      assert.strictEqual(state.requests.length, 2);
    }).pipe(Effect.provide(registryLayer)),
  );
});

describe("the gallery's sources", () => {
  it.effect("list curated matches first, without the registry's copies of them", () =>
    Effect.gen(function* () {
      yield* answering(() =>
        page([
          server("com.notion/mcp", "https://mcp.notion.com/mcp"),
          server("ai.wrapper/notion", "https://mcp.notion.com/mcp"),
          server("com.example/notion-sync", "https://mcp.example.com/mcp"),
          // Only legacy SSE, or only packages: not offered unless asked for all.
          server("com.example/notion-sse", null, {}),
        ]),
      );
      const sources = yield* Sources.ConnectorSources;
      const found = yield* sources.search({ query: "notion", language: "en", all: false });
      assert.strictEqual(found.registry, "answered");
      assert.deepStrictEqual(
        found.listings.map((listing) => [listing.ref, listing.connect, listing.publisher]),
        [
          [
            { _tag: "curated", key: CuratedKey.make("notion") },
            "sign-in",
            { _tag: "domain", domain: "notion.com" },
          ],
          [
            { _tag: "registry", name: RegistryName.make("com.example/notion-sync") },
            "sign-in",
            { _tag: "domain", domain: "example.com" },
          ],
        ],
      );
      const all = yield* sources.search({ query: "notion", language: "en", all: true });
      assert.deepStrictEqual(all.listings.at(-1)?.connect, "unsupported");
    }).pipe(Effect.provide(sourcesLayer)),
  );

  it.effect("answer from the curated list alone when the registry does not answer", () =>
    Effect.gen(function* () {
      yield* answering(() => ({ status: 503, body: "" }));
      const sources = yield* Sources.ConnectorSources;
      const found = yield* sources.search({ query: "e-mail", language: "pt-BR", all: false });
      assert.strictEqual(found.registry, "unavailable");
      assert.deepStrictEqual(
        found.listings.map((listing) => listing.ref),
        [
          { _tag: "curated", key: CuratedKey.make("google-gmail") },
          // Its category is "E-mail e agenda".
          { _tag: "curated", key: CuratedKey.make("google-calendar") },
        ],
      );
      const error = yield* sources
        .get({ _tag: "registry", name: RegistryName.make("com.example/tracker") }, "en")
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [error._tag, "reason" in error ? error.reason : null],
        ["Conflict", "registry-unavailable"],
      );
    }).pipe(Effect.provide(sourcesLayer)),
  );

  it.effect("give a registry entry's page the fields its form asks for", () =>
    Effect.gen(function* () {
      yield* answering(() =>
        json(
          server("com.example/tracker", null, {
            server: {
              name: "com.example/tracker",
              title: "Tracker",
              remotes: [
                { type: "sse", url: "https://mcp.example.com/sse" },
                {
                  type: "streamable-http",
                  url: "https://mcp.example.com/mcp",
                  headers: [{ name: "X-Api-Key", isSecret: true, isRequired: true }],
                },
              ],
            },
          }),
        ),
      );
      const sources = yield* Sources.ConnectorSources;
      const page = yield* sources.get(
        { _tag: "registry", name: RegistryName.make("com.example/tracker") },
        "en",
      );
      assert.strictEqual(page.name, "Tracker");
      assert.strictEqual(page.connect, "token");
      assert.deepStrictEqual(
        page.fields.map((field) => [field.key, field.secret]),
        [["header:X-Api-Key", true]],
      );
      const connection = yield* sources.connection(
        { _tag: "registry", name: RegistryName.make("com.example/tracker") },
        "en",
      );
      assert.strictEqual(connection.form.urlTemplate, "https://mcp.example.com/mcp");
    }).pipe(Effect.provide(sourcesLayer)),
  );
});
