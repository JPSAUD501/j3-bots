// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { SessionId } from "@j3-bots/engine-t3";
import { BROWSER_NOTES } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TestServerBrowser } from "../testing/browser.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  command,
  createBot,
  engineSession,
  finishRunning,
  nextTurn,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { ToolLists } from "../tools/ToolLists.ts";
import { Bots } from "./Bots.ts";

let calls = 0;

const listed = (session: SessionId) =>
  Effect.gen(function* () {
    const list = yield* (yield* ToolLists).list(session);
    return {
      version: list.version,
      browsing: list.tools.some((tool) => tool.name === "browser_tabs"),
    };
  });

const browse = (session: SessionId, tool: string, args: { readonly [key: string]: string }) =>
  Effect.gen(function* () {
    return yield* (yield* BotTools).call({
      requestId: `browser-${++calls}`,
      sessionId: session,
      tool,
      arguments: args,
    });
  });

it.effect(
  "lists the browser's tools while the bot's browser is on, and once it is turned off lists them no more and refuses them at once",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const lists = yield* ToolLists;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const before = yield* listed(session);
      assert.isTrue(before.browsing);

      yield* bots.update({ commandId: command(), botId: bot.id, changes: { browser: false } });
      const changed = yield* lists.changes({ sessionId: session, since: before.version });
      assert.isTrue(Option.isSome(changed));
      assert.isFalse((yield* listed(session)).browsing);
      assert.deepStrictEqual(yield* browse(session, "browser_tabs", {}), {
        _tag: "refused",
        message: BROWSER_NOTES.off,
      });
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives a session the browser's tools only once it was started with the browser's rules",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* bots.update({ commandId: command(), botId: bot.id, changes: { browser: false } });
      yield* sendToBot(bot.id, "Plan the launch.");
      const running = yield* nextTurn(bot.id);

      // Turned on mid-turn: the running session's instructions have no browser rules yet.
      yield* bots.update({ commandId: command(), botId: bot.id, changes: { browser: true } });
      assert.isFalse((yield* listed(session)).browsing);
      yield* finishRunning(bot.id);
      yield* turnEnded(bot.id);

      yield* sendToBot(bot.id, "Now check the site.");
      yield* nextTurn(bot.id, running);
      assert.isTrue((yield* listed(session)).browsing);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "opens a bot's tab in the server's browser when no app is open, and reads it from there",
  () =>
    Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const opened = yield* browse(session, "browser_open", { url: "https://shop.example.test/" });
      assert.strictEqual(opened._tag, "result");
      const host = yield* (yield* TestServerBrowser).running;
      const tabs = yield* host.tabs;
      assert.deepStrictEqual(
        tabs.map((tab) => tab.url),
        ["https://shop.example.test/"],
      );
      const read = yield* browse(session, "browser_snapshot", {});
      assert.strictEqual(read._tag, "result");
    }).pipe(Effect.provide(TestDomain.layer)),
);
