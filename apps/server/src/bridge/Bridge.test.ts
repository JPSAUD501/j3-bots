// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId } from "@j3-bots/contracts";
import { SessionId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { toolList } from "@j3-bots/prompts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Redacted from "effect/Redacted";
import * as Mac from "effect/crypto/Mac";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import { Memory } from "../memory/Memory.ts";
import * as Ports from "../system/Ports.ts";
import { fakeConnector, reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot, engineSession, nextTurn, sendToBot, until } from "../testing/turns.ts";
import * as BridgeKey from "../tools/BridgeKey.ts";
import * as ToolEndpoint from "../tools/ToolEndpoint.ts";
import {
  CONNECTOR_CALL_DEADLINE,
  SIGNATURE_HEADER,
  TOOL_CALL_PATH,
  TOOL_CHANGES_PATH,
} from "../tools/protocol.ts";
import { FORWARD_RETRY_PAUSE, serve } from "./Bridge.ts";

/** The endpoint over the whole domain, and Node's own HTTP client, which the bridge runs with. */
const endpoint = Layer.mergeAll(
  Ports.serve(ToolEndpoint.routes, NodeHttpServer.layerTest, {
    logAddress: false,
  }).pipe(
    Layer.provideMerge(TestDomain.layer.pipe(Layer.provide(reachFakes))),
    Layer.provideMerge(BridgeKey.layer),
  ),
  NodeHttpClient.layerNodeHttp,
  Mac.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto)),
);

const Line = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      content: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.String }))),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Line));

/** What the bridge wrote so far, as its standard input can wait on it. */
interface Output {
  /** Waits until the bridge has written `text`. */
  readonly shows: (text: string) => Effect.Effect<void>;
}

/**
 * Runs the bridge with what `input` gives as its standard input, which may
 * wait on what the bridge wrote, and answers what it wrote: the replies by
 * id, and the notifications' methods in order.
 */
const runBridgeWith = (
  session: Option.Option<SessionId>,
  input: (output: Output) => Stream.Stream<object>,
  /** The key it is started with: the server's unless given. */
  given?: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const key = given ?? Option.some(Redacted.value((yield* BridgeKey.BridgeKey).variable.value));
    const written = yield* SubscriptionRef.make("");
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const output: Output = {
      shows: (text) =>
        SubscriptionRef.changes(written).pipe(
          Stream.filter((all) => all.includes(text)),
          Stream.runHead,
          Effect.asVoid,
        ),
    };
    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: input(output).pipe(Stream.map((line) => encoder.encode(`${JSON.stringify(line)}\n`))),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          SubscriptionRef.update(
            written,
            (text) => text + (typeof chunk === "string" ? chunk : decoder.decode(chunk)),
          ),
        ),
      stderr: () => Sink.drain,
    });
    const { address } = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die("The endpoint listens on TCP");
    }
    yield* serve({
      server: `http://127.0.0.1:${address.port}`,
      session,
      key,
      version: "test",
    }).pipe(Effect.provideService(Stdio.Stdio, stdio));
    const lines = (yield* SubscriptionRef.get(written))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => decodeLine(line));
    return {
      replies: new Map(
        lines.flatMap((line) => (line.id === undefined ? [] : [[line.id, line.result]])),
      ),
      notifications: lines.flatMap((line) =>
        line.id === undefined && line.method !== undefined ? [line.method] : [],
      ),
    };
  });

/** The id of a request, or `undefined` for a notification. */
const idOf = (message: object): number | undefined =>
  "id" in message && typeof message.id === "number" ? message.id : undefined;

/** Waits until the bridge has answered the request with this id. */
const answered = (output: Output, id: number) => output.shows(`"id":${id},`);

/**
 * Runs the bridge over `requests` as its standard input, which it closes once
 * every request is answered, and answers what it wrote, by id.
 */
const runBridge = (
  session: Option.Option<SessionId>,
  requests: ReadonlyArray<object>,
  key?: Option.Option<string>,
) =>
  runBridgeWith(
    session,
    (output) =>
      Stream.concat(
        Stream.fromIterable(requests),
        Stream.fromEffect(
          Effect.forEach(
            requests.flatMap((request) => {
              const id = idOf(request);
              return id === undefined ? [] : [id];
            }),
            (id) => answered(output, id),
            { discard: true },
          ),
        ).pipe(Stream.drain),
      ),
    key,
  ).pipe(Effect.map(({ replies }) => replies));

const call = (id: number, name: string, args: object) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

/** A connector named `name` whose server lists `search`, as `<name>__search` to bots. */
const searchable = (name: string, answer?: Parameters<typeof fakeConnector>[0]["answer"]) =>
  fakeConnector({
    name,
    tools: [
      {
        name: "search",
        description: "Search the workspace's pages.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    ...(answer === undefined ? {} : { answer }),
  });

/** The facts the bot remembered, as `recall` finds them. */
const memoryOf = (botId: BotId) =>
  Effect.gen(function* () {
    const recalled = yield* (yield* Memory).recall({
      botId,
      query: "demo",
      scope: "bot",
      limit: 10,
    });
    return recalled.map((fact) => fact.text);
  });

const sessionOf = (botId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly engine_session_id: string }>`
      SELECT engine_session_id FROM sessions WHERE bot_id = ${botId}
    `;
    return Option.fromNullishOr(row?.engine_session_id).pipe(Option.map(SessionId.make));
  });

it.layer(endpoint)("j3 bridge", (it) => {
  it.effect("lists the tools and answers a call for the bot whose session started it", () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const bot = yield* bots.create({ commandId: CommandId.make("ana"), draft: { name: "Ana" } });

      const replies = yield* runBridge(yield* sessionOf(bot.id), [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        call(3, "remember", { fact: "Standups are at nine" }),
        call(4, "say", { text: "Done." }),
        call(5, "create_bot", { name: "Scout" }),
      ]);

      assert.deepStrictEqual(
        replies.get(2)?.tools?.map((tool) => tool.name),
        toolList.map((tool) => tool.name),
      );
      assert.deepStrictEqual(replies.get(3)?.content?.[0]?.text, '{"recorded":true}');
      assert.isTrue(replies.get(4)?.isError);
      // Only the primary bot creates teammates.
      assert.isTrue(replies.get(5)?.isError);
      assert.strictEqual(replies.size, 5);
    }),
  );

  it.effect("acts once on a call whose reply was lost and sent again", () =>
    Effect.gen(function* () {
      const store = yield* BotStore;
      // The primary bot, in a turn the operator asked it for a teammate in,
      // whose call the engine recorded.
      const primary = yield* createBot("Lead");
      yield* (yield* Bots).update({
        commandId: CommandId.make("lead-primary"),
        botId: primary.id,
        changes: { primary: true },
      });
      const session = yield* engineSession(primary.id);
      yield* sendToBot(primary.id, "Make me a bot that watches the repository.");
      const args = { name: "Scout", job: "Watches the repository." };
      yield* (yield* TestEngineControl).toolCall({
        sessionId: session,
        turnId: yield* nextTurn(primary.id),
        tool: "create_bot",
        input: args,
        recorded: "now",
      });
      const attempts = yield* Ref.make(0);
      const losingFirstReply = (yield* HttpClient.HttpClient).pipe(
        HttpClient.transform((response, request) =>
          Effect.gen(function* () {
            const answered = yield* response;
            if ((yield* Ref.getAndUpdate(attempts, (n) => n + 1)) > 0) return answered;
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "lost" }),
            });
          }),
        ),
      );

      const bridge = yield* runBridge(Option.some(session), [call(1, "create_bot", args)]).pipe(
        Effect.provideService(HttpClient.HttpClient, losingFirstReply),
        Effect.forkChild,
      );
      // The bridge forwards the request again after a pause.
      yield* until(Effect.map(Ref.get(attempts), (n) => n > 0));
      yield* TestClock.adjust(FORWARD_RETRY_PAUSE);
      const replies = yield* Fiber.join(bridge);

      assert.isFalse(replies.get(1)?.isError);
      assert.strictEqual(yield* Ref.get(attempts), 2);
      const scouts = (yield* store.list).filter(({ bot }) => bot.profile.name === "Scout");
      assert.strictEqual(scouts.length, 1);
    }),
  );

  it.effect("refuses every call when no J3 Bots session started it", () =>
    Effect.gen(function* () {
      const replies = yield* runBridge(Option.none(), [call(1, "recall", { query: "anything" })]);
      assert.isTrue(replies.get(1)?.isError);
    }),
  );

  it.effect("acts for its session only with the server's key", () =>
    Effect.gen(function* () {
      const bot = yield* (yield* Bots).create({
        commandId: CommandId.make("fia"),
        draft: { name: "Fia" },
      });
      const session = yield* sessionOf(bot.id);
      const remember = call(1, "remember", { fact: "The demo is on Friday" });
      const another = Base64Url.encode(new Uint8Array(64).fill(7));

      // Started with no key, or with a key that is not the server's: nothing is remembered.
      for (const key of [Option.none(), Option.some(another)]) {
        const refused = yield* runBridge(session, [remember], key);
        assert.isTrue(refused.get(1)?.isError);
      }
      assert.deepStrictEqual(yield* memoryOf(bot.id), []);

      const taken = yield* runBridge(session, [remember]);
      assert.isFalse(taken.get(1)?.isError);
      assert.deepStrictEqual(yield* memoryOf(bot.id), ["The demo is on Friday"]);
    }),
  );

  it.effect("takes no answer the server did not sign for its request", () =>
    Effect.gen(function* () {
      const { signer } = yield* BridgeKey.BridgeKey;
      const body = JSON.stringify({ _tag: "result", value: { recorded: true } });
      // Whoever holds the port answers, unsigned, then with a real answer's tag for another request.
      for (const tag of [undefined, yield* signer.signAnswer("another-request", body)]) {
        const impostor = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  ...(tag === undefined ? {} : { [SIGNATURE_HEADER]: tag }),
                },
              }),
            ),
          ),
        );
        const replies = yield* runBridge(Option.some(SessionId.make("thread-1")), [
          call(1, "remember", { fact: "Anything" }),
        ]).pipe(Effect.provideService(HttpClient.HttpClient, impostor));
        assert.isTrue(replies.get(1)?.isError);
        assert.strictEqual(
          replies.get(1)?.content?.[0]?.text,
          "J3 Bots could not be reached. Try the call again.",
        );
      }
    }),
  );
});

/**
 * A bot in a turn whose call to its connector `connector`'s `search`, once
 * forwarded, the connector's server holds until the call is closed.
 */
const callThatRuns = Effect.fn(function* (name: string, connector: string) {
  const bot = yield* createBot(name);
  const session = yield* engineSession(bot.id);
  const { fake, grant } = yield* searchable(connector, () => ({ _tag: "hang" }));
  yield* grant([bot.id]);
  yield* sendToBot(bot.id, "Find the roadmap.");
  const turnId = yield* nextTurn(bot.id);
  const tool = `${connector.toLowerCase()}__search`;
  const args = { query: "roadmap" };
  yield* (yield* TestEngineControl).toolCall({
    sessionId: session,
    turnId,
    tool,
    input: args,
    recorded: "now",
  });
  return {
    session,
    request: call(1, tool, args),
    /** The call reached the connector's server. */
    started: fake.held(1),
    /** The connector's server saw the call closed. */
    abandoned: fake.released,
  };
});

// The test clock: what the bridge waits on, it waits for in the test.
it.layer(endpoint)("j3 bridge with connectors", (it) => {
  it.effect("tells the harness to list again once the bot is offered a connector's tool", () =>
    Effect.gen(function* () {
      const bot = yield* createBot("Cleo");
      const session = yield* engineSession(bot.id);
      const notion = yield* searchable("Notion");

      const { replies, notifications } = yield* runBridgeWith(Option.some(session), (output) =>
        Stream.concat(
          Stream.make(
            { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
          ),
          Stream.fromEffect(
            output
              .shows('"id":2')
              .pipe(
                Effect.andThen(notion.grant([bot.id])),
                Effect.andThen(output.shows("notifications/tools/list_changed")),
                Effect.as({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
              ),
          ),
        ).pipe(Stream.concat(Stream.fromEffect(answered(output, 3)).pipe(Stream.drain))),
      );

      // Granting the connector and listing its tools may each tell it.
      assert.isNotEmpty(notifications);
      for (const sent of notifications)
        assert.strictEqual(sent, "notifications/tools/list_changed");
      assert.notInclude(replies.get(2)?.tools?.map((tool) => tool.name) ?? [], "notion__search");
      assert.include(replies.get(3)?.tools?.map((tool) => tool.name) ?? [], "notion__search");
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting for changes at the first wait the server does not answer", () =>
    Effect.gen(function* () {
      const waits = yield* Ref.make(0);
      const waited = yield* Deferred.make<void>();
      const counting = (yield* HttpClient.HttpClient).pipe(
        HttpClient.tapRequest((request) =>
          request.url.endsWith(TOOL_CHANGES_PATH)
            ? Ref.update(waits, (n) => n + 1).pipe(
                Effect.andThen(Deferred.succeed(waited, undefined)),
              )
            : Effect.void,
        ),
      );

      // A session the server does not know, as after it let its port go.
      yield* runBridgeWith(Option.some(SessionId.make("thread-of-no-bot")), (output) =>
        Stream.concat(
          Stream.make({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          Stream.fromEffect(
            answered(output, 1).pipe(
              Effect.andThen(Deferred.await(waited)),
              Effect.andThen(TestClock.adjust("10 minutes")),
            ),
          ).pipe(Stream.drain),
        ),
      ).pipe(Effect.provideService(HttpClient.HttpClient, counting));

      assert.strictEqual(yield* Ref.get(waits), 1);
    }),
  );

  it.effect("abandons a connector's call the harness cancels, and does not answer it", () =>
    Effect.gen(function* () {
      const { session, request, started, abandoned } = yield* callThatRuns("Dov", "Drive");

      const { replies } = yield* runBridgeWith(Option.some(session), () =>
        Stream.concat(
          Stream.make(request),
          Stream.fromEffect(
            started.pipe(
              Effect.as({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId: 1 },
              }),
            ),
          ),
          // The input stays open until the call is abandoned: the cancel did it.
        ).pipe(Stream.concat(Stream.fromEffect(abandoned).pipe(Stream.drain))),
      );

      assert.strictEqual(replies.size, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("abandons a connector's call still running when the harness closes the input", () =>
    Effect.gen(function* () {
      const { session, request, started, abandoned } = yield* callThatRuns("Eli", "Email");

      const { replies } = yield* runBridgeWith(Option.some(session), () =>
        Stream.concat(Stream.make(request), Stream.fromEffect(started).pipe(Stream.drain)),
      );

      yield* abandoned;
      assert.strictEqual(replies.size, 0);
    }).pipe(Effect.scoped),
  );
});

// Past a connector call's deadline: a test clock of its own, which no other test shares.
it.layer(endpoint)("j3 bridge with a connector call that gets no answer", (it) => {
  it.effect(
    "tells the bot to check before it calls again when a connector's call got no answer",
    () =>
      Effect.gen(function* () {
        const forwarded = yield* Deferred.make<void>();
        const abandoned = yield* Deferred.make<void>();
        // A server that takes the call and never answers it.
        const silent = HttpClient.transform(yield* HttpClient.HttpClient, (response, request) =>
          request.url.endsWith(TOOL_CALL_PATH)
            ? Deferred.succeed(forwarded, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(abandoned, undefined)),
              )
            : response,
        );

        const { replies } = yield* runBridgeWith(
          Option.some(SessionId.make("thread-1")),
          (output) =>
            Stream.concat(
              Stream.make(call(1, "notion__search", { query: "roadmap" })),
              Stream.fromEffect(
                Deferred.await(forwarded).pipe(
                  Effect.andThen(TestClock.adjust(CONNECTOR_CALL_DEADLINE)),
                  Effect.andThen(answered(output, 1)),
                ),
              ).pipe(Stream.drain),
            ),
        ).pipe(Effect.provideService(HttpClient.HttpClient, silent));

        yield* Deferred.await(abandoned);
        assert.isTrue(replies.get(1)?.isError);
        assert.include(
          replies.get(1)?.content?.[0]?.text ?? "",
          "may or may not have taken effect",
        );
      }),
  );
});

// Past J3 Bots' own tools' deadline: a test clock of its own, which no other test shares.
it.layer(endpoint)("j3 bridge with an install that takes its time", (it) => {
  it.effect("waits past 30 seconds for a skill's install, which fetches a repository", () =>
    Effect.gen(function* () {
      const forwarded = yield* Deferred.make<void>();
      // A server whose answer comes 45 seconds after the call reaches it.
      const slow = HttpClient.transform(yield* HttpClient.HttpClient, (response, request) =>
        request.url.endsWith(TOOL_CALL_PATH)
          ? Deferred.succeed(forwarded, undefined).pipe(
              Effect.andThen(Effect.sleep("45 seconds")),
              Effect.andThen(response),
            )
          : response,
      );

      const { replies } = yield* runBridgeWith(Option.some(SessionId.make("thread-1")), (output) =>
        Stream.concat(
          Stream.make(
            call(1, "install_skill", { repository: "https://git.example/skills.git", ref: "main" }),
          ),
          Stream.fromEffect(
            Deferred.await(forwarded).pipe(
              Effect.andThen(TestClock.adjust("45 seconds")),
              Effect.andThen(answered(output, 1)),
            ),
          ).pipe(Stream.drain),
        ),
      ).pipe(Effect.provideService(HttpClient.HttpClient, slow));

      // The server's own answer, which this session gets, not the bridge's word that it gave up.
      assert.strictEqual(replies.get(1)?.content?.[0]?.text, "This is not a J3 Bots session.");
    }),
  );
});
