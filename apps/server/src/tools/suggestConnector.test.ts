// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { BotId, ConnectorSuggestionEntry } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { SUGGESTION_REFUSED, SUGGESTION_SHOWN } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Entries } from "../entries/Entries.ts";
import { SYSTEM_PROMPT_FILE } from "../home/entries.ts";
import { Layout } from "../Layout.ts";
import { fakeConnector, reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import { command, createBot, engineSession, nextTurn, sendToBot } from "../testing/turns.ts";
import { Cards } from "../turns/Cards.ts";
import { BotTools } from "./BotTools.ts";

const domain = TestDomain.layer.pipe(Layer.provide(reachFakes));

/** A test with a connector sets up a vault, whose key takes a while to derive. */
const SLOW = 20_000;

/** A connector the operator added, whose server lists one tool. */
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
    yield* sendToBot(bot.id, "What is on my roadmap?");
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, turnId };
  });

/** The bot suggests `connector` in its running turn, which the engine records first. */
const suggest = (
  bot: { readonly session: SessionId; readonly turnId: TurnId },
  connector: string,
  requestId: string,
) =>
  Effect.gen(function* () {
    const input = { connector, reason: "To read your roadmap." };
    yield* (yield* TestEngineControl).toolCall({
      sessionId: bot.session,
      turnId: bot.turnId,
      tool: "suggest_connector",
      input,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId,
      sessionId: bot.session,
      tool: "suggest_connector",
      arguments: input,
    });
  });

const shown = { _tag: "result", value: { status: "shown", note: SUGGESTION_SHOWN } } as const;
const refused = (message: string) => ({ _tag: "refused", message }) as const;

const suggestionCards = (botId: BotId) =>
  Effect.flatMap(Entries, (entries) =>
    entries.ofKind({ _tag: "conversation", botId }, "connector-suggestion"),
  );

const notNow = (card: ConnectorSuggestionEntry) =>
  Effect.flatMap(Cards, (cards) =>
    cards.answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } }),
  );

it.effect("shows one card for a gallery connector, and none again after its Not now", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana");

    assert.deepStrictEqual(yield* suggest(ana, "notion", "call-1"), shown);
    const [card] = yield* suggestionCards(ana.bot.id);
    assert.isDefined(card);
    assert.deepStrictEqual(
      [card.subject, card.name, card.reason, card.status],
      [
        { _tag: "listing", ref: { _tag: "curated", key: "notion" } },
        "Notion",
        "To read your roadmap.",
        { _tag: "pending" },
      ],
    );

    // While the card waits, by its name in other words too.
    assert.deepStrictEqual(
      yield* suggest(ana, " NOTION ", "call-2"),
      refused(SUGGESTION_REFUSED.pending("Notion")),
    );

    yield* notNow(card);
    assert.deepStrictEqual(
      yield* suggest(ana, "Notion", "call-3"),
      refused(SUGGESTION_REFUSED.declined("Notion")),
    );
    const cards = yield* suggestionCards(ana.bot.id);
    assert.deepStrictEqual(
      cards.map((each) => each.status),
      [{ _tag: "dismissed" }],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows no card for a service the gallery lacks", () =>
  Effect.gen(function* () {
    const ana = yield* working("Ana");
    assert.deepStrictEqual(
      yield* suggest(ana, "Quillwork", "call-4"),
      refused(SUGGESTION_REFUSED.unknown("Quillwork")),
    );
    assert.deepStrictEqual(yield* suggestionCards(ana.bot.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "offers the operator's own connector to a bot without it, and none to a bot that has it",
  () =>
    Effect.gen(function* () {
      const connector = yield* notion;
      const ana = yield* working("Ana");
      const ben = yield* working("Ben");
      yield* connector.grant([ben.bot.id]);

      assert.deepStrictEqual(yield* suggest(ana, "Notion", "call-5"), shown);
      const [card] = yield* suggestionCards(ana.bot.id);
      assert.strictEqual(card?.subject._tag, "connector");

      assert.deepStrictEqual(
        yield* suggest(ben, "Notion", "call-6"),
        refused(SUGGESTION_REFUSED.usable("Notion")),
      );
      assert.deepStrictEqual(yield* suggestionCards(ben.bot.id), []);
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);

it.effect(
  "gives a bot the connector rules while it has a connector, and only then",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* Layout;
      const connector = yield* notion;
      const ana = yield* createBot("Ana");
      const instructions = fs.readFileString(
        path.join(layout.workspace(ana.id), SYSTEM_PROMPT_FILE),
      );

      assert.notInclude(yield* instructions, "# Your connectors");
      yield* connector.grant([ana.id]);
      assert.include(yield* instructions, "# Your connectors");
      yield* connector.grant([]);
      assert.notInclude(yield* instructions, "# Your connectors");
    }).pipe(Effect.scoped, Effect.provide(domain)),
  SLOW,
);
