// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, type Conflict, Invalid, type NotFound, WorkStepId } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Domain from "../domain.ts";
import { timeText } from "../persistence/columns.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  askRegion,
  awaitEntry,
  command,
  conversation,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
  stopSettled,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { Cards } from "./Cards.ts";
import { Stops } from "./Stops.ts";

const value = { _tag: "provide", value: Redacted.make("test-token") } as const;

/**
 * A secret card, and the server stopped after writing its submission marker:
 * whether the engine got the value is for the next run to learn.
 */
const submittedThenStopped = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const sql = yield* SqlClient.SqlClient;
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Publish the package.");
  const turnId = yield* nextTurn(bot.id);
  const requestId = yield* control.openRequest({
    sessionId: session,
    turnId,
    request: {
      _tag: "secret",
      label: "npm token",
      reason: "To publish.",
      url: null,
      placeholder: null,
    },
  });
  const card = yield* awaitEntry(bot.id, "secret-request");
  yield* sql`
    INSERT INTO secret_submissions (entry_id, submission_id, submitted_at)
    VALUES (${card.id}, 'submission-before-restart', ${timeText(yield* DateTime.now)})
  `;
  return { bot, session, requestId, card };
});

const secretStatus = (botId: BotId) =>
  awaitEntry(botId, "secret-request").pipe(Effect.map((card) => card.status));

it.effect("learns after a restart that a submission landed, and sends no second value", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const engine = yield* Engine;
    const { bot, session, requestId, card } = yield* submittedThenStopped.pipe(
      Effect.provide(Domain.layer),
    );
    // The submission in flight reached the engine while the server was down.
    yield* engine.respondSecret({ sessionId: session, requestId, answer: value });

    yield* Effect.gen(function* () {
      yield* until(secretStatus(bot.id).pipe(Effect.map((status) => status === "provided")));
      const again = yield* (yield* Cards)
        .provideSecret({ entryId: card.id, answer: value })
        .pipe(Effect.exit);
      assert.deepStrictEqual(
        Exit.findErrorOption(again).pipe(
          Option.map((error) => (error._tag === "Conflict" ? error.reason : error._tag)),
        ),
        Option.some("card-closed"),
      );
      assert.strictEqual((yield* control.secretAnswers(session)).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("takes a value again after a restart when the submission never landed", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, session, card } = yield* submittedThenStopped.pipe(Effect.provide(Domain.layer));

    yield* Effect.gen(function* () {
      yield* (yield* Cards).provideSecret({ entryId: card.id, answer: value });
      yield* until(secretStatus(bot.id).pipe(Effect.map((status) => status === "provided")));
      assert.strictEqual((yield* control.secretAnswers(session)).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("lets one submission at a time reach a card, when the first one's reply is lost", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Publish the package.");
    const turnId = yield* nextTurn(bot.id);
    yield* control.openRequest({
      sessionId: session,
      turnId,
      request: {
        _tag: "secret",
        label: "npm token",
        reason: "To publish.",
        url: null,
        placeholder: null,
      },
    });
    const card = yield* awaitEntry(bot.id, "secret-request");

    const sending = yield* control.holdNext("respondSecret");
    const first = yield* Effect.forkChild(
      cards.provideSecret({ entryId: card.id, answer: value }).pipe(Effect.exit),
    );
    yield* sending.entered;
    const second = yield* Effect.forkChild(
      cards.provideSecret({ entryId: card.id, answer: value }).pipe(Effect.exit),
    );
    yield* control.loseNextReply;
    yield* sending.release;

    const reasonOf = (exit: Exit.Exit<void, Conflict | Invalid | NotFound>) =>
      Exit.findErrorOption(exit).pipe(
        Option.map((error) => (error._tag === "Conflict" ? error.reason : error._tag)),
      );
    // The first went through and its answer was lost; the second waited for
    // it, learned the card closed, and sent nothing.
    assert.deepStrictEqual(reasonOf(yield* Fiber.join(first)), Option.some("engine-unavailable"));
    assert.deepStrictEqual(reasonOf(yield* Fiber.join(second)), Option.some("card-closed"));
    assert.strictEqual((yield* control.secretAnswers(session)).length, 1);
    yield* until(secretStatus(bot.id).pipe(Effect.map((status) => status === "provided")));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends an answer when the answer before it hits a defect", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Clean up.");
    const turnId = yield* nextTurn(bot.id);
    const approval = (action: string) =>
      control.openRequest({
        sessionId: session,
        turnId,
        request: {
          _tag: "approval",
          kind: "command",
          action,
          detail: null,
          reason: null,
          exact: true,
          sessionGrant: null,
        },
      });
    yield* approval("rm -rf build");
    const second = yield* approval("rm -rf dist");
    const [first, next] = yield* eventuallyTwoCards(bot.id);

    // Both answers are recorded while the engine is away; the first is one
    // its card cannot take, as a bug in the server would write.
    yield* control.setReachable(false);
    for (const card of [first, next]) {
      yield* cards.answer({
        commandId: command(),
        entryId: card,
        answer: { _tag: "approval", decision: "allow-once" },
      });
    }
    yield* sql`
      UPDATE engine_requests SET response_json = '{"_tag":"question","answers":{}}'
      WHERE entry_id = ${first}
    `;
    yield* control.setReachable(true);

    yield* cards.respondPending;
    const responses = yield* control.responses(session);
    assert.deepStrictEqual(
      responses.map((response) => response.requestId),
      [second],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("takes a choice or a typed answer to an engine question, never both", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const turnId = yield* nextTurn(bot.id);
    const requestId = yield* control.openRequest({
      sessionId: session,
      turnId,
      request: {
        _tag: "question",
        questions: [
          {
            id: "region",
            prompt: "Which region?",
            options: [{ id: "eu", label: "Europe", description: null, style: "default" }],
            acceptsText: true,
            multiple: false,
          },
        ],
      },
    });
    const card = yield* awaitEntry(bot.id, "question");
    const answerWith = (optionIds: ReadonlyArray<string>, text: string | null) =>
      cards.answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "question", answers: { region: { optionIds, text } } },
      });

    // The engine would get the note alone, so the choice beside it is refused.
    const both = yield* Effect.flip(answerWith(["eu"], "Frankfurt, if you can."));
    assert.strictEqual(both._tag, "Invalid");

    yield* answerWith([], "Frankfurt");
    yield* cards.respondPending;
    assert.deepStrictEqual(yield* control.responses(session), [
      {
        requestId,
        response: { _tag: "question", answers: { region: { optionIds: [], text: "Frankfurt" } } },
      },
    ]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a dismissal of an engine question, sending nothing, and takes its answer", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const turnId = yield* nextTurn(bot.id);
    const requestId = yield* control.openRequest({
      sessionId: session,
      turnId,
      request: {
        _tag: "question",
        questions: [
          {
            id: "question-1",
            prompt: "Which region?",
            options: [
              { id: "option-1", label: "Europe", description: null, style: "default" },
              { id: "option-2", label: "Asia", description: null, style: "default" },
            ],
            acceptsText: false,
            multiple: false,
          },
        ],
      },
    });
    const card = yield* awaitEntry(bot.id, "question");

    // The engine takes no dismissal of a question its turn waits on.
    const dismissed = yield* Effect.flip(
      cards.answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } }),
    );
    assert.deepStrictEqual(dismissed, new Invalid({ reason: "not-dismissible" }));
    yield* cards.respondPending;
    assert.deepStrictEqual(yield* control.rejectedAnswers(session), []);
    assert.deepStrictEqual(yield* control.responses(session), []);
    assert.strictEqual((yield* awaitEntry(bot.id, "question")).status._tag, "pending");

    const answers = { "question-1": { optionIds: ["option-2"], text: null } };
    yield* cards.answer({
      commandId: command(),
      entryId: card.id,
      answer: { _tag: "question", answers },
    });
    yield* cards.respondPending;
    assert.deepStrictEqual(yield* control.responses(session), [
      { requestId, response: { _tag: "question", answers } },
    ]);
    yield* until(
      awaitEntry(bot.id, "question").pipe(Effect.map((found) => found.status._tag === "answered")),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("closes a card whose answer the engine refused, never sends it again, and stops", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Clean up.");
    const turnId = yield* nextTurn(bot.id);
    const requestId = yield* control.openRequest({
      sessionId: session,
      turnId,
      request: {
        _tag: "approval",
        kind: "command",
        action: "rm -rf build",
        detail: null,
        reason: null,
        exact: true,
        sessionGrant: null,
      },
    });
    const card = yield* awaitEntry(bot.id, "approval");

    const allow = (decision: "allow-once" | "deny") =>
      cards.answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "approval", decision },
      });
    yield* control.rejectNextAnswer;
    yield* allow("allow-once");
    yield* cards.respondPending;
    // The card says the bot could not take it, and takes no other answer.
    assert.deepStrictEqual((yield* awaitEntry(bot.id, "approval")).status, { _tag: "refused" });
    const again = yield* Effect.flip(allow("deny"));
    assert.strictEqual(again._tag === "Conflict" ? again.reason : again._tag, "card-closed");
    // Past the longest backoff of an answer whose reply was lost.
    yield* TestClock.adjust(Duration.minutes(11));
    yield* cards.respondPending;
    assert.deepStrictEqual(yield* control.rejectedAnswers(session), [requestId]);
    assert.deepStrictEqual(yield* control.responses(session), []);

    // The turn still waits on the request, until a Stop ends it.
    yield* (yield* Stops).stopBot({ commandId: command(), botId: bot.id });
    yield* stopSettled;
    yield* turnEnded(bot.id);
    assert.deepStrictEqual((yield* awaitEntry(bot.id, "approval")).status, { _tag: "refused" });
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The bot's two approval cards, oldest first, once both are shown. */
const eventuallyTwoCards = (botId: BotId) =>
  until(
    conversation(botId).pipe(
      Effect.map((entries) => entries.filter((entry) => entry._tag === "approval").length === 2),
    ),
  ).pipe(
    Effect.andThen(conversation(botId)),
    Effect.map((entries) => {
      const [first, next] = entries.filter((entry) => entry._tag === "approval");
      if (first === undefined || next === undefined) throw new Error("two approval cards");
      return [first.id, next.id] as const;
    }),
  );

it.effect("shows an open card as the engine updates it, and takes the grant it then offers", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Clean up.");
    const turnId = yield* nextTurn(bot.id);
    const requestId = yield* control.openRequest({
      sessionId: session,
      turnId,
      request: {
        _tag: "approval",
        kind: "command",
        action: "Remove the build output",
        detail: null,
        reason: null,
        exact: false,
        sessionGrant: null,
      },
    });
    const summary = yield* awaitEntry(bot.id, "approval");
    const allowForSession = {
      commandId: command(),
      entryId: summary.id,
      answer: { _tag: "approval", decision: "allow-session" },
    } as const;
    // A summary offers no grant for the session.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(cards.answer(allowForSession))));

    yield* control.updateRequest({
      sessionId: session,
      requestId,
      request: {
        _tag: "approval",
        kind: "command",
        action: "rm -rf build",
        detail: null,
        reason: "Remove the build output",
        exact: true,
        sessionGrant: { covers: "every-command" },
      },
    });
    yield* until(awaitEntry(bot.id, "approval").pipe(Effect.map((card) => card.exact)));
    const exact = yield* awaitEntry(bot.id, "approval");
    assert.strictEqual(exact.id, summary.id);
    assert.strictEqual(exact.action, "rm -rf build");
    assert.deepStrictEqual(exact.status, { _tag: "pending" });

    yield* cards.answer({ ...allowForSession, commandId: command() });
    yield* cards.respondPending;
    assert.deepStrictEqual(
      (yield* control.responses(session)).map((sent) => sent.requestId),
      [requestId],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses an answer too long to reach the bot, and leaves the card open for another", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cards = yield* Cards;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy the service.");
    const card = yield* askRegion(bot.id, session, yield* nextTurn(bot.id), true);
    const typed = (text: string) =>
      cards.answer({
        commandId: command(),
        entryId: card.id,
        answer: {
          _tag: "question",
          answers: { [card.questions[0].id]: { optionIds: [], text } },
        },
      });

    // Within the length of a typed answer, but each `<message>` is defused in
    // the envelope, past the engine's input limit.
    const refused = yield* Effect.flip(typed("<message>".repeat(10_000)));
    assert.deepStrictEqual(refused, new Invalid({ reason: "answer-length" }));
    assert.strictEqual((yield* awaitEntry(bot.id, "question")).status._tag, "pending");
    const wakes = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM wakes WHERE json_extract(payload_json, '$._tag') = 'answer'
    `;
    assert.strictEqual(wakes[0]?.n, 0);

    yield* typed("Europe, but eu-central-1.");
    assert.strictEqual((yield* awaitEntry(bot.id, "question")).status._tag, "answered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** A running turn with a step, so its work fold shows from the start, and an approval it holds on after a minute. */
const holdsOnApprovalAfterAMinute = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Clean up.");
  const turnId = yield* nextTurn(bot.id);
  const startedAt = yield* DateTime.now;
  yield* control.step({
    sessionId: session,
    turnId,
    step: {
      id: WorkStepId.make("step-1"),
      kind: "command",
      tool: null,
      label: "ls build",
      status: "completed",
      startedAt,
      finishedAt: startedAt,
    },
  });
  yield* awaitEntry(bot.id, "work-fold");
  yield* TestClock.adjust(Duration.minutes(1));
  yield* control.openRequest({
    sessionId: session,
    turnId,
    request: {
      _tag: "approval",
      kind: "command",
      action: "rm -rf build",
      detail: null,
      reason: null,
      exact: true,
      sessionGrant: null,
    },
  });
  const card = yield* awaitEntry(bot.id, "approval");
  const answer = (decision: "allow-once" | "deny") =>
    Effect.gen(function* () {
      const cards = yield* Cards;
      yield* cards.answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "approval", decision },
      });
      yield* cards.respondPending;
    });
  return { control, bot, session, turnId, card, answer };
});

/** How long the turn's fold says it worked, once it ended. */
const workedMs = (botId: BotId) =>
  Effect.gen(function* () {
    yield* until(
      awaitEntry(botId, "work-fold").pipe(Effect.map((fold) => fold.status._tag === "finished")),
    );
    const fold = yield* awaitEntry(botId, "work-fold");
    if (fold.status._tag !== "finished") return yield* Effect.die(new Error("The fold runs"));
    const spanMs =
      DateTime.toEpochMillis(fold.status.finishedAt) - DateTime.toEpochMillis(fold.createdAt);
    return spanMs - fold.status.waitedMs;
  });

it.effect("leaves out of a turn's work the time it waited on a card, and only that time", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { control, bot, session, turnId, card, answer } = yield* holdsOnApprovalAfterAMinute;
    yield* TestClock.adjust(Duration.minutes(2));
    yield* answer("allow-once");
    yield* until(
      sql<{ readonly closed_at: string | null }>`
        SELECT closed_at FROM engine_requests WHERE entry_id = ${card.id}
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length === 1 && rows[0]?.closed_at !== null),
      ),
    );
    yield* TestClock.adjust(Duration.minutes(3));
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });

    // A minute before the card, three after it was answered.
    assert.strictEqual(yield* workedMs(bot.id), Duration.toMillis(Duration.minutes(4)));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("counts the time after a refused answer as waiting, until the turn ends", () =>
  Effect.gen(function* () {
    const { control, bot, session, turnId, answer } = yield* holdsOnApprovalAfterAMinute;
    yield* TestClock.adjust(Duration.minutes(2));
    yield* control.rejectNextAnswer;
    yield* answer("allow-once");
    yield* until(
      awaitEntry(bot.id, "approval").pipe(Effect.map((found) => found.status._tag === "refused")),
    );
    yield* TestClock.adjust(Duration.minutes(5));
    yield* control.finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "interrupted" },
    });

    // Only the minute before the card was work.
    assert.strictEqual(yield* workedMs(bot.id), Duration.toMillis(Duration.minutes(1)));
  }).pipe(Effect.provide(TestDomain.layer)),
);
