// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { CommandId } from "@j3-bots/contracts";
import { SessionId } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as SqlClient from "effect/sql/SqlClient";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import * as ToolEndpoint from "../tools/ToolEndpoint.ts";
import { serve } from "./Bridge.ts";

const endpoint = Ports.serve(ToolEndpoint.routes, NodeHttpServer.layerTest, {
  logAddress: false,
}).pipe(Layer.provideMerge(TestDomain.layer));

const Reply = Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      content: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.String }))),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(Reply));

/** Runs the bridge over `requests` as its standard input, and answers what it wrote, by id. */
const runBridge = (session: Option.Option<SessionId>, requests: ReadonlyArray<object>) =>
  Effect.gen(function* () {
    const written = yield* Ref.make("");
    const decoder = new TextDecoder();
    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.make(
        new TextEncoder().encode(
          requests.map((request) => `${JSON.stringify(request)}\n`).join(""),
        ),
      ),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Ref.update(
            written,
            (text) => text + (typeof chunk === "string" ? chunk : decoder.decode(chunk)),
          ),
        ),
      stderr: () => Sink.drain,
    });
    yield* serve({ server: "", session, version: "test" }).pipe(
      Effect.provideService(Stdio.Stdio, stdio),
      Effect.provide(SecureRandom.layerWebCrypto),
    );
    const replies = (yield* Ref.get(written))
      .trim()
      .split("\n")
      .map((line) => decodeReply(line));
    return new Map(replies.map((reply) => [reply.id, reply.result]));
  });

const call = (id: number, name: string, args: object) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const sessionOf = (botId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly engine_session_id: string }>`
      SELECT engine_session_id FROM sessions WHERE bot_id = ${botId}
    `;
    return Option.fromNullishOr(row?.engine_session_id).pipe(Option.map(SessionId.make));
  });

// The real clock: a forward is retried after a pause.
it.layer(endpoint, { excludeTestServices: true })("j3 bridge", (it) => {
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

      assert.strictEqual(replies.get(2)?.tools?.length, 12);
      assert.deepStrictEqual(replies.get(3)?.content?.[0]?.text, '{"recorded":true}');
      assert.isTrue(replies.get(4)?.isError);
      // Only the primary bot creates teammates.
      assert.isTrue(replies.get(5)?.isError);
      assert.strictEqual(replies.size, 5);
    }),
  );

  it.effect("acts once on a call whose reply was lost and sent again", () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const store = yield* BotStore;
      const primary = yield* bots.create({
        commandId: CommandId.make("lead"),
        draft: { name: "Lead", primary: true },
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

      const replies = yield* runBridge(yield* sessionOf(primary.id), [
        call(1, "create_bot", { name: "Scout", job: "Watches the repository." }),
      ]).pipe(Effect.provideService(HttpClient.HttpClient, losingFirstReply));

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
});
