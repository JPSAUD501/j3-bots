// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type EntryId,
  Invalid,
  type MessageDelivery,
  type ProviderId,
  type ProviderStatus,
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { BotStore } from "../bots/BotStore.ts";
import type { ServerConfigShape } from "../config.ts";
import * as Domain from "../domain.ts";
import { homeLayout } from "../home/entries.ts";
import { migrate, migrationsThrough } from "../persistence/Migrations.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDatabase from "../testing/database.ts";
import * as TestDomain from "../testing/domain.ts";
import { archive, member, roomWith } from "../testing/rooms.ts";
import {
  awaitEntry,
  command,
  conversation,
  createNewBot,
  delivery,
  deliveryIs,
  engineSession,
  finishRunning,
  flushed,
  gateSettled,
  holdGate,
  nextTurn,
  providerIs,
  providerLists,
  saysDone,
  sendToBot,
  sessionAfter,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { BotStates } from "./BotStates.ts";
import { typingPause } from "./firstContact.ts";
import { busyBackoff } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { Stops } from "./Stops.ts";

// A bot's first turn opens its conversation (`docs/product/experience.md`,
// First run). Its hello waits for a provider that can run it, a bot on the
// server's default model moves to one that can, and what the operator writes
// meanwhile goes once the hello has ended.

const FIRST_RUN = 'event="first-run"';
const { DEFAULT_MODEL, OTHER_PROVIDER_MODEL } = TestDomain;
const signedOut = { _tag: "sign-in-required", command: "connect" } as const;
const notInstalled = { _tag: "unavailable", checking: false } as const;

/** Claude Code and Codex, as the engine reports them before its first check of each. */
const bothChecking = Effect.gen(function* () {
  for (const { providerId } of [DEFAULT_MODEL, OTHER_PROVIDER_MODEL]) {
    yield* providerIs(providerId, { _tag: "unavailable", checking: true });
  }
});

/** Codex turns out ready, and Claude Code not installed. */
const onlyCodexConnects = Effect.gen(function* () {
  yield* providerIs(OTHER_PROVIDER_MODEL.providerId, { _tag: "ready" });
  yield* providerIs(DEFAULT_MODEL.providerId, notInstalled);
});

const modelOf = (botId: BotId) =>
  Effect.gen(function* () {
    const found = yield* (yield* BotStore).find(botId);
    if (Option.isNone(found)) return assert.fail("The bot is gone");
    return found.value.bot.model;
  });

/** Whether the server chose the bot's model and its permission mode, as recorded. */
const chosenByServer = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly model_by_server: number;
      readonly permission_mode_by_server: number;
    }>`SELECT model_by_server, permission_mode_by_server FROM bots WHERE id = ${botId}`;
    return row;
  });

/** Waits until the dispatcher has written a dispatch. */
const dispatchWritten = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* until(
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM dispatches`.pipe(
      Effect.orDie,
      Effect.map(([row]) => (row?.n ?? 0) > 0),
    ),
  );
});

/**
 * Each occurrence of `texts` the engine received in the session, in the order
 * it received them: dispatch by dispatch, and within one by where it stands.
 */
const sentInOrder = (sessionId: SessionId, texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const received = yield* (yield* TestEngineControl).dispatches(sessionId);
    return received.flatMap((dispatch) => {
      const found: Array<{ readonly at: number; readonly text: string }> = [];
      for (const text of texts) {
        for (
          let at = dispatch.text.indexOf(text);
          at !== -1;
          at = dispatch.text.indexOf(text, at + text.length)
        ) {
          found.push({ at, text });
        }
      }
      return found.sort((a, b) => a.at - b.at).map(({ text }) => text);
    });
  });

/** How many dispatches of the session carried `text`. */
const dispatchesWith = (sessionId: SessionId, text: string) =>
  Effect.gen(function* () {
    const received = yield* (yield* TestEngineControl).dispatches(sessionId);
    return received.filter((dispatch) => dispatch.text.includes(text)).length;
  });

/** The hello's turn and the next one, each ending with the bot saying it is done. */
const helloThenNext = (botId: BotId) =>
  Effect.gen(function* () {
    const hello = yield* finishRunning(botId);
    yield* finishRunning(botId, hello);
  });

const behindOpening: MessageDelivery = { _tag: "pending", behindOpening: true };

const deliveredBoth = (first: EntryId, second: EntryId) =>
  Effect.gen(function* () {
    yield* deliveryIs(first, "delivered");
    yield* deliveryIs(second, "delivered");
  });

/** The bot's model sends `text` in its turn, as one more `say`, and the server answers it. */
const sayInTurn = (
  botId: BotId,
  turnId: TurnId,
  call: string,
  input: { readonly text: string; readonly done?: true },
) =>
  Effect.gen(function* () {
    const sessionId = yield* engineSession(botId);
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "say",
      input,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: call,
      sessionId,
      tool: "say",
      arguments: input,
    });
  });

/** The texts of the bot's messages in its conversation, in order. */
const messagesOf = (botId: BotId) =>
  Effect.map(conversation(botId), (entries) =>
    entries.flatMap((entry) =>
      entry._tag === "message" && entry.author._tag === "bot" ? [entry.text] : [],
    ),
  );

/** Whether the bot is shown typing its next message. */
const typing = (botId: BotId) =>
  Effect.gen(function* () {
    const state = yield* (yield* BotStates).of(botId);
    return (state._tag === "thinking" || state._tag === "working") && state.typing;
  });

const HELLO = "Hi! I'm Juno, here to take some busywork off your plate.";
const OFFER =
  "I can sort out your files, look things up and sum them up, or remind you of what's coming.";

it.effect(
  "posts a hello's next message a moment after the one before, the bot typing meanwhile",
  () =>
    Effect.gen(function* () {
      const bot = yield* createNewBot("Juno");
      const hello = yield* nextTurn(bot.id);
      yield* sayInTurn(bot.id, hello, "hello-1", { text: HELLO });
      // The model sends the next one at once: the server holds it, as a person types it.
      const next = yield* sayInTurn(bot.id, hello, "hello-2", { text: OFFER, done: true }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* until(typing(bot.id));
      assert.deepStrictEqual(yield* messagesOf(bot.id), [HELLO]);

      yield* TestClock.adjust(typingPause(OFFER));
      assert.strictEqual((yield* Fiber.join(next))._tag, "result");
      assert.deepStrictEqual(yield* messagesOf(bot.id), [HELLO, OFFER]);
      assert.isFalse(yield* typing(bot.id));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("drops a hello's next message when the operator stops the bot while it types", () =>
  Effect.gen(function* () {
    const bot = yield* createNewBot("Juno");
    const hello = yield* nextTurn(bot.id);
    yield* sayInTurn(bot.id, hello, "hello-1", { text: HELLO });
    const next = yield* sayInTurn(bot.id, hello, "hello-2", { text: OFFER, done: true }).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* until(typing(bot.id));

    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* TestClock.adjust(typingPause(OFFER));
    assert.strictEqual((yield* Fiber.join(next))._tag, "refused");
    assert.deepStrictEqual(yield* messagesOf(bot.id), [HELLO]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** What a first-run envelope adds when the opening asks the operator's name. */
const ASKS_NAME = "None of their bots knows yet what they want to be called";

it.effect("asks the operator's name in the first bot's opening only, also when it goes again", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const first = yield* createNewBot("Juno");
    const firstSession = yield* engineSession(first.id);
    const hello = yield* nextTurn(first.id);
    assert.strictEqual(yield* dispatchesWith(firstSession, ASKS_NAME), 1);
    yield* control.finishTurn({
      sessionId: firstSession,
      turnId: hello,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });

    // Offered again, it is still the first bot's opening, and asks again.
    const failed = yield* awaitEntry(first.id, "notice");
    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: failed.id });
    yield* finishRunning(first.id, hello);
    assert.strictEqual(yield* dispatchesWith(firstSession, ASKS_NAME), 2);

    // The operator passed over the question: no other bot asks it again.
    const second = yield* createNewBot("Pixel");
    yield* finishRunning(second.id);
    const secondSession = yield* engineSession(second.id);
    assert.strictEqual(yield* dispatchesWith(secondSession, FIRST_RUN), 1);
    assert.strictEqual(yield* dispatchesWith(secondSession, ASKS_NAME), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("asks the operator's name in the next bot's opening when the first one's failed", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const first = yield* createNewBot("Juno");
    const firstSession = yield* engineSession(first.id);
    const hello = yield* nextTurn(first.id);
    yield* control.finishTurn({
      sessionId: firstSession,
      turnId: hello,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });
    yield* awaitEntry(first.id, "notice");

    // Never retried, it asked nobody: the next bot to open asks.
    const second = yield* createNewBot("Pixel");
    yield* finishRunning(second.id);
    assert.strictEqual(yield* dispatchesWith(yield* engineSession(second.id), ASKS_NAME), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("asks no name in an opening once the operator has one", () =>
  Effect.gen(function* () {
    yield* (yield* SettingsService).update({
      commandId: command(),
      changes: { operatorName: "Ana" },
    });
    const bot = yield* createNewBot("Juno");
    yield* finishRunning(bot.id);

    const session = yield* engineSession(bot.id);
    assert.strictEqual(yield* dispatchesWith(session, FIRST_RUN), 1);
    assert.strictEqual(yield* dispatchesWith(session, ASKS_NAME), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** What a first-run envelope adds for a bot made from a template. */
const FROM_TEMPLATE = "You were made from a template someone shared";

it.effect("tells a bot made from a template, and only it, that its job approves no work", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    const fromTemplate = yield* (yield* Bots).createFromTemplate({
      commandId: command(),
      from: {
        template: {
          format: TEMPLATE_FORMAT,
          version: TEMPLATE_VERSION,
          profile: {
            name: "Scout",
            title: "Research",
            avatar: { shape: "bean", color: "honey" },
            job: "Every morning, sends a digest of the news.",
          },
          model: DEFAULT_MODEL,
          permissionMode: "supervised",
          skills: [],
          routines: [],
        },
      },
    });
    const plain = yield* createNewBot("Juno");
    yield* finishRunning(fromTemplate.id);
    yield* finishRunning(plain.id);

    const templateSession = yield* engineSession(fromTemplate.id);
    assert.strictEqual(yield* dispatchesWith(templateSession, FIRST_RUN), 1);
    assert.strictEqual(yield* dispatchesWith(templateSession, FROM_TEMPLATE), 1);
    assert.strictEqual(yield* dispatchesWith(yield* engineSession(plain.id), FROM_TEMPLATE), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("creates a bot before any provider is connected, and it speaks once one is", () =>
  Effect.gen(function* () {
    yield* providerIs(DEFAULT_MODEL.providerId, notInstalled);
    yield* providerIs(OTHER_PROVIDER_MODEL.providerId, signedOut);
    // No model named: the one a command connects, not the one the engine cannot run.
    const bot = yield* createNewBot("Ana");
    assert.deepStrictEqual(bot.model, OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, FIRST_RUN), 0);

    yield* providerIs(OTHER_PROVIDER_MODEL.providerId, { _tag: "ready" });
    yield* nextTurn(bot.id);
    assert.strictEqual(yield* timesSent(session, FIRST_RUN), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "puts a bot created without a model on one that runs now, then at its limit, signed out, or still checked",
  () =>
    Effect.gen(function* () {
      const createdOn = (name: string) => Effect.map(createNewBot(name), (bot) => bot.model);
      yield* providerIs(DEFAULT_MODEL.providerId, signedOut);
      yield* providerIs(OTHER_PROVIDER_MODEL.providerId, { _tag: "limited", resetsAt: null });
      assert.deepStrictEqual(yield* createdOn("Ana"), OTHER_PROVIDER_MODEL);

      yield* providerIs(DEFAULT_MODEL.providerId, { _tag: "unavailable", checking: true });
      yield* providerIs(OTHER_PROVIDER_MODEL.providerId, signedOut);
      assert.deepStrictEqual(yield* createdOn("Bia"), OTHER_PROVIDER_MODEL);

      yield* providerIs(OTHER_PROVIDER_MODEL.providerId, notInstalled);
      assert.deepStrictEqual(yield* createdOn("Caio"), DEFAULT_MODEL);

      // Nothing that could ever run it.
      yield* providerIs(DEFAULT_MODEL.providerId, notInstalled);
      const refused = yield* (yield* Bots)
        .create({ commandId: command(), draft: { name: "Duda", job: "" } })
        .pipe(Effect.flip);
      assert.deepStrictEqual(refused, new Invalid({ reason: "model" }));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("moves a first bot from a provider that never connects to the one that does", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const bot = yield* createNewBot("Ana");
    assert.deepStrictEqual(bot.model, DEFAULT_MODEL);
    const first = yield* engineSession(bot.id);
    yield* flushed(bot.id);

    yield* onlyCodexConnects;
    const moved = yield* sessionAfter(bot.id, first);
    yield* nextTurn(bot.id);
    yield* flushed(bot.id);
    assert.deepStrictEqual(yield* modelOf(bot.id), OTHER_PROVIDER_MODEL);
    // Still the server's choice, the permission mode with it.
    assert.deepStrictEqual(yield* chosenByServer(bot.id), {
      model_by_server: 1,
      permission_mode_by_server: 1,
    });
    assert.deepStrictEqual(
      [yield* timesSent(first, FIRST_RUN), yield* timesSent(moved, FIRST_RUN)],
      [0, 1],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps the permission mode the operator chose when it moves the bot", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const bot = yield* (yield* Bots).create({
      commandId: command(),
      draft: { name: "Ana", job: "", permissionMode: "supervised" },
    });
    const first = yield* engineSession(bot.id);

    yield* onlyCodexConnects;
    yield* sessionAfter(bot.id, first);
    const found = yield* (yield* BotStore).find(bot.id);
    assert.deepStrictEqual(
      Option.map(found, ({ bot: moved }) => [moved.model, moved.permissionMode]),
      Option.some([OTHER_PROVIDER_MODEL, "supervised"]),
    );
    assert.deepStrictEqual(yield* chosenByServer(bot.id), {
      model_by_server: 1,
      permission_mode_by_server: 0,
    });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("moves every first bot created before a provider connects, each saying hello once", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const ana = yield* createNewBot("Ana");
    const bia = yield* createNewBot("Bia");
    const firsts = [yield* engineSession(ana.id), yield* engineSession(bia.id)];

    yield* onlyCodexConnects;
    const sent = [];
    for (const [index, bot] of [ana, bia].entries()) {
      const first = firsts[index];
      assert.isDefined(first);
      const moved = yield* sessionAfter(bot.id, first);
      yield* nextTurn(bot.id);
      yield* flushed(bot.id);
      assert.deepStrictEqual(yield* modelOf(bot.id), OTHER_PROVIDER_MODEL);
      sent.push([yield* timesSent(first, FIRST_RUN), yield* timesSent(moved, FIRST_RUN)]);
    }
    assert.deepStrictEqual(sent, [
      [0, 1],
      [0, 1],
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("moves a bot once a ready provider lists its first model", () =>
  Effect.gen(function* () {
    // Codex is ready, and lists no model yet: no bot goes there.
    yield* providerLists(OTHER_PROVIDER_MODEL.providerId, []);
    yield* providerIs(DEFAULT_MODEL.providerId, { _tag: "unavailable", checking: true });
    const bot = yield* createNewBot("Ana");
    assert.deepStrictEqual(bot.model, DEFAULT_MODEL);
    const first = yield* engineSession(bot.id);

    yield* providerLists(OTHER_PROVIDER_MODEL.providerId, [
      { id: OTHER_PROVIDER_MODEL.modelId, name: "GPT", efforts: [] },
    ]);
    const moved = yield* sessionAfter(bot.id, first);
    yield* nextTurn(bot.id);
    assert.deepStrictEqual(yield* modelOf(bot.id), OTHER_PROVIDER_MODEL);
    assert.strictEqual(yield* timesSent(moved, FIRST_RUN), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "leaves a bot on the server's model where it is once the operator turns that account off",
  () =>
    Effect.gen(function* () {
      yield* bothChecking;
      const bot = yield* createNewBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* flushed(bot.id);

      yield* providerIs(DEFAULT_MODEL.providerId, {
        _tag: "unavailable",
        checking: false,
        reason: "disabled",
      });
      yield* providerIs(OTHER_PROVIDER_MODEL.providerId, { _tag: "ready" });
      yield* (yield* Bots).adoptDefaults();
      yield* flushed(bot.id);
      assert.deepStrictEqual(yield* modelOf(bot.id), DEFAULT_MODEL);
      assert.strictEqual(yield* engineSession(bot.id), session);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves a model the operator chose where it is, its hello waiting", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const bot = yield* createNewBot("Ana", DEFAULT_MODEL);
    const session = yield* engineSession(bot.id);
    yield* flushed(bot.id);

    yield* onlyCodexConnects;
    yield* (yield* Bots).adoptDefaults();
    yield* flushed(bot.id);
    assert.deepStrictEqual(yield* modelOf(bot.id), DEFAULT_MODEL);
    assert.strictEqual(yield* engineSession(bot.id), session);
    assert.strictEqual(yield* timesSent(session, FIRST_RUN), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "leaves a bot where the operator put it while its hello waited on the server's model",
  () =>
    Effect.gen(function* () {
      yield* bothChecking;
      const bot = yield* createNewBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* (yield* Bots).update({
        commandId: command(),
        botId: bot.id,
        changes: { model: DEFAULT_MODEL },
      });
      assert.strictEqual((yield* chosenByServer(bot.id))?.model_by_server, 0);

      yield* onlyCodexConnects;
      yield* (yield* Bots).adoptDefaults();
      assert.deepStrictEqual(yield* modelOf(bot.id), DEFAULT_MODEL);
      assert.strictEqual(yield* engineSession(bot.id), session);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("lets the operator's choice of model win over a move waiting for the bot's session", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const bot = yield* createNewBot("Ana");
    yield* engineSession(bot.id);

    // The move waits for the session the gate holds; so does the operator's change.
    const gate = yield* holdGate(bot.id);
    yield* onlyCodexConnects;
    const chosen = yield* (yield* Bots)
      .update({ commandId: command(), botId: bot.id, changes: { model: DEFAULT_MODEL } })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* gate.release;
    yield* Fiber.join(chosen);
    // The pass that was under way has ended once another can begin.
    yield* (yield* Bots).adoptDefaults();
    assert.deepStrictEqual(yield* modelOf(bot.id), DEFAULT_MODEL);
    assert.strictEqual((yield* chosenByServer(bot.id))?.model_by_server, 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("moves a bot only to a provider still ready when its turn to move comes", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const ana = yield* createNewBot("Ana");
    const bia = yield* createNewBot("Bia");
    yield* engineSession(ana.id);
    yield* engineSession(bia.id);

    // Ana moves; Bia's move waits for her session meanwhile, and Codex signs out.
    const gate = yield* holdGate(bia.id);
    yield* onlyCodexConnects;
    yield* until(
      Effect.map(modelOf(ana.id), (model) => model.providerId === OTHER_PROVIDER_MODEL.providerId),
    );
    yield* providerIs(OTHER_PROVIDER_MODEL.providerId, signedOut);
    yield* gate.release;
    yield* (yield* Bots).adoptDefaults();
    assert.deepStrictEqual(yield* modelOf(bia.id), DEFAULT_MODEL);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("moves nothing of a bot deleted while its move waits for its session", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* bothChecking;
    const bot = yield* createNewBot("Ana");
    yield* engineSession(bot.id);

    const gate = yield* holdGate(bot.id);
    yield* onlyCodexConnects;
    yield* (yield* Bots).remove({ commandId: command(), botId: bot.id, deleteFiles: true });
    yield* gate.release;
    yield* (yield* Bots).adoptDefaults();
    const [left] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM bots`;
    assert.strictEqual(left?.n, 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("does not move a bot whose hello the engine already has", () =>
  Effect.gen(function* () {
    // Created on the server's choice while Claude Code runs: the hello goes there.
    const bot = yield* createNewBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* nextTurn(bot.id);

    yield* onlyCodexConnects;
    yield* (yield* Bots).adoptDefaults();
    assert.deepStrictEqual(yield* modelOf(bot.id), DEFAULT_MODEL);
    assert.strictEqual(yield* engineSession(bot.id), session);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "holds what the operator writes while the hello waits, and sends it after the hello",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { providerId } = OTHER_PROVIDER_MODEL;
      yield* providerIs(providerId, signedOut);
      const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
      const session = yield* engineSession(bot.id);
      const first = yield* sendToBot(bot.id, "Book the venue.");
      const second = yield* sendToBot(bot.id, "And the caterer.");
      yield* flushed(bot.id);
      assert.deepStrictEqual(yield* sentInOrder(session, [FIRST_RUN, "Book the venue."]), []);
      assert.deepStrictEqual(yield* delivery(first), behindOpening);

      // Connected: the hello's turn runs alone, and the messages wait like any for it to end.
      yield* providerIs(providerId, { _tag: "ready" });
      const hello = yield* nextTurn(bot.id);
      yield* flushed(bot.id);
      assert.deepStrictEqual(
        yield* sentInOrder(session, [FIRST_RUN, "Book the venue.", "And the caterer."]),
        [FIRST_RUN],
      );
      assert.deepStrictEqual(yield* delivery(first), { _tag: "pending" });

      yield* finishRunning(bot.id);
      yield* finishRunning(bot.id, hello);
      yield* deliveredBoth(first, second);
      assert.deepStrictEqual(
        yield* sentInOrder(session, [FIRST_RUN, "Book the venue.", "And the caterer."]),
        [FIRST_RUN, "Book the venue.", "And the caterer."],
      );
      // Both in the one turn after the hello's.
      assert.lengthOf(yield* control.dispatches(session), 2);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps the held messages out of a hello that said it is done until its turn ends", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const first = yield* sendToBot(bot.id, "Book the venue.");
    yield* flushed(bot.id);
    yield* providerIs(providerId, { _tag: "ready" });

    // The hello says it is done; its turn has not ended when the dispatcher
    // looks, nor when the operator writes again.
    const hello = yield* saysDone(bot.id);
    yield* flushed(bot.id);
    const second = yield* sendToBot(bot.id, "And the caterer.");
    yield* flushed(bot.id);
    assert.lengthOf(yield* control.dispatches(session), 1);
    assert.deepStrictEqual(yield* delivery(first), { _tag: "pending" });

    yield* control.finishTurn({
      sessionId: session,
      turnId: hello,
      outcome: { _tag: "completed" },
    });
    yield* finishRunning(bot.id, hello);
    yield* deliveredBoth(first, second);
    assert.deepStrictEqual(
      yield* sentInOrder(session, [FIRST_RUN, "Book the venue.", "And the caterer."]),
      [FIRST_RUN, "Book the venue.", "And the caterer."],
    );
    assert.lengthOf(yield* control.dispatches(session), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends the held messages once the hello stopped at its usage limit, before the reset",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { providerId } = OTHER_PROVIDER_MODEL;
      yield* providerIs(providerId, signedOut);
      const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
      const session = yield* engineSession(bot.id);
      const message = yield* sendToBot(bot.id, "Book the venue.");
      yield* flushed(bot.id);
      yield* providerIs(providerId, { _tag: "ready" });

      // The hello stops at the usage limit, to go on at the reset an hour away.
      const hello = yield* nextTurn(bot.id);
      const resumesAt = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
      yield* control.finishTurn({
        sessionId: session,
        turnId: hello,
        outcome: { _tag: "failed", failure: "usage-limit", retryAt: resumesAt },
        continuation: { resumesAt },
      });
      yield* turnEnded(bot.id);

      // The held message goes now, as one the operator wrote then would.
      yield* finishRunning(bot.id, hello);
      yield* deliveryIs(message, "delivered");
      assert.deepStrictEqual(yield* sentInOrder(session, [FIRST_RUN, "Book the venue."]), [
        FIRST_RUN,
        "Book the venue.",
      ]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps every message behind a hello its provider turned ready for, in order", () =>
  Effect.gen(function* () {
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const first = yield* sendToBot(bot.id, "Book the venue.");
    yield* flushed(bot.id);

    // Ready: the hello is written, and its send waits; the operator writes again.
    const gate = yield* holdGate(bot.id);
    yield* providerIs(providerId, { _tag: "ready" });
    yield* dispatchWritten;
    const second = yield* sendToBot(bot.id, "And the caterer.");
    assert.deepStrictEqual(yield* delivery(second), behindOpening);
    yield* gate.release;

    yield* helloThenNext(bot.id);
    yield* deliveredBoth(first, second);
    assert.deepStrictEqual(
      yield* sentInOrder(session, [FIRST_RUN, "Book the venue.", "And the caterer."]),
      [FIRST_RUN, "Book the venue.", "And the caterer."],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows a held message behind the hello again when the engine goes before the hello is sent",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { providerId } = OTHER_PROVIDER_MODEL;
      yield* providerIs(providerId, signedOut);
      const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
      const session = yield* engineSession(bot.id);
      const message = yield* sendToBot(bot.id, "Book the venue.");
      yield* flushed(bot.id);

      // The hello's send is claimed, and the engine goes before it arrives.
      const sending = yield* control.holdNext("dispatch");
      yield* providerIs(providerId, { _tag: "ready" });
      yield* sending.entered;
      assert.deepStrictEqual(yield* delivery(message), { _tag: "pending" });
      yield* control.setReachable(false);
      yield* sending.release;
      yield* gateSettled(bot.id);
      assert.deepStrictEqual(yield* delivery(message), behindOpening);

      yield* control.setReachable(true);
      yield* helloThenNext(bot.id);
      yield* deliveryIs(message, "delivered");
      assert.deepStrictEqual(yield* sentInOrder(session, [FIRST_RUN, "Book the venue."]), [
        FIRST_RUN,
        "Book the venue.",
      ]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows a held message behind the hello again when the engine refuses the hello's mode",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { providerId } = OTHER_PROVIDER_MODEL;
      yield* providerIs(providerId, signedOut);
      yield* TestClock.adjust("1 second");
      const bot = yield* (yield* Bots).create({
        commandId: command(),
        draft: { name: "Ana", job: "", model: OTHER_PROVIDER_MODEL, permissionMode: "full-access" },
      });
      yield* engineSession(bot.id);
      const message = yield* sendToBot(bot.id, "Book the venue.");
      yield* flushed(bot.id);

      // The session was opened before a policy that refuses its mode: the
      // hello's send is claimed, and the engine refuses its turn.
      yield* control.limitPermissionModes("auto");
      yield* providerIs(providerId, { _tag: "ready" });
      yield* until(Effect.map(control.modeRefusals, (refusals) => refusals === 1));
      yield* gateSettled(bot.id);
      assert.deepStrictEqual(yield* delivery(message), behindOpening);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a written hello only once its provider is ready again", () =>
  Effect.gen(function* () {
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* flushed(bot.id);

    // The hello is written while the provider is ready, which signs out before it is sent.
    const gate = yield* holdGate(bot.id);
    yield* providerIs(providerId, { _tag: "ready" });
    yield* dispatchWritten;
    yield* providerIs(providerId, signedOut);
    yield* gate.release;
    yield* flushed(bot.id);
    assert.deepStrictEqual(yield* sentInOrder(session, [FIRST_RUN, "Book the venue."]), []);
    assert.deepStrictEqual(yield* delivery(message), behindOpening);

    yield* providerIs(providerId, { _tag: "ready" });
    yield* helloThenNext(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.deepStrictEqual(yield* sentInOrder(session, [FIRST_RUN, "Book the venue."]), [
      FIRST_RUN,
      "Book the venue.",
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "moves a bot whose hello was written for a provider that went, and says it on the new one",
  () =>
    Effect.gen(function* () {
      yield* bothChecking;
      const bot = yield* createNewBot("Ana");
      const first = yield* engineSession(bot.id);
      const message = yield* sendToBot(bot.id, "Book the venue.");
      yield* flushed(bot.id);

      // Claude Code turns ready and the hello is written; before it is sent,
      // Claude Code goes and Codex connects.
      const gate = yield* holdGate(bot.id);
      yield* providerIs(DEFAULT_MODEL.providerId, { _tag: "ready" });
      yield* dispatchWritten;
      yield* onlyCodexConnects;
      yield* gate.release;

      const moved = yield* sessionAfter(bot.id, first);
      yield* helloThenNext(bot.id);
      yield* deliveryIs(message, "delivered");
      assert.deepStrictEqual(yield* sentInOrder(first, [FIRST_RUN, "Book the venue."]), []);
      assert.deepStrictEqual(yield* sentInOrder(moved, [FIRST_RUN, "Book the venue."]), [
        FIRST_RUN,
        "Book the venue.",
      ]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a message held behind the hello through the move to a ready provider", () =>
  Effect.gen(function* () {
    yield* bothChecking;
    const bot = yield* createNewBot("Ana");
    const first = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* flushed(bot.id);

    yield* onlyCodexConnects;
    const moved = yield* sessionAfter(bot.id, first);
    yield* helloThenNext(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.deepStrictEqual(yield* sentInOrder(first, [FIRST_RUN, "Book the venue."]), []);
    assert.deepStrictEqual(yield* sentInOrder(moved, [FIRST_RUN, "Book the venue."]), [
      FIRST_RUN,
      "Book the venue.",
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a hello held with messages before a restart once, then the messages", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { providerId } = OTHER_PROVIDER_MODEL;
    const { bot, session } = yield* Effect.gen(function* () {
      yield* providerIs(providerId, signedOut);
      const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Book the venue.");
      yield* sendToBot(bot.id, "And the caterer.");
      yield* flushed(bot.id);
      return { bot, session };
    }).pipe(Effect.provide(Domain.layer));

    // The server starts again, and the provider turns ready.
    yield* Effect.gen(function* () {
      yield* flushed(bot.id);
      assert.strictEqual(yield* timesSent(session, FIRST_RUN), 0);
      yield* providerIs(providerId, { _tag: "ready" });
      yield* helloThenNext(bot.id);
      assert.deepStrictEqual(
        yield* sentInOrder(session, [FIRST_RUN, "Book the venue.", "And the caterer."]),
        [FIRST_RUN, "Book the venue.", "And the caterer."],
      );
      assert.lengthOf(yield* control.dispatches(session), 2);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

/**
 * Two messages held behind a hello that fails as `fail` arranges before its
 * turn starts, each too long to share an envelope with the other: the hello
 * offers no retry, and the messages go after it, in order, one dispatch each.
 */
const heldBehindAHelloThatNeverRan = (
  fail: (session: SessionId) => Effect.Effect<void, never, TestEngineControl>,
) =>
  Effect.gen(function* () {
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const first = yield* sendToBot(bot.id, `Book the venue. ${"x".repeat(70_000)}`);
    const second = yield* sendToBot(bot.id, `And the caterer. ${"y".repeat(70_000)}`);
    yield* flushed(bot.id);

    yield* fail(session);
    yield* providerIs(providerId, { _tag: "ready" });
    const failed = yield* awaitEntry(bot.id, "notice");
    assert.isFalse(failed.retryable);

    // The first message's turn, which the second reaches as a steer.
    yield* nextTurn(bot.id);
    yield* until(Effect.map(timesSent(session, "And the caterer."), (times) => times === 1));
    yield* finishRunning(bot.id);
    yield* deliveredBoth(first, second);
    assert.deepStrictEqual(yield* sentInOrder(session, ["Book the venue.", "And the caterer."]), [
      "Book the venue.",
      "And the caterer.",
    ]);
    assert.deepStrictEqual(
      [
        yield* dispatchesWith(session, "Book the venue."),
        yield* dispatchesWith(session, "And the caterer."),
      ],
      [1, 1],
    );
  });

it.effect("delivers, in order, the messages held behind a hello whose turn failed to start", () =>
  heldBehindAHelloThatNeverRan((sessionId) =>
    Effect.gen(function* () {
      yield* (yield* TestEngineControl).failNextStart({ sessionId, failure: "provider-error" });
    }),
  ).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("delivers, in order, the messages held behind a hello the engine refused", () =>
  heldBehindAHelloThatNeverRan(() =>
    Effect.gen(function* () {
      yield* (yield* TestEngineControl).rejectNextDispatch;
    }),
  ).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("stops a waiting hello and the messages behind it, and sends none of them later", () =>
  Effect.gen(function* () {
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const first = yield* sendToBot(bot.id, "Book the venue.");
    const second = yield* sendToBot(bot.id, "And the caterer.");
    yield* flushed(bot.id);

    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* deliveryIs(first, "cancelled");
    yield* deliveryIs(second, "cancelled");
    yield* providerIs(providerId, { _tag: "ready" });
    yield* flushed(bot.id);
    assert.deepStrictEqual(
      yield* sentInOrder(session, [FIRST_RUN, "Book the venue.", "And the caterer."]),
      [],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels a message held behind a hello that ended when the provider changes", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* flushed(bot.id);

    // The hello runs and ends. The message's start then meets a turn the
    // engine began on its own, and waits out the busy deadline as pending.
    yield* providerIs(providerId, { _tag: "ready" });
    const hello = yield* nextTurn(bot.id);
    const sending = yield* control.holdNext("dispatch");
    yield* finishRunning(bot.id);
    yield* sending.entered;
    const background = yield* control.startEngineTurn(session);
    const answer = yield* control.holdNextAnswer("dispatch");
    yield* sending.release;
    yield* answer.entered;
    yield* nextTurn(bot.id, hello);
    yield* control.finishTurn({
      sessionId: session,
      turnId: background,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* answer.release;
    yield* gateSettled(bot.id);
    yield* flushed(bot.id);
    assert.deepStrictEqual(yield* delivery(message), { _tag: "pending" });

    // No longer held: the change of provider cancels it, as any queued message.
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { model: DEFAULT_MODEL },
    });
    yield* deliveryIs(message, "cancelled");
    const moved = yield* sessionAfter(bot.id, session);
    yield* TestClock.adjust(busyBackoff(1));
    yield* flushed(bot.id);
    assert.deepStrictEqual(
      [yield* timesSent(session, "Book the venue."), yield* timesSent(moved, "Book the venue.")],
      [0, 0],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a member's messages held in private when a room of theirs is archived", () =>
  Effect.gen(function* () {
    const { providerId } = OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, signedOut);
    const bot = yield* createNewBot("Ana", OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    const host = yield* member("Bia");
    const room = yield* roomWith(host, [{ bot, session }]);
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* flushed(bot.id);

    yield* archive(room.id, true);
    assert.deepStrictEqual(yield* delivery(message), behindOpening);
    yield* providerIs(providerId, { _tag: "ready" });
    yield* helloThenNext(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.deepStrictEqual(yield* sentInOrder(session, [FIRST_RUN, "Book the venue."]), [
      FIRST_RUN,
      "Book the venue.",
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/**
 * What the release that ended with migration 17 left: a bot on Claude Code,
 * whose hello waits. Nothing records who chose its model.
 */
const writtenBefore = (config: ServerConfigShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    yield* migrate(migrationsThrough(17));
    const at = "2026-11-20T09:00:00.000Z";
    yield* sql`
      INSERT INTO bots (
        id, name, title, avatar_shape, avatar_color, job, provider_id, model_id,
        permission_mode, workspace_path, created_at, updated_at
      ) VALUES (
        'ana', 'Ana', '', 'circle', 'blue', '', ${DEFAULT_MODEL.providerId},
        ${DEFAULT_MODEL.modelId}, 'auto', ${homeLayout(path, config.home).workspace("ana")},
        ${at}, ${at}
      )
    `;
    yield* sql`INSERT INTO conversations (bot_id, created_at) VALUES ('ana', ${at})`;
    yield* sql`
      INSERT INTO wakes (
        id, bot_id, kind, priority, audience, payload_json, status, created_at, updated_at
      ) VALUES (
        'wake-1', 'ana', 'system', 3, 'conversation', '{"_tag":"first-run"}', 'pending', ${at},
        ${at}
      )
    `;
  });

it.effect("keeps the model of a bot from before the server recorded who chose it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ana = BotId.make("ana");
    // The other harness connects; Claude Code stays unable to run.
    yield* providerIs(OTHER_PROVIDER_MODEL.providerId, { _tag: "ready" });
    yield* (yield* Bots).adoptDefaults();
    assert.deepStrictEqual(yield* modelOf(ana), DEFAULT_MODEL);
    assert.deepStrictEqual(yield* chosenByServer(ana), {
      model_by_server: 0,
      permission_mode_by_server: 0,
    });
    const [opening] = yield* sql<{ readonly status: string }>`
      SELECT status FROM wakes WHERE id = 'wake-1'
    `;
    assert.strictEqual(opening?.status, "pending");
  }).pipe(
    Effect.provide(
      TestDomain.layerOver(
        TestDatabase.layerAfter(writtenBefore),
        new Map<ProviderId, ProviderStatus["status"]>([
          [DEFAULT_MODEL.providerId, notInstalled],
          [OTHER_PROVIDER_MODEL.providerId, signedOut],
        ]),
      ),
    ),
  ),
);
