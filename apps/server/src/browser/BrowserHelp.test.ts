// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  type BrowserHelpEntry,
  type BrowserTabRef,
  DeviceId,
  type EntryId,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { BROWSER_HELP_REQUESTED } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { timeText } from "../persistence/columns.ts";
import { botOpens } from "../testing/browser.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  createBot,
  engineSession,
  nextTurn,
  noticesOf,
  received,
  sendToBot,
  stopSettled,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Browser } from "./Browser.ts";
import { BrowserHelp } from "./BrowserHelp.ts";
import { HAND_BACK_GRACE, SWEEP_EVERY, TAB_ABSENT_GRACE } from "./browserHelpRules.ts";
import { TabAccess } from "./TabAccess.ts";

const SIGN_IN = "https://mail.example.com/signin";
const PHONE = DeviceId.make("device-phone");
const LAPTOP = DeviceId.make("device-laptop");

let requests = 0;

const SIGN_IN_HELP = { reason: "login", note: "Sign in to your mail, so I can find the invoice." };

/** The bot's request for help reaches the server, as the call `requestId`. */
const requestHelp = (sessionId: SessionId, requestId: string) =>
  Effect.gen(function* () {
    return yield* (yield* BotTools).call({
      requestId,
      sessionId,
      tool: "request_browser_help",
      arguments: SIGN_IN_HELP,
    });
  });

/** The bot, in its running turn, asks its operator to sign in: what the tool answers it. */
const askToSignIn = (sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "request_browser_help",
      input: SIGN_IN_HELP,
      recorded: "now",
    });
    return yield* requestHelp(sessionId, `help-${++requests}`);
  });

/** The bot's running turn says it is done and ends. */
const endsWithSay = (sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const args = { text: "It still needs your sign-in.", done: true };
    yield* control.toolCall({ sessionId, turnId, tool: "say", input: args, recorded: "now" });
    yield* (yield* BotTools).call({
      requestId: `say-${turnId}`,
      sessionId,
      tool: "say",
      arguments: args,
    });
    yield* control.finishTurn({ sessionId, turnId, outcome: { _tag: "completed" } });
  });

/** A bot with its mail's sign-in open in a tab of its own, in a turn its operator's message started. */
const signInScene = Effect.gen(function* () {
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  const tab = yield* botOpens(bot.id, SIGN_IN);
  yield* sendToBot(bot.id, "Has the invoice from Lena arrived?");
  const turnId = yield* nextTurn(bot.id);
  return { bot, session, turnId, tab };
});

/** The scene, with the bot's request for help asked and its turn stopped by the server. */
const askedScene = Effect.gen(function* () {
  const scene = yield* signInScene;
  yield* askToSignIn(scene.session, scene.turnId);
  const card = yield* awaitEntry(scene.bot.id, "browser-help");
  yield* turnEnded(scene.bot.id);
  return { ...scene, card };
});

/** The card's wait has run out, with nothing closing it yet. */
const overdue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE browser_help_cards SET expires_at = ${timeText(yield* DateTime.now)}`;
});

const statusOf = (botId: BotId) =>
  awaitEntry(botId, "browser-help").pipe(Effect.map((card) => card.status));

const isStatus = (botId: BotId, tag: BrowserHelpEntry["status"]["_tag"]) =>
  statusOf(botId).pipe(Effect.map((status) => status._tag === tag));

/** The bot's next turn, once it starts: the text of the dispatch that started it. */
const nextWake = (botId: BotId, sessionId: SessionId, previous: TurnId | null) =>
  Effect.gen(function* () {
    yield* nextTurn(botId, previous);
    const last = (yield* received(sessionId)).at(-1);
    assert.isDefined(last);
    return last?.text ?? "";
  });

const browserHelpWakes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly outcome: string }>`
    SELECT json_extract(payload_json, '$.outcome') AS outcome FROM wakes
    WHERE json_extract(payload_json, '$._tag') = 'browser-help'
    ORDER BY created_at
  `;
  return rows.map((row) => row.outcome);
});

/** The tab's control, as a person's device reaches it. */
const controlOf = (tab: BrowserTabRef) =>
  Effect.gen(function* () {
    const hands = yield* (yield* Browser).handsOf(tab);
    return Option.getOrThrow(hands).control;
  });

/** Whether a person holds any tab now. */
const personHolding = Effect.gen(function* () {
  const holds = yield* (yield* TabAccess).personHolds.pipe(Stream.runHead);
  return Option.getOrElse(holds, () => []).length > 0;
});

/** The person on `device` asks the bots to wait for them on the tab, and holds it. */
const takes = (tab: BrowserTabRef, device: DeviceId = PHONE) =>
  Effect.gen(function* () {
    assert.isTrue(yield* (yield* controlOf(tab)).waitForMe(device));
    yield* until(personHolding);
  });

/** The person on `device` gives the tab back. */
const givesBack = (tab: BrowserTabRef, device: DeviceId = PHONE) =>
  Effect.gen(function* () {
    yield* (yield* controlOf(tab)).release(device, false);
    yield* until(personHolding.pipe(Effect.map((holding) => !holding)));
  });

it.effect(
  "shows a card for the bot's current tab, and stops the turn that asked without a word or a follow-up",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, tab } = yield* signInScene;
      const answer = yield* askToSignIn(session, turnId);
      assert.deepStrictEqual(answer, {
        _tag: "result",
        value: { status: "requested", note: BROWSER_HELP_REQUESTED },
      });
      const card = yield* awaitEntry(bot.id, "browser-help");
      assert.deepStrictEqual(
        { reason: card.reason, site: card.site, tab: card.tab, status: card.status },
        { reason: "login", site: "mail.example.com", tab, status: { _tag: "pending" } },
      );

      // The server stops the turn: whatever the bot would do next in the
      // browser, it no longer runs to do.
      yield* turnEnded(bot.id);
      yield* stopSettled;
      // That is how the turn was meant to end: no notice of a failed turn, and
      // the card answered the operator's message, so it needed no `say`.
      assert.deepStrictEqual(yield* noticesOf(bot.id), []);
      const sql = yield* SqlClient.SqlClient;
      const undelivered = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM wakes WHERE json_extract(payload_json, '$._tag') = 'undelivered'
      `;
      assert.strictEqual(undelivered[0]?.n, 0);

      // The answer starts a turn of its own.
      yield* (yield* BrowserHelp).answer({
        commandId: command(),
        entryId: card.id,
        outcome: "done",
      });
      const woken = yield* nextWake(bot.id, session, turnId);
      assert.include(woken, "Take a fresh snapshot before you act");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers a retried request as it did, though the tab closed in between", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, tab } = yield* signInScene;
    const control = yield* TestEngineControl;
    // The server's stop is slow to land, so the engine can still retry the call.
    yield* control.delayNextStopEffects;
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "request_browser_help",
      input: SIGN_IN_HELP,
      recorded: "now",
    });
    const first = yield* requestHelp(session, "help-retried");
    assert.strictEqual(first._tag, "result");
    yield* (yield* Browser).close(tab);
    const tabs = yield* TabAccess;
    assert.isTrue(Option.isNone(yield* tabs.toolTab(bot.id, undefined)));
    assert.deepStrictEqual(yield* requestHelp(session, "help-retried"), first);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("asks nothing with no tab open, nor while another request waits", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Has the invoice from Lena arrived?");
    const turnId = yield* nextTurn(bot.id);
    const noTab = yield* askToSignIn(session, turnId);
    assert.strictEqual(noTab._tag, "refused");

    yield* botOpens(bot.id, SIGN_IN);
    assert.strictEqual((yield* askToSignIn(session, turnId))._tag, "result");
    const again = yield* askToSignIn(session, turnId);
    assert.strictEqual(again._tag, "refused");
    const sql = yield* SqlClient.SqlClient;
    const cards = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM browser_help_cards`;
    assert.strictEqual(cards[0]?.n, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "closes as done, ends the person's hold on the bot's tab, and wakes the bot to look again",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, card, tab } = yield* askedScene;
      yield* takes(tab);

      yield* (yield* BrowserHelp).answer({
        commandId: command(),
        entryId: card.id,
        outcome: "done",
      });
      // The answer gave the tab back to the bot.
      assert.isNull((yield* (yield* controlOf(tab)).state).holder);
      assert.strictEqual((yield* statusOf(bot.id))._tag, "done");

      const woken = yield* nextWake(bot.id, session, turnId);
      assert.include(woken, "Take a fresh snapshot before you act");
      assert.include(woken, 'site="mail.example.com"');
      // Letting go was the card's answer, not a hand-back of its own.
      assert.deepStrictEqual(yield* browserHelpWakes, ["done"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("closes as declined, wakes the bot once, and takes no second answer", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, card } = yield* askedScene;
    const help = yield* BrowserHelp;
    const declined = { commandId: command(), entryId: card.id, outcome: "declined" } as const;
    yield* help.answer(declined);
    // The same command again is the same answer.
    yield* help.answer(declined);
    const other = yield* help
      .answer({ commandId: command(), entryId: card.id, outcome: "done" })
      .pipe(Effect.exit);
    assert.deepStrictEqual(
      Exit.findErrorOption(other).pipe(
        Option.map((error) => (error._tag === "Conflict" ? error.reason : error._tag)),
      ),
      Option.some("card-closed"),
    );

    assert.strictEqual((yield* statusOf(bot.id))._tag, "declined");
    const woken = yield* nextWake(bot.id, session, turnId);
    assert.include(woken, "Do not try the step yourself");
    assert.deepStrictEqual(yield* browserHelpWakes, ["declined"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses to ask again on the tab its operator said no to, until they write", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, card } = yield* askedScene;
    yield* (yield* BrowserHelp).answer({
      commandId: command(),
      entryId: card.id,
      outcome: "declined",
    });
    const woken = yield* nextTurn(bot.id, turnId);
    const again = yield* askToSignIn(session, woken);
    assert.include(again._tag === "refused" ? again.message : "", "already answered");
    yield* endsWithSay(session, woken);
    yield* turnEnded(bot.id);

    yield* sendToBot(bot.id, "I'm at my desk now, ask me again.");
    const next = yield* nextTurn(bot.id, woken);
    assert.strictEqual((yield* askToSignIn(session, next))._tag, "result");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("expires with its tab once the tab stays closed, and wakes the bot to say so", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, tab } = yield* askedScene;
    yield* (yield* Browser).close(tab);
    // A gap shorter than the grace is not a closed tab.
    yield* TestClock.adjust(SWEEP_EVERY);
    assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");

    yield* TestClock.adjust(TAB_ABSENT_GRACE);
    yield* until(isStatus(bot.id, "expired"));
    assert.deepStrictEqual(yield* statusOf(bot.id), { _tag: "expired", cause: "tab-closed" });
    const woken = yield* nextWake(bot.id, session, turnId);
    assert.include(woken, "Do not ask again on your own");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps waiting while the person holds the bot's tab, and expires a while after they let go",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, tab } = yield* askedScene;
      yield* takes(tab);
      yield* overdue;
      yield* TestClock.adjust(SWEEP_EVERY);
      assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");

      // Given back, it still waits a while for its answer.
      yield* givesBack(tab);
      yield* TestClock.adjust(SWEEP_EVERY);
      assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");
      yield* TestClock.adjust(HAND_BACK_GRACE);
      yield* until(isStatus(bot.id, "expired"));
      assert.deepStrictEqual(yield* statusOf(bot.id), { _tag: "expired", cause: "timed-out" });
      const woken = yield* nextTurn(bot.id, turnId);
      assert.deepStrictEqual(yield* browserHelpWakes, ["timed-out"]);
      // Nobody answered on this tab: the bot does not ask on it again.
      assert.strictEqual((yield* askToSignIn(session, woken))._tag, "refused");
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** `answers` answers of `done` go in at once, while the person still holds the tab. */
const answerWhileHeld = (entryId: EntryId, answers: number) =>
  Effect.gen(function* () {
    const help = yield* BrowserHelp;
    const answering = yield* Effect.all(
      Array.from({ length: answers }, () =>
        help.answer({ commandId: command(), entryId, outcome: "done" }),
      ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.forkChild);
    yield* Fiber.join(answering);
  });

it.effect("closes as done when answered past its wait while the person still holds the tab", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, tab, card } = yield* askedScene;
    yield* takes(tab);
    yield* overdue;
    yield* TestClock.adjust(SWEEP_EVERY);

    yield* answerWhileHeld(card.id, 1);
    // Letting go set the sweep off, to find the card answered.
    yield* TestClock.adjust(SWEEP_EVERY);
    assert.strictEqual((yield* statusOf(bot.id))._tag, "done");
    yield* nextWake(bot.id, session, turnId);
    assert.deepStrictEqual(yield* browserHelpWakes, ["done"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "closes as done when answered past its wait just after the person gave the tab back",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, tab, card } = yield* askedScene;
      yield* takes(tab);
      yield* overdue;
      yield* givesBack(tab);
      yield* TestClock.adjust(SWEEP_EVERY);

      yield* (yield* BrowserHelp).answer({
        commandId: command(),
        entryId: card.id,
        outcome: "done",
      });
      assert.strictEqual((yield* statusOf(bot.id))._tag, "done");
      yield* nextWake(bot.id, session, turnId);
      assert.deepStrictEqual(yield* browserHelpWakes, ["done"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes the same answer from two devices at once as one", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, tab, card } = yield* askedScene;
    yield* takes(tab, LAPTOP);
    yield* overdue;

    // Neither answer fails.
    yield* answerWhileHeld(card.id, 2);
    assert.strictEqual((yield* statusOf(bot.id))._tag, "done");
    yield* nextWake(bot.id, session, turnId);
    assert.deepStrictEqual(yield* browserHelpWakes, ["done"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "wakes the bot when its operator gives back a tab they took from it while it worked",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, tab } = yield* signInScene;
      // Using the page holds it, as touching it in a viewer does.
      assert.isTrue(yield* (yield* Browser).personUsed(tab, PHONE));
      yield* until(personHolding);
      yield* givesBack(tab);
      yield* until(browserHelpWakes.pipe(Effect.map((wakes) => wakes.length > 0)));

      yield* (yield* TestEngineControl).finishTurn({
        sessionId: session,
        turnId,
        outcome: { _tag: "completed" },
      });
      const woken = yield* nextWake(bot.id, session, turnId);
      assert.include(woken, "took over your browser while you worked");
      assert.deepStrictEqual(yield* browserHelpWakes, ["handed-back"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("does not wake an idle bot whose tab its operator took and gave back", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const tab = yield* botOpens(bot.id, SIGN_IN);
    // Past the bot's first turn, so no turn overlaps the takeover.
    yield* TestClock.adjust("1 minute");
    yield* takes(tab);
    yield* givesBack(tab);

    // The bot's next turn is the operator's message alone.
    yield* sendToBot(bot.id, "Thanks, that's all.");
    const woken = yield* nextWake(bot.id, session, null);
    assert.notInclude(woken, "took over your browser");
    assert.deepStrictEqual(yield* browserHelpWakes, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);
