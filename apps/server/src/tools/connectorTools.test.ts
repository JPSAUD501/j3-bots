// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, ConnectorId } from "@j3-bots/contracts";
import { SessionId, type TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { NO_TURN_REFUSAL, toolList } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { OfferedTool } from "../connectors/Connectors.ts";
import { TestConnectors } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot, engineSession, nextTurn, sendToBot } from "../testing/turns.ts";
import { BotTools } from "./BotTools.ts";
import { ToolLists } from "./ToolLists.ts";

const search: OfferedTool = {
  name: "notion__search",
  connectorId: ConnectorId.make("conn_0123456789abcdef"),
  upstreamName: "search",
  description: "Search the workspace's pages.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

/** A bot working on a message from the operator, offered `offered`. */
const working = (name: string, offered: ReadonlyArray<OfferedTool>) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    yield* (yield* TestConnectors).offer(bot.id, offered);
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

const callsBy = (botId: BotId) =>
  Effect.gen(function* () {
    const calls = yield* (yield* TestConnectors).calls;
    return calls.filter((call) => call.botId === botId).map((call) => call.name);
  });

it.effect("lists a bot's own tools and the connector tools it is offered, and no other bot's", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana", [search]);
    const ben = yield* working("Ben", []);
    const own = toolList.map((tool) => tool.name);

    assert.deepStrictEqual(yield* listed(ana.session), [...own, "notion__search"]);
    assert.deepStrictEqual(yield* listed(ben.session), own);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("tells a bridge waiting on its list when the bot's offered tools change", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana", []);
    const lists = yield* ToolLists;
    const before = yield* lists.list(ana.session);

    const waiting = yield* Effect.forkChild(
      lists.changes({ sessionId: ana.session, since: before.version }),
    );
    yield* (yield* TestConnectors).offer(ana.bot.id, [search]);
    const changed = yield* Fiber.join(waiting);

    assert.notStrictEqual(changed.version, before.version);
    const after = yield* lists.list(ana.session);
    assert.strictEqual(after.version, changed.version);
    assert.include(
      after.tools.map((tool) => tool.name),
      "notion__search",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("makes a connector call the bot's turn made at the connector once", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana", [search]);

    const reply = yield* callInTurn(ana, "notion__search", { query: "roadmap" }, "call-1");
    assert.deepStrictEqual(reply, {
      _tag: "text",
      text: "notion__search answered",
      isError: false,
    });

    // The bridge forwarding the request again: the answer was not kept, so it
    // says the call may have happened, and the connector is not called again.
    const repeated = yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: ana.session,
      tool: "notion__search",
      arguments: { query: "roadmap" },
    });
    assert.strictEqual(repeated._tag, "refused");
    assert.deepStrictEqual(yield* callsBy(ana.bot.id), ["notion__search"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a connector tool the bot is not offered, though another bot is", () =>
  Effect.gen(function* () {
    yield* working("Ana", [search]);
    const ben = yield* working("Ben", []);

    const reply = yield* callInTurn(ben, "notion__search", { query: "roadmap" }, "call-1");

    assert.deepStrictEqual(reply, {
      _tag: "refused",
      message: "No connector tool by that name is offered to this bot.",
    });
    assert.deepStrictEqual(yield* (yield* TestConnectors).calls, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a connector call that is not its bot's running turn's", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana", [search]);

    // A call the engine has no record of, as a subagent's or a forged one.
    const reply = yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: ana.session,
      tool: "notion__search",
      arguments: { query: "roadmap" },
    });

    assert.deepStrictEqual(reply, { _tag: "refused", message: NO_TURN_REFUSAL });
    assert.deepStrictEqual(yield* (yield* TestConnectors).calls, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a connector call from a session that is no bot's", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana", [search]);

    const reply = yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: SessionId.make("thread-of-no-bot"),
      tool: "notion__search",
      arguments: { query: "roadmap" },
    });

    assert.strictEqual(reply._tag, "refused");
    assert.deepStrictEqual(yield* callsBy(ana.bot.id), []);
    // Its bridge lists only J3 Bots' own tools.
    assert.deepStrictEqual(
      yield* listed(SessionId.make("thread-of-no-bot")),
      toolList.map((tool) => tool.name),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);
