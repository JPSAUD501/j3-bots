// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { SessionId, type TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import {
  connectorToolDescription,
  NO_TURN_REFUSAL,
  browserToolList,
  toolList,
} from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { fakeConnector, reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { Cards } from "../turns/Cards.ts";
import { BotTools } from "./BotTools.ts";
import { ToolLists } from "./ToolLists.ts";

const domain = TestDomain.layer.pipe(Layer.provide(reachFakes));

/** Each test talks to a fake connector's server over a socket. */
const SLOW = 20_000;

/** A connector whose server lists `search`, as `notion__search` to bots. */
const notion = fakeConnector({
  name: "Notion",
  tools: [
    {
      name: "search",
      description: "Search the workspace's pages.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
});

/** A bot working on a message from the operator. */
const working = (name: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Find the roadmap.");
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, turnId };
  });

/** The bot calls `tool` in its running turn, which the engine records first. */
const callInTurn = (
  bot: { readonly session: SessionId; readonly turnId: TurnId },
  tool: string,
  args: Record<string, string>,
  requestId: string,
) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId: bot.session,
      turnId: bot.turnId,
      tool,
      input: args,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId,
      sessionId: bot.session,
      tool,
      arguments: args,
    });
  });

const listed = (session: SessionId) =>
  Effect.gen(function* () {
    const list = yield* (yield* ToolLists).list(session);
    return list.tools.map((tool) => tool.name);
  });

it.effect(
  "lists a bot's own tools and the connector tools it is offered, and no other bot's",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      const ben = yield* working("Ben");
      yield* connector.grant([ana.bot.id]);
      // Their browsers are on: their own tools, then the browser's.
      const own = [...toolList, ...browserToolList].map((tool) => tool.name);

      assert.deepStrictEqual(yield* listed(ana.session), [...own, "notion__search"]);
      assert.deepStrictEqual(yield* listed(ben.session), own);
      // The bot reads whose the description is before the server's own words.
      const { tools } = yield* (yield* ToolLists).list(ana.session);
      assert.strictEqual(
        tools.find((tool) => tool.name === "notion__search")?.description,
        connectorToolDescription("Notion", "Search the workspace's pages."),
      );
      // Where the harness defers MCP tools, a bot's own stay loaded; a connector's are found when needed.
      assert.deepStrictEqual(
        tools
          .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
          .map((tool) => tool.name),
        own,
      );
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "tells a bridge waiting on its list when the bot's offered tools change",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      const lists = yield* ToolLists;
      const before = yield* lists.list(ana.session);

      const waiting = yield* Effect.forkChild(
        lists.changes({ sessionId: ana.session, since: before.version }),
      );
      yield* connector.grant([ana.bot.id]);
      const changed = yield* Fiber.join(waiting);

      assert.isTrue(Option.isSome(changed));
      assert.notStrictEqual(Option.getOrThrow(changed).version, before.version);
      assert.include(yield* listed(ana.session), "notion__search");
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "makes a connector call the bot's turn made at the connector once",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      const reply = yield* callInTurn(ana, "notion__search", { query: "roadmap" }, "call-1");
      assert.strictEqual(reply._tag, "text");
      if (reply._tag === "text") {
        assert.isFalse(reply.isError);
        assert.include(reply.text, "search answered");
      }

      // The bridge forwarding the request again: the answer was not kept, so it
      // says the call may have happened, and the connector is not called again.
      const repeated = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: ana.session,
        tool: "notion__search",
        arguments: { query: "roadmap" },
      });
      assert.strictEqual(repeated._tag, "refused");
      assert.deepStrictEqual(yield* connector.calls, [
        { name: "search", arguments: { query: "roadmap" } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "makes a connector call whose record the engine closed while it waited on its approval",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      const engine = yield* TestEngineControl;
      const args = { query: "roadmap" };
      // Codex closes its record of the call while the operator is still deciding.
      const callId = yield* engine.toolCall({
        sessionId: ana.session,
        turnId: ana.turnId,
        tool: "notion__search",
        input: args,
        recorded: "now",
      });
      yield* engine.closeToolCall({ sessionId: ana.session, turnId: ana.turnId, callId });

      const request = { sessionId: ana.session, tool: "notion__search", arguments: args };
      const reply = yield* (yield* BotTools).call({ requestId: "call-1", ...request });
      // Another request finds the call claimed, and no other one in the turn.
      const another = yield* (yield* BotTools).call({ requestId: "call-2", ...request });

      assert.strictEqual(reply._tag, "text");
      assert.deepStrictEqual(another, { _tag: "refused", message: NO_TURN_REFUSAL });
      assert.strictEqual((yield* connector.calls).length, 1);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "never makes a connector call whose approval the operator declined",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);
      const engine = yield* TestEngineControl;
      const args = { query: "roadmap" };
      const callId = yield* engine.toolCall({
        sessionId: ana.session,
        turnId: ana.turnId,
        tool: "notion__search",
        input: args,
        recorded: "now",
      });
      // Codex's record closes while the call waits, which alone leaves it claimable.
      yield* engine.closeToolCall({ sessionId: ana.session, turnId: ana.turnId, callId });
      yield* engine.openRequest({
        sessionId: ana.session,
        turnId: ana.turnId,
        request: {
          _tag: "approval",
          kind: "tool",
          action: 'Notion: search {"query":"roadmap"}',
          detail: null,
          reason: null,
          exact: true,
          sessionGrant: null,
        },
        heldCall: callId,
      });
      const card = yield* awaitEntry(ana.bot.id, "approval");

      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "approval", decision: "deny" },
      });
      // Whoever has the session and the call's input, before the engine hears the answer.
      const reply = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: ana.session,
        tool: "notion__search",
        arguments: args,
      });

      assert.deepStrictEqual(reply, { _tag: "refused", message: NO_TURN_REFUSAL });
      assert.deepStrictEqual(yield* connector.calls, []);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "refuses a connector tool the bot is not offered, though another bot is",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      const ben = yield* working("Ben");
      yield* connector.grant([ana.bot.id]);

      const reply = yield* callInTurn(ben, "notion__search", { query: "roadmap" }, "call-1");

      assert.deepStrictEqual(reply, {
        _tag: "refused",
        message: "No connector tool by that name is offered to this bot.",
      });
      assert.deepStrictEqual(yield* connector.calls, []);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "refuses a connector call that is not its bot's running turn's",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      // A call the engine has no record of, as a subagent's or a forged one.
      const reply = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: ana.session,
        tool: "notion__search",
        arguments: { query: "roadmap" },
      });

      assert.deepStrictEqual(reply, { _tag: "refused", message: NO_TURN_REFUSAL });
      assert.deepStrictEqual(yield* connector.calls, []);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "refuses a connector call from a session that is no bot's",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      yield* connector.grant([ana.bot.id]);

      const reply = yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: SessionId.make("thread-of-no-bot"),
        tool: "notion__search",
        arguments: { query: "roadmap" },
      });

      assert.strictEqual(reply._tag, "refused");
      assert.deepStrictEqual(yield* connector.calls, []);
      // Its bridge lists only J3 Bots' own tools, and cannot hold a wait for a change open.
      assert.deepStrictEqual(
        yield* listed(SessionId.make("thread-of-no-bot")),
        toolList.map((tool) => tool.name),
      );
      assert.isTrue(
        Option.isNone(
          yield* (yield* ToolLists).changes({
            sessionId: SessionId.make("thread-of-no-bot"),
            since: "any",
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);
