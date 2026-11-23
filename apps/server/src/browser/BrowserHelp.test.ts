// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type {
  BotId,
  BrowserClientFrame,
  BrowserHelpEntry,
  BrowserServerFrame,
  BrowserTabRef,
  DeviceId,
} from "@j3-bots/contracts";
import { EngineTabId, type SessionId, type TurnId } from "@j3-bots/engine-t3";
import { type FakeViewer, TestBrowserControl, TestEngineControl } from "@j3-bots/engine-t3/testing";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Devices } from "../devices/Devices.ts";
import { timeText } from "../persistence/columns.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  createBot,
  engineSession,
  nextTurn,
  received,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { BrowserHelp } from "./BrowserHelp.ts";
import { SWEEP_EVERY, TAB_ABSENT_GRACE } from "./browserHelpRules.ts";
import { BrowserTabs } from "./BrowserTabs.ts";
import { BrowserViewers, type ClientLink, DEFAULT_VIEW_SIZE } from "./BrowserViewers.ts";

const SIGN_IN = "https://mail.example.com/signin";

const tabOf = (sessionId: SessionId, url = SIGN_IN) => ({
  id: EngineTabId.make("tab-mail"),
  sessionId,
  url,
  title: "Sign in",
  loading: false,
  activeAt: 1,
});

let requests = 0;

/** The bot, in its running turn, asks its operator to sign in: what the tool answers it. */
const askToSignIn = (sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    const input = { reason: "login", note: "Sign in to your mail, so I can find the invoice." };
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "request_browser_help",
      input,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `help-${++requests}`,
      sessionId,
      tool: "request_browser_help",
      arguments: input,
    });
  });

/** A bot with its mail's sign-in open in a tab, in a turn its operator's message started. */
const signInScene = (url = SIGN_IN) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const browser = yield* TestBrowserControl;
    yield* browser.setTabs([tabOf(session, url)]);
    const tabs = yield* BrowserTabs;
    yield* until(tabs.front(bot.id).pipe(Effect.map(Option.isSome)));
    yield* sendToBot(bot.id, "Has the invoice from Lena arrived?");
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, turnId, browser };
  });

/** The scene, with the bot's request for help asked and its turn over. */
const askedScene = Effect.gen(function* () {
  const scene = yield* signInScene();
  yield* askToSignIn(scene.session, scene.turnId);
  const card = yield* awaitEntry(scene.bot.id, "browser-help");
  yield* (yield* TestEngineControl).finishTurn({
    sessionId: scene.session,
    turnId: scene.turnId,
    outcome: { _tag: "completed" },
  });
  yield* turnEnded(scene.bot.id);
  return { ...scene, card };
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

/** A device paired and showing the bot's tab, the engine's viewer of it, and the client's socket. */
const watching = (ref: BrowserTabRef) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    const deviceId: DeviceId = (yield* devices.pair({ code, name: "Phone" })).deviceId;
    const sent = yield* Queue.unbounded<Uint8Array | BrowserServerFrame>();
    const incoming = yield* Queue.unbounded<BrowserClientFrame, Cause.Done>();
    const link: ClientLink = {
      send: (message) => Queue.offer(sent, message).pipe(Effect.asVoid),
      close: () => Queue.end(incoming).pipe(Effect.asVoid),
      incoming: Stream.fromQueue(incoming),
    };
    const browser = yield* TestBrowserControl;
    yield* (yield* BrowserViewers)
      .connect({ deviceId, ref, size: DEFAULT_VIEW_SIZE, link })
      .pipe(Effect.forkScoped);
    const viewer: FakeViewer = yield* browser.nextViewer;
    return { deviceId, viewer, say: (frame: BrowserClientFrame) => Queue.offer(incoming, frame) };
  });

const control = (controller: "bot" | "this-viewer") =>
  ({ _tag: "control", controller, generation: 1, dialog: null }) as const;

/** The device takes the tab, as the engine reports it. */
const takes = (viewer: FakeViewer, say: (frame: BrowserClientFrame) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    yield* say({ type: "take" });
    yield* viewer.emit(control("this-viewer"));
    const tabs = yield* BrowserTabs;
    yield* tabs.held.pipe(
      Stream.filter((held) => held.length > 0),
      Stream.runHead,
    );
  });

it.effect(
  "shows a card for the bot's front tab, and its turn ends there without a word or a follow-up",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId } = yield* signInScene();
      const answer = yield* askToSignIn(session, turnId);
      assert.strictEqual(answer._tag, "result");
      const card = yield* awaitEntry(bot.id, "browser-help");
      const tabs = yield* BrowserTabs;
      const front = Option.getOrThrow(yield* tabs.front(bot.id));
      assert.deepStrictEqual(
        { reason: card.reason, site: card.site, tab: card.tab, status: card.status },
        { reason: "login", site: "mail.example.com", tab: front.ref, status: { _tag: "pending" } },
      );

      yield* (yield* TestEngineControl).finishTurn({
        sessionId: session,
        turnId,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bot.id);
      // The card answered the operator's message: the turn needed no `say`.
      const sql = yield* SqlClient.SqlClient;
      const undelivered = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM wakes WHERE json_extract(payload_json, '$._tag') = 'undelivered'
      `;
      assert.strictEqual(undelivered[0]?.n, 0);
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

    yield* (yield* TestBrowserControl).setTabs([tabOf(session)]);
    yield* until((yield* BrowserTabs).front(bot.id).pipe(Effect.map(Option.isSome)));
    assert.strictEqual((yield* askToSignIn(session, turnId))._tag, "result");
    const again = yield* askToSignIn(session, turnId);
    assert.strictEqual(again._tag, "refused");
    const sql = yield* SqlClient.SqlClient;
    const cards = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM browser_help_cards`;
    assert.strictEqual(cards[0]?.n, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "gives the tab back to the bot before the card closes as done, then wakes it to look again",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, card } = yield* askedScene;
      const phone = yield* watching(card.tab);
      yield* takes(phone.viewer, phone.say);

      const answering = yield* (yield* BrowserHelp)
        .answer({ commandId: command(), entryId: card.id, outcome: "done" })
        .pipe(Effect.forkChild);
      yield* until(
        phone.viewer.inputs.pipe(
          Effect.map((inputs) => inputs.some((input) => input.type === "release")),
        ),
      );
      assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");
      // The engine gives the tab back to the bot.
      yield* phone.viewer.emit(control("bot"));
      yield* Fiber.join(answering);

      assert.strictEqual((yield* statusOf(bot.id))._tag, "done");
      const woken = yield* nextWake(bot.id, session, turnId);
      assert.include(woken, "Take a fresh snapshot before you act");
      assert.include(woken, 'site="mail.example.com"');
      // The device let go: that is the card's answer, not a hand-back of its own.
      assert.deepStrictEqual(yield* browserHelpWakes, ["done"]);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
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

it.effect("expires with its tab once the tab stays closed, and wakes the bot to say so", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, browser } = yield* askedScene;
    yield* browser.setTabs([]);
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

it.effect("keeps waiting while a device holds the bot's tab, and expires once it lets go", () =>
  Effect.gen(function* () {
    const { bot, session, turnId, card } = yield* askedScene;
    const phone = yield* watching(card.tab);
    yield* takes(phone.viewer, phone.say);
    // The card's wait ran out while the phone held the tab: moved here, so the
    // phone's socket, which answers no ping, stays within its silence limit.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE browser_help_cards SET expires_at = ${timeText(yield* DateTime.now)}`;
    yield* TestClock.adjust(SWEEP_EVERY);
    assert.strictEqual((yield* statusOf(bot.id))._tag, "pending");

    yield* phone.viewer.emit(control("bot"));
    yield* until(isStatus(bot.id, "expired"));
    assert.deepStrictEqual(yield* statusOf(bot.id), { _tag: "expired", cause: "timed-out" });
    yield* nextWake(bot.id, session, turnId);
    assert.deepStrictEqual(yield* browserHelpWakes, ["timed-out"]);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("wakes the bot when its operator gives back a browser they took while it worked", () =>
  Effect.gen(function* () {
    const { bot, session, turnId } = yield* signInScene();
    const tabs = yield* BrowserTabs;
    const front = Option.getOrThrow(yield* tabs.front(bot.id));
    const phone = yield* watching(front.ref);
    yield* takes(phone.viewer, phone.say);
    yield* phone.viewer.emit(control("bot"));
    yield* until(browserHelpWakes.pipe(Effect.map((wakes) => wakes.length > 0)));

    yield* (yield* TestEngineControl).finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "completed" },
    });
    const woken = yield* nextWake(bot.id, session, turnId);
    assert.include(woken, "took over your browser while you worked");
    assert.deepStrictEqual(yield* browserHelpWakes, ["handed-back"]);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("does not wake an idle bot whose browser its operator took and gave back", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* (yield* TestBrowserControl).setTabs([tabOf(session)]);
    const tabs = yield* BrowserTabs;
    yield* until(tabs.front(bot.id).pipe(Effect.map(Option.isSome)));
    // Past the bot's first turn, so no turn overlaps the takeover.
    yield* TestClock.adjust("1 minute");
    const front = Option.getOrThrow(yield* tabs.front(bot.id));
    const phone = yield* watching(front.ref);
    yield* takes(phone.viewer, phone.say);
    yield* phone.viewer.emit(control("bot"));
    yield* tabs.held.pipe(
      Stream.filter((held) => held.length === 0),
      Stream.runHead,
    );

    // The bot's next turn is the operator's message alone.
    yield* sendToBot(bot.id, "Thanks, that's all.");
    const woken = yield* nextWake(bot.id, session, null);
    assert.notInclude(woken, "took over your browser");
    assert.deepStrictEqual(yield* browserHelpWakes, []);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);
