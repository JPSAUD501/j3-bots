// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CuratedKey, type EntryId } from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { MANAGEMENT_NOTES } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { timeText } from "../persistence/columns.ts";
import * as TestDomain from "../testing/domain.ts";
import { unresolvable } from "../testing/oauth.ts";
import {
  awaitEntry,
  command,
  createBot,
  engineSession,
  nextTurn,
  received,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { type OwnAppClient, Management } from "../tools/Management.ts";
import { Cards } from "../turns/Cards.ts";
import { Connectors } from "./Connectors.ts";

const domain = TestDomain.layer.pipe(Layer.provide(unresolvable));

const CLIENT_SECRET = "client-secret-value";
const CLIENT: OwnAppClient = {
  clientId: "client-id-value.apps.example",
  clientSecret: Redacted.make(CLIENT_SECRET),
};

let requests = 0;

/** The bot, in its running turn, calls `tool`: what the tool answers it. */
const callTool = (sessionId: SessionId, turnId: TurnId, tool: string, input: Schema.Json) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool,
      input,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `ask-${++requests}`,
      sessionId,
      tool,
      arguments: input,
    });
  });

const AskedAnswer = Schema.Struct({ asked: Schema.String, note: Schema.String });

/**
 * A bot asks to add `server`, which needs the operator's yes, then ends its
 * turn: the card it showed, and what its call answered.
 */
const asked = (server: Schema.Json) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Connect the service I use.");
    const turnId = yield* nextTurn(bot.id);
    const response = yield* callTool(session, turnId, "add_mcp_server", server);
    if (response._tag !== "result") return assert.fail(JSON.stringify(response));
    const answer = yield* Schema.decodeUnknownEffect(AskedAnswer)(response.value).pipe(
      Effect.orDie,
    );
    const card = yield* awaitEntry(bot.id, "connector-ask");
    yield* callTool(session, turnId, "say", { text: "I asked you to allow it.", done: true });
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    return { bot, session, turnId, answer, card };
  });

/** The text of the dispatch that starts the bot's next turn. */
const nextWake = (botId: BotId, sessionId: SessionId, previous: TurnId) =>
  Effect.gen(function* () {
    yield* nextTurn(botId, previous);
    return (yield* received(sessionId)).at(-1)?.text ?? "";
  });

const statusOf = (botId: BotId) =>
  awaitEntry(botId, "connector-ask").pipe(Effect.map((card) => card.status));

const answer = (entryId: EntryId, client: OwnAppClient | null) =>
  Effect.flatMap(Management, (management) => management.answerAsk({ entryId, client }));

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : assert.fail("expected a failure");

it.effect(
  "asks before adding an address in the operator's own network, and tells the bot they declined",
  () =>
    Effect.gen(function* () {
      const {
        bot,
        session,
        turnId,
        answer: said,
        card,
      } = yield* asked({
        url: "https://10.0.0.8:8123/mcp",
        name: "Home lights",
      });
      assert.strictEqual(said.note, MANAGEMENT_NOTES.asked);
      assert.deepStrictEqual(card.ask, { _tag: "private-network", host: "10.0.0.8:8123" });
      assert.strictEqual(card.name, "Home lights");
      // Nothing is added before the operator's yes.
      assert.deepStrictEqual(yield* (yield* Connectors).listed, []);

      // Their word for an address is a yes alone, never a client.
      assert.include(failureOf(yield* Effect.exit(answer(card.id, CLIENT))), "answer");
      assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");

      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "dismiss" },
      });
      assert.strictEqual((yield* statusOf(bot.id))._tag, "declined");
      const text = yield* nextWake(bot.id, session, turnId);
      assert.include(text, "declined the MCP server");
      assert.include(text, 'name="Home lights"');
      assert.include(failureOf(yield* Effect.exit(answer(card.id, null))), "card-closed");
    }).pipe(Effect.provide(domain)),
);

it.effect(
  "adds an entry that signs in with the operator's own app only on the client they give, which the bot never reads",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, card } = yield* asked({ gallery: "curated:google-gmail" });
      assert.deepStrictEqual(card.ask, {
        _tag: "own-app",
        listing: { _tag: "curated", key: CuratedKey.make("google-gmail") },
      });
      // An own app takes its client.
      assert.include(failureOf(yield* Effect.exit(answer(card.id, null))), "answer");
      assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");

      // Their yes adds it with that client: here the service cannot be reached
      // to sign in, and the bot is told why.
      yield* answer(card.id, CLIENT);
      assert.strictEqual((yield* statusOf(bot.id))._tag, "failed");
      assert.include(failureOf(yield* Effect.exit(answer(card.id, CLIENT))), "card-closed");
      const text = yield* nextWake(bot.id, session, turnId);
      assert.include(text, "adding it failed");
      assert.include(text, "sign-in-unsupported");
      assert.notInclude(text, CLIENT_SECRET);
    }).pipe(Effect.provide(domain)),
);

it.effect("closes an ask nobody answers once it waited too long, and tells the bot", () =>
  Effect.gen(function* () {
    const { bot, session, turnId } = yield* asked({ gallery: "curated:google-gmail" });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE connector_asks SET expires_at = ${timeText(yield* DateTime.now)}`;
    yield* TestClock.adjust(Duration.minutes(1));
    assert.strictEqual((yield* statusOf(bot.id))._tag, "expired");
    assert.include(yield* nextWake(bot.id, session, turnId), "waited too long");
  }).pipe(Effect.provide(domain)),
);
