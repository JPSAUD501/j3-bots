// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  type EntryId,
  type SecretDraft,
  SecretId,
  SecretName,
  SiteOrigin,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { FILL_NOTES, SECRET_ASK_EXISTS, SECRET_ASK_SHOWN } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { timeText } from "../persistence/columns.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  conversation,
  createBot,
  engineSession,
  nextTurn,
  received,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Cards } from "../turns/Cards.ts";
import { SecretAsks } from "./SecretAsks.ts";
import { Secrets } from "./Secrets.ts";

const USERNAME = "username-value@example.com";
const PASSWORD = "login-password-value";

const LOGIN_ASK = {
  name: "example-work",
  kind: "login",
  origin: "https://example.com/login",
  note: "To read the invoices on your Example account.",
};

const loginDraft: SecretDraft = {
  _tag: "login",
  origins: [SiteOrigin.make("https://example.com")],
  username: Redacted.make(USERNAME),
  password: Redacted.make(PASSWORD),
  totp: null,
};

/** Every line logged while a test runs, at any level, as JSON. */
const logged: Array<string> = [];
const domain = Layer.mergeAll(
  TestDomain.layer,
  Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      logged.push(line);
    }),
  ]),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

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
      requestId: `call-${++requests}`,
      sessionId,
      tool,
      arguments: input,
    });
  });

/** The bot's running turn says it is done and ends. */
const endsWithSay = (sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* callTool(sessionId, turnId, "say", { text: "I asked for the login.", done: true });
    yield* (yield* TestEngineControl).finishTurn({
      sessionId,
      turnId,
      outcome: { _tag: "completed" },
    });
  });

/** A bot in a turn its operator's message started. */
const scene = Effect.gen(function* () {
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Find last month's invoice on Example.");
  const turnId = yield* nextTurn(bot.id);
  return { bot, session, turnId };
});

/** The scene, with the bot's ask for the login shown and its turn ended. */
const askedScene = Effect.gen(function* () {
  const at = yield* scene;
  const answer = yield* callTool(at.session, at.turnId, "ask_for_secret", LOGIN_ASK);
  const card = yield* awaitEntry(at.bot.id, "secret-ask");
  yield* endsWithSay(at.session, at.turnId);
  yield* turnEnded(at.bot.id);
  return { ...at, answer, card };
});

/** The bot's next turn, and the text of the dispatch that started it. */
const nextWake = (botId: BotId, sessionId: SessionId, previous: TurnId) =>
  Effect.gen(function* () {
    const turnId = yield* nextTurn(botId, previous);
    return { turnId, text: (yield* received(sessionId)).at(-1)?.text ?? "" };
  });

const statusOf = (botId: BotId) =>
  awaitEntry(botId, "secret-ask").pipe(Effect.map((card) => card.status._tag));

const save = (request: EntryId | null) =>
  Effect.gen(function* () {
    return yield* (yield* SecretAsks).add({
      id: SecretId.make("sec_aaaaaaaaaaaaaaaa"),
      name: SecretName.make("example-work"),
      draft: loginDraft,
      access: { _tag: "bots", botIds: [] },
      request,
    });
  });

it.effect(
  "shows a card for a bot's ask, and gives the bot the reference of what the operator saves, never its value",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, answer, card } = yield* askedScene;
      assert.deepStrictEqual(answer, {
        _tag: "result",
        value: { status: "shown", reference: "secret:example-work", note: SECRET_ASK_SHOWN },
      });
      assert.deepStrictEqual(
        { name: card.name, secret: card.secret, note: card.note, status: card.status },
        {
          name: "example-work",
          secret: { _tag: "login", origin: SiteOrigin.make("https://example.com") },
          note: LOGIN_ASK.note,
          status: { _tag: "pending" },
        },
      );

      // Saved from the card with no bot chosen: the bot that asked may use it all the same.
      const saved = yield* save(card.id);
      assert.deepStrictEqual(saved.access, { _tag: "bots", botIds: [bot.id] });
      assert.strictEqual(yield* statusOf(bot.id), "saved");
      const woken = yield* nextWake(bot.id, session, turnId);
      assert.include(woken.text, 'reference="secret:example-work"');
      assert.include(woken.text, "saved the secret you asked for");

      // Asked again, the bot is told it has it, and no second card is shown.
      const turn = woken.turnId;
      const again = yield* callTool(session, turn, "ask_for_secret", LOGIN_ASK);
      assert.deepStrictEqual(again, {
        _tag: "result",
        value: { status: "exists", reference: "secret:example-work", note: SECRET_ASK_EXISTS },
      });
      const cards = (yield* conversation(bot.id)).filter((entry) => entry._tag === "secret-ask");
      assert.lengthOf(cards, 1);

      // The bot lists it by its reference, and nothing it was told holds a value.
      const listed = yield* callTool(session, turn, "list_secrets", {});
      assert.deepStrictEqual(listed, {
        _tag: "result",
        value: {
          status: "listed",
          secrets: [
            { reference: "secret:example-work", kind: "login", origins: ["https://example.com"] },
          ],
          note: FILL_NOTES.listed,
        },
      });
      const said = JSON.stringify([
        answer,
        again,
        listed,
        yield* received(session),
        yield* conversation(bot.id),
        logged,
      ]);
      for (const value of [USERNAME, PASSWORD]) assert.notInclude(said, value);
    }).pipe(Effect.provide(domain)),
);

it.effect("closes an ask the operator declines once, and wakes the bot to say so", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, card } = yield* askedScene;
    const cards = yield* Cards;
    yield* cards.answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } });
    assert.strictEqual(yield* statusOf(bot.id), "declined");
    const again = yield* Effect.exit(
      cards.answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } }),
    );
    assert.isTrue(Exit.isFailure(again));
    if (Exit.isFailure(again)) assert.include(JSON.stringify(again.cause), "card-closed");

    const { text } = yield* nextWake(bot.id, session, turnId);
    assert.include(text, "declined to give the secret you asked for");
    // It names which ask closed.
    assert.include(text, 'reference="secret:example-work"');
  }).pipe(Effect.provide(domain)),
);

it.effect(
  "closes an ask nobody answered once its wait is over, and keeps a secret saved after",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, card } = yield* askedScene;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE secret_asks SET expires_at = ${timeText(yield* DateTime.now)}`;
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual(yield* statusOf(bot.id), "expired");
      const { text } = yield* nextWake(bot.id, session, turnId);
      assert.include(text, "waited too long");

      // The operator typed it all the same: it is saved, and the card stays as it closed.
      yield* save(card.id);
      assert.strictEqual(yield* statusOf(bot.id), "expired");
      const listed = yield* (yield* Secrets).list;
      assert.deepStrictEqual(
        listed.map((secret) => secret.name),
        ["example-work"],
      );
    }).pipe(Effect.provide(domain)),
);

it.effect(
  "closes as saved an ask whose secret was added before the server could close its card",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, card } = yield* askedScene;
      // The server stopped between adding the secret and closing the card.
      yield* (yield* Secrets).add({
        id: SecretId.make("sec_aaaaaaaaaaaaaaaa"),
        name: SecretName.make("example-work"),
        draft: loginDraft,
        access: { _tag: "bots", botIds: [bot.id] },
        askedIn: card.id,
      });
      assert.strictEqual(yield* statusOf(bot.id), "pending");
      // A device that lost the answer sends it again, under another id.
      const again = yield* (yield* SecretAsks).add({
        id: SecretId.make("sec_bbbbbbbbbbbbbbbb"),
        name: SecretName.make("example-work"),
        draft: loginDraft,
        access: { _tag: "bots", botIds: [] },
        request: card.id,
      });
      assert.strictEqual(again.id, "sec_aaaaaaaaaaaaaaaa");
      assert.strictEqual(yield* statusOf(bot.id), "saved");
      const { text } = yield* nextWake(bot.id, session, turnId);
      assert.include(text, "saved the secret you asked for");
    }).pipe(Effect.provide(domain)),
);

it.effect("closes such an ask as saved at the next sweep when no device sends it again", () =>
  Effect.gen(function* () {
    const { bot, card } = yield* askedScene;
    yield* (yield* Secrets).add({
      id: SecretId.make("sec_aaaaaaaaaaaaaaaa"),
      name: SecretName.make("example-work"),
      draft: loginDraft,
      access: { _tag: "bots", botIds: [bot.id] },
      askedIn: card.id,
    });
    yield* TestClock.adjust(Duration.minutes(1));
    assert.strictEqual(yield* statusOf(bot.id), "saved");
  }).pipe(Effect.provide(domain)),
);

it.effect("tells a bot that a secret of that name it may use is not the one it asks for", () =>
  Effect.gen(function* () {
    const { bot, session, turnId } = yield* scene;
    yield* (yield* Secrets).add({
      id: SecretId.make("sec_aaaaaaaaaaaaaaaa"),
      name: SecretName.make("example-work"),
      draft: { ...loginDraft, origins: [SiteOrigin.make("https://other.example")] },
      access: { _tag: "bots", botIds: [bot.id] },
    });
    const answer = yield* callTool(session, turnId, "ask_for_secret", LOGIN_ASK);
    assert.strictEqual(answer._tag, "refused");
    assert.include(JSON.stringify(answer), "https://other.example");
    assert.isEmpty((yield* conversation(bot.id)).filter((entry) => entry._tag === "secret-ask"));
  }).pipe(Effect.provide(domain)),
);

it.effect("shows no card for a name another secret has, nor for a login without its page", () =>
  Effect.gen(function* () {
    // A secret of that name no bot may use, this one among them.
    yield* save(null);
    const { bot, session, turnId } = yield* scene;
    const taken = yield* callTool(session, turnId, "ask_for_secret", LOGIN_ASK);
    const pageless = yield* callTool(session, turnId, "ask_for_secret", {
      ...LOGIN_ASK,
      name: "example-home",
      origin: "not an address",
    });
    for (const answer of [taken, pageless]) assert.strictEqual(answer._tag, "refused");
    assert.isEmpty((yield* conversation(bot.id)).filter((entry) => entry._tag === "secret-ask"));
  }).pipe(Effect.provide(domain)),
);
