// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  type HandoffState,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { NO_TURN_REFUSAL } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { Attachments } from "../attachments/Attachments.ts";
import { Bots } from "../bots/Bots.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Layout } from "../Layout.ts";
import { Rooms } from "../rooms/Rooms.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  admittedTurn,
  awaitEntry,
  chainLimits,
  command,
  concurrentTurns,
  conversation,
  createBot,
  deliveryIs,
  engineSession,
  flushed,
  holdGate,
  messageTeammate,
  nextTurn,
  noticesOf,
  received,
  recoverTimes,
  roomOf,
  sendInRoom,
  sendToBot,
  sessionAfter,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import type { ToolCallResponse } from "../tools/protocol.ts";
import { BotStates } from "./BotStates.ts";
import { Cards } from "./Cards.ts";
import { MAX_INDETERMINATE_ANSWERS } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { Stops } from "./Stops.ts";

/** What the bot said in its conversation, oldest first. */
const botSaid = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) =>
        entry._tag === "message" && entry.author._tag === "bot" ? [entry.text] : [],
      ),
    ),
  );

/** The bot is working on a message from the operator. */
const working = (text: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, text);
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, message, turnId };
  });

it.effect(
  "records a say the engine records late, and lets a done say end delivery without ending the run",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const tools = yield* BotTools;
      const { bot, session, message, turnId } = yield* working("Write the summary.");
      const args = { text: "The summary is in files/summary.md.", done: true };

      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "say",
        input: args,
        recorded: "after-next-synchronize",
      });
      const reply = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.deepStrictEqual(reply, { _tag: "result", value: { status: "recorded" } });

      // A forward repeated by the bridge returns the first result; another request for the one call is refused.
      const repeated = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.deepStrictEqual(repeated, reply);
      const duplicate = yield* tools.call({
        requestId: "call-2",
        sessionId: session,
        tool: "say",
        arguments: args,
      });
      assert.strictEqual(duplicate._tag, "refused");

      assert.deepStrictEqual(yield* botSaid(bot.id), ["The summary is in files/summary.md."]);
      yield* deliveryIs(message, "delivered");
      assert.isTrue(Option.isSome(yield* admittedTurn(bot.id)));

      yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
      yield* turnEnded(bot.id);
      yield* flushed(bot.id);
      // It delivered: no follow-up asks the bot to say something.
      assert.strictEqual((yield* received(session)).length, 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

// An ACP agent can report a call before its arguments: the engine records
// it with `{}`, then again with the arguments the bridge receives.
it.effect("matches a call the engine recorded again with its arguments", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const { bot, session, message, turnId } = yield* working("Check the build.");
    const args = { text: "The build is green.", done: true };

    const callId = yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: {},
      recorded: "now",
    });
    yield* control.recordToolInput({ sessionId: session, turnId, callId, input: args });
    const reply = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    assert.deepStrictEqual(reply, { _tag: "result", value: { status: "recorded" } });
    assert.deepStrictEqual(yield* botSaid(bot.id), ["The build is green."]);
    yield* deliveryIs(message, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers a forward that overlapped the one that committed with its stored result", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const { bot, session, turnId } = yield* working("Write the summary.");
    const args = { text: "The summary is in files/summary.md." };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    const forward = tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });

    // The retry finds no stored result and waits for the session's events
    // while the first forward is matched, admitted and committed.
    const held = yield* control.holdNext("synchronize");
    const retry = yield* Effect.forkChild(forward);
    yield* held.entered;
    const first = yield* forward;
    yield* held.release;

    assert.deepStrictEqual(yield* Fiber.join(retry), first);
    assert.deepStrictEqual(first, { _tag: "result", value: { status: "recorded" } });
    assert.deepStrictEqual(yield* botSaid(bot.id), ["The summary is in files/summary.md."]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("answers an overlapping forward with its stored result after the session vanished", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const { bot, session, turnId } = yield* working("Write the summary.");
    const args = { text: "The summary is in files/summary.md." };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    const forward = tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });

    // The retry waits for the session's events while the first forward
    // commits, and the session is archived before it hears back.
    const held = yield* control.holdNext("synchronize");
    const retry = yield* Effect.forkChild(forward);
    yield* held.entered;
    const first = yield* forward;
    yield* control.archiveSession(session);
    yield* held.release;

    assert.deepStrictEqual(first, { _tag: "result", value: { status: "recorded" } });
    assert.deepStrictEqual(yield* Fiber.join(retry), first);
    assert.deepStrictEqual(yield* botSaid(bot.id), ["The summary is in files/summary.md."]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("gives a request id another session used none of that session's result", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const ana = yield* working("Write the summary.");
    const said = { text: "The summary is in files/summary.md." };
    yield* control.toolCall({
      sessionId: ana.session,
      turnId: ana.turnId,
      tool: "say",
      input: said,
      recorded: "now",
    });
    const first = yield* tools.call({
      requestId: "call-1",
      sessionId: ana.session,
      tool: "say",
      arguments: said,
    });
    assert.strictEqual(first._tag, "result");

    const bia = yield* createBot("Bia");
    const theirs = yield* engineSession(bia.id);
    yield* sendToBot(bia.id, "Check the build.");
    const turnId = yield* nextTurn(bia.id);
    yield* control.toolCall({
      sessionId: theirs,
      turnId,
      tool: "say",
      input: said,
      recorded: "now",
    });
    const reused = yield* tools.call({
      requestId: "call-1",
      sessionId: theirs,
      tool: "say",
      arguments: said,
    });

    assert.strictEqual(reused._tag, "refused");
    assert.deepStrictEqual(yield* botSaid(bia.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a call of a turn that ended, even one the next turn could match", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const { bot, session, turnId } = yield* working("Check the build.");
    const args = { text: "The build is green." };

    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    // The turn delivered nothing, so J3 Bots follows it up with a turn of its own.
    yield* nextTurn(bot.id, turnId);

    const late = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    assert.deepStrictEqual(late, { _tag: "refused", message: NO_TURN_REFUSAL });
    assert.deepStrictEqual(yield* botSaid(bot.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("closes delivery with an ask card, whose answer wakes the bot", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const cards = yield* Cards;
    const states = yield* BotStates;
    const { bot, session, turnId } = yield* working("Deploy it.");
    const args = {
      prompt: "Which region?",
      options: [{ label: "Europe", value: "eu-west-1" }, { label: "United States" }],
    };

    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    const reply = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "ask",
      arguments: args,
    });
    assert.strictEqual(reply._tag, "result");
    const card = yield* awaitEntry(bot.id, "question");
    assert.strictEqual(card.origin, "ask");
    assert.deepStrictEqual(card.status, { _tag: "pending" });

    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    // The card delivered the turn: the bot waits on it, with no follow-up.
    assert.strictEqual((yield* received(session)).length, 1);
    assert.deepStrictEqual(yield* states.of(bot.id), { _tag: "waiting", entryId: card.id });

    const question = card.questions[0].id;
    yield* cards.answer({
      commandId: command(),
      entryId: card.id,
      answer: {
        _tag: "question",
        answers: { [question]: { optionIds: ["option-1"], text: null } },
      },
    });
    yield* nextTurn(bot.id, turnId);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 1);
    yield* until(
      awaitEntry(bot.id, "question").pipe(Effect.map((found) => found.status._tag === "answered")),
    );

    const again = yield* cards
      .answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } })
      .pipe(Effect.exit);
    assert.deepStrictEqual(
      Exit.findErrorOption(again).pipe(Option.map((error) => error._tag)),
      Option.some("Conflict"),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses a say to the operator from a turn whose room was archived, storing none of its files",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const tools = yield* BotTools;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const room = yield* roomOf(bot.id);
      yield* sendInRoom(bot.id, room.id, "Plan the launch.");
      const turnId = yield* nextTurn(bot.id);

      const workspace = Option.getOrThrow(yield* (yield* BotStore).find(bot.id)).workspacePath;
      yield* fs.makeDirectory(path.join(workspace, "files"), { recursive: true });
      yield* fs.writeFileString(path.join(workspace, "files", "plan.md"), "The plan.");
      const args = { text: "Here is the plan.", to: "dm", attachments: ["files/plan.md"] };
      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "say",
        input: args,
        recorded: "now",
      });

      // The room is archived while its turn is still being stopped.
      yield* control.delayNextStopEffects;
      yield* (yield* Rooms).update({
        commandId: command(),
        roomId: room.id,
        changes: { archived: true },
      });
      const reply = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });

      assert.strictEqual(reply._tag, "refused");
      assert.deepStrictEqual(yield* botSaid(bot.id), []);
      const stored = yield* (yield* Attachments).botFiles({
        botId: bot.id,
        before: null,
        limit: 10,
      });
      assert.deepStrictEqual(stored.files, []);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "reads what a say attaches from the workspace it was provisioned with, not a link put in its place",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const tools = yield* BotTools;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { bot, session, turnId } = yield* working("Send me the notes.");

      // The bot moves its folder away and puts a link to another one in its place.
      const workspace = Option.getOrThrow(yield* (yield* BotStore).find(bot.id)).workspacePath;
      const elsewhere = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(elsewhere, "files"));
      yield* fs.writeFileString(path.join(elsewhere, "files", "notes.md"), "Not in the workspace.");
      yield* fs.rename(workspace, `${workspace}-moved`);
      yield* fs.symlink(elsewhere, workspace);

      const args = { text: "Here are the notes.", attachments: ["files/notes.md"] };
      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "say",
        input: args,
        recorded: "now",
      });
      const reply = yield* tools.call({
        requestId: "call-1",
        sessionId: session,
        tool: "say",
        arguments: args,
      });

      assert.strictEqual(reply._tag, "refused");
      assert.deepStrictEqual(yield* botSaid(bot.id), []);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/** The bot's turn calls `say` with these files, written in its workspace first. */
const sayWithFiles = (
  files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { bot, session, turnId } = yield* working("Send me the files.");
    const workspace = Option.getOrThrow(yield* (yield* BotStore).find(bot.id)).workspacePath;
    yield* fs.makeDirectory(path.join(workspace, "files"), { recursive: true });
    for (const file of files)
      yield* fs.writeFile(path.join(workspace, "files", file.name), file.bytes);
    const args = {
      text: "Here they are.",
      attachments: files.map((file) => `files/${file.name}`),
    };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    const reply = yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    return { bot, reply };
  });

/** Every blob file in the attachment store. */
const storedBlobs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { attachments } = yield* Layout;
  if (!(yield* fs.exists(attachments))) return [];
  const entries = yield* fs.readDirectory(attachments, { recursive: true });
  const files: Array<string> = [];
  for (const entry of entries) {
    const info = yield* fs.stat(path.join(attachments, entry));
    if (info.type === "File") files.push(entry);
  }
  return files;
});

it.effect("checks every file a say attaches before it stores any", () =>
  Effect.gen(function* () {
    const { bot, reply } = yield* sayWithFiles([
      { name: "notes.md", bytes: new TextEncoder().encode("Notes.") },
      {
        name: `${"n".repeat(MAX_ATTACHMENT_NAME_LENGTH)}.md`,
        bytes: new TextEncoder().encode("Long."),
      },
    ]);

    assert.include(reply._tag === "refused" ? reply.message : "", "its name cannot be used");
    assert.deepStrictEqual(yield* botSaid(bot.id), []);
    assert.deepStrictEqual(yield* storedBlobs, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a say whose files together pass the limit", () =>
  Effect.gen(function* () {
    // Each within one upload's limit; together past what one say takes.
    const half = MAX_ATTACHMENT_SIZE / 2 + 1;
    const { bot, reply } = yield* sayWithFiles([
      { name: "first.bin", bytes: new Uint8Array(half).fill(1) },
      { name: "second.bin", bytes: new Uint8Array(half).fill(2) },
    ]);

    assert.include(reply._tag === "refused" ? reply.message : "", "the files together");
    assert.deepStrictEqual(yield* botSaid(bot.id), []);
    assert.deepStrictEqual(yield* storedBlobs, []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The teammate messages the bot's conversation shows, oldest first. */
const handoffs = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) =>
        entry._tag === "handoff" ? [`${entry.direction}: ${entry.text}`] : [],
      ),
    ),
  );

/** How many teammate wakes and held teammate messages the bot has, cancelled ones left out. */
const teammateMessagesFor = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly wakes: number; readonly held: number }>`
      SELECT
        (
          SELECT COUNT(*) FROM wakes
          WHERE bot_id = ${botId} AND kind = 'bot' AND status <> 'cancelled'
        ) AS wakes,
        (SELECT COUNT(*) FROM held_messages WHERE recipient_bot_id = ${botId}) AS held
    `.pipe(Effect.orDie);
    return { wakes: row?.wakes ?? 0, held: row?.held ?? 0 };
  });

/** Where each teammate message the bot's conversation shows stands, oldest first. */
const handoffStates = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) => (entry._tag === "handoff" ? [entry.state] : [])),
    ),
  );

/** Waits until the teammate messages the bot's conversation shows stand as `states`. */
const statesBecome = (botId: BotId, states: ReadonlyArray<HandoffState>) =>
  until(handoffStates(botId).pipe(Effect.map((shown) => shown.join() === states.join())));

/** Whether an operator's Retry of a teammate message failed. */
const retryFailed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT 1 FROM wakes WHERE kind = 'bot' AND retry_of IS NOT NULL AND status = 'failed'
  `.pipe(Effect.orDie);
  return rows.length > 0;
});

/**
 * The teammate `sender`, in a turn the operator started, sends the bot an
 * urgent message. That turn goes on running unless `finish`.
 */
const wokenBy = (sender: BotId, botId: BotId, text: string, finish = false) =>
  Effect.gen(function* () {
    const session = yield* engineSession(sender);
    yield* sendToBot(sender, "Pass it on.");
    const turnId = yield* nextTurn(sender);
    yield* messageTeammate(session, turnId, { to: botId, text, urgent: true });
    if (finish) yield* finished(sender, session, turnId);
    return { session, turnId };
  });

/** The bot's running turn ends, and the server saw it end. */
const finished = (botId: BotId, sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).finishTurn({
      sessionId,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(botId);
  });

/** What a refused call tells the bot; empty for a call that was not refused. */
const refusal = (reply: ToolCallResponse) => (reply._tag === "refused" ? reply.message : "");

it.effect("wakes a teammate once with an urgent message, shown in both conversations", () =>
  Effect.gen(function* () {
    const tools = yield* BotTools;
    const { bot: ana, session, turnId } = yield* working("Ask Bo for the launch date.");
    const bo = yield* createBot("Bo");
    const boSession = yield* engineSession(bo.id);
    const args = { to: bo.id, text: "When is the launch?", urgent: true };

    yield* (yield* TestEngineControl).toolCall({
      sessionId: session,
      turnId,
      tool: "message_bot",
      input: args,
      recorded: "now",
    });
    const forward = {
      requestId: "call-1",
      sessionId: session,
      tool: "message_bot",
      arguments: args,
    };
    const reply = yield* tools.call(forward);
    assert.deepStrictEqual(reply, {
      _tag: "result",
      value: { status: "sent", note: "It wakes them now." },
    });
    // The bridge forwarding the request again gets the same answer, and nothing more is sent.
    assert.deepStrictEqual(yield* tools.call(forward), reply);

    yield* nextTurn(bo.id);
    yield* flushed(bo.id);
    const sent = yield* received(boSession);
    assert.deepStrictEqual(
      sent.map(({ text }) => [text.includes('kind="bot"'), text.includes("When is the launch?")]),
      [[true, true]],
    );
    assert.deepStrictEqual(yield* handoffs(ana.id), ["sent: When is the launch?"]);
    assert.deepStrictEqual(yield* handoffs(bo.id), ["received: When is the launch?"]);
    assert.deepStrictEqual(yield* teammateMessagesFor(bo.id), { wakes: 1, held: 0 });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a message to itself, to an unknown id and to a deleted teammate", () =>
  Effect.gen(function* () {
    const { bot: ana, session, turnId } = yield* working("Ask the others.");
    const bo = yield* createBot("Bo");
    yield* (yield* Bots).remove({ commandId: command(), botId: bo.id, deleteFiles: true });

    for (const to of [ana.id, "nobody", bo.id]) {
      const reply = yield* messageTeammate(session, turnId, { to, text: "Hello?", urgent: true });
      assert.include(refusal(reply), "Nothing was sent");
    }
    assert.deepStrictEqual(yield* handoffs(ana.id), []);
    assert.deepStrictEqual(yield* teammateMessagesFor(bo.id), { wakes: 0, held: 0 });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends nothing for work the operator stopped", () =>
  Effect.gen(function* () {
    const { bot: ana, session, turnId } = yield* working("Ask Bo to deploy.");
    const bo = yield* createBot("Bo");
    // The Stop is recorded; its round has not reached the engine yet.
    const gate = yield* holdGate(ana.id);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });

    const reply = yield* messageTeammate(session, turnId, {
      to: bo.id,
      text: "Deploy now.",
      urgent: true,
    });
    assert.include(refusal(reply), "Your user stopped this work");
    yield* gate.release;
    assert.deepStrictEqual(yield* handoffs(bo.id), []);
    assert.deepStrictEqual(yield* teammateMessagesFor(bo.id), { wakes: 0, held: 0 });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("counts only the teammates a turn brings in without the operator toward fan-out", () =>
  Effect.gen(function* () {
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bo = yield* createBot("Bo");
    const cy = yield* createBot("Cy");
    const dee = yield* createBot("Dee");
    // A turn the operator started may tell anyone.
    const { session, turnId } = yield* wokenBy(bo.id, ana.id, "Can you check staging?");
    const told = yield* messageTeammate(session, turnId, {
      to: cy.id,
      text: "Ana is checking staging.",
      urgent: false,
    });
    assert.strictEqual(told._tag, "result");

    // Ana's turn answers Bo, which counts for nothing, and brings in one more.
    const anaTurn = yield* nextTurn(ana.id);
    for (const [to, text] of [
      [bo.id, "Staging is fine."],
      [cy.id, "Staging is fine, Cy."],
    ] as const) {
      const reply = yield* messageTeammate(anaSession, anaTurn, { to, text, urgent: false });
      assert.strictEqual(reply._tag, "result");
    }
    const refused = yield* messageTeammate(anaSession, anaTurn, {
      to: dee.id,
      text: "Staging is fine, Dee.",
      urgent: false,
    });
    assert.include(refusal(refused), "at most 1 teammate besides those whose messages it answers");

    assert.deepStrictEqual(yield* handoffs(dee.id), []);
    assert.deepStrictEqual(yield* teammateMessagesFor(dee.id), { wakes: 0, held: 0 });
    assert.deepStrictEqual(yield* teammateMessagesFor(cy.id), { wakes: 0, held: 2 });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("counts the hops of a held message the turn delivers", () =>
  Effect.gen(function* () {
    yield* chainLimits({ hops: 2, fanOut: 1 });
    yield* concurrentTurns(4);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bo = yield* createBot("Bo");
    const cy = yield* createBot("Cy");
    const cySession = yield* engineSession(cy.id);
    const dee = yield* createBot("Dee");
    // Bo, in the operator's turn, wakes Cy (hop 1), whose turn leaves Ana a held message (hop 2).
    yield* wokenBy(bo.id, cy.id, "Tell Ana the venue moved.", true);
    const cyTurn = yield* nextTurn(cy.id);
    yield* messageTeammate(cySession, cyTurn, {
      to: ana.id,
      text: "The venue moved.",
      urgent: false,
    });
    yield* finished(cy.id, cySession, cyTurn);
    // Dee, in the operator's turn, wakes Ana (hop 1); that turn also carries the held message.
    yield* wokenBy(dee.id, ana.id, "Which venue?");
    const anaTurn = yield* nextTurn(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "The venue moved."), 1);

    const reply = yield* messageTeammate(anaSession, anaTurn, {
      to: dee.id,
      text: "The new one.",
      urgent: false,
    });
    assert.include(refusal(reply), "reached your user's limit of 2");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts the chain again once the engine took the operator's steer", () =>
  Effect.gen(function* () {
    yield* chainLimits({ hops: 1, fanOut: 1 });
    const ana = yield* createBot("Ana");
    const bo = yield* createBot("Bo");
    const boSession = yield* engineSession(bo.id);
    yield* wokenBy(ana.id, bo.id, "The date?");
    const boTurn = yield* nextTurn(bo.id);
    const refused = yield* messageTeammate(boSession, boTurn, {
      to: ana.id,
      text: "Friday.",
      urgent: false,
    });
    assert.include(refusal(refused), "reached your user's limit of 1");

    // The operator steers Bo's running turn.
    yield* sendToBot(bo.id, "Tell Ana it is Friday.");
    yield* flushed(bo.id);
    const reply = yield* messageTeammate(boSession, boTurn, {
      to: ana.id,
      text: "It is Friday.",
      urgent: false,
    });
    assert.strictEqual(reply._tag, "result");
    assert.deepStrictEqual(yield* teammateMessagesFor(ana.id), { wakes: 0, held: 1 });
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("cancels what a stopped bot's work sent a teammate that has not reached them", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot: ana, session, turnId } = yield* working("Ask Bo to deploy.");
    const bo = yield* createBot("Bo");
    const boSession = yield* engineSession(bo.id);
    // Bo is busy, so the urgent message waits for its turn to end.
    yield* sendToBot(bo.id, "Check the logs.");
    const boTurn = yield* nextTurn(bo.id);
    yield* messageTeammate(session, turnId, { to: bo.id, text: "Deploy now.", urgent: true });
    yield* messageTeammate(session, turnId, {
      to: bo.id,
      text: "Staging is down.",
      urgent: false,
    });

    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
    assert.deepStrictEqual(yield* teammateMessagesFor(bo.id), { wakes: 0, held: 0 });
    assert.deepStrictEqual(yield* handoffStates(ana.id), ["stopped", "stopped"]);
    assert.deepStrictEqual(yield* handoffStates(bo.id), ["stopped", "stopped"]);

    // Bo's next turn carries neither.
    yield* control.finishTurn({
      sessionId: boSession,
      turnId: boTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bo.id);
    yield* sendToBot(bo.id, "Anything else?");
    yield* nextTurn(bo.id, boTurn);
    for (const text of ["Deploy now.", "Staging is down."]) {
      assert.strictEqual(yield* timesSent(boSession, text), 0);
    }
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends nothing from a turn the engine started once a Stop is recorded during it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const ana = yield* createBot("Ana");
    const session = yield* engineSession(ana.id);
    const bo = yield* createBot("Bo");
    const turnId = yield* control.startEngineTurn(session);
    yield* nextTurn(ana.id);
    const sent = yield* messageTeammate(session, turnId, {
      to: bo.id,
      text: "The build passed.",
      urgent: false,
    });
    assert.strictEqual(sent._tag, "result");

    // The Stop is recorded; its round has not reached the engine yet.
    const gate = yield* holdGate(ana.id);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
    const reply = yield* messageTeammate(session, turnId, {
      to: bo.id,
      text: "Deploy it.",
      urgent: true,
    });
    assert.include(refusal(reply), "Your user stopped this work");
    yield* gate.release;
    assert.deepStrictEqual(yield* handoffs(bo.id), ["received: The build passed."]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows an urgent message that never reached the teammate, and sends it again on retry",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
      const bo = yield* createBot("Bo");
      const boSession = yield* engineSession(bo.id);
      // The engine refuses the envelope that carries it.
      yield* control.rejectNextDispatch;
      const reply = yield* messageTeammate(session, turnId, {
        to: bo.id,
        text: "The date?",
        urgent: true,
      });
      const notice = yield* awaitEntry(bo.id, "notice");
      assert.deepStrictEqual(notice.notice, { _tag: "handoff-failed", senders: [ana.id] });
      assert.isTrue(notice.retryable);
      assert.deepStrictEqual(yield* handoffStates(ana.id), ["not-delivered"]);
      assert.deepStrictEqual(yield* handoffStates(bo.id), ["not-delivered"]);
      // The bot's own call keeps the answer it had.
      assert.strictEqual(reply._tag, "result");

      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
      yield* nextTurn(bo.id);
      assert.strictEqual(yield* timesSent(boSession, "The date?"), 1);
      assert.deepStrictEqual(yield* handoffStates(ana.id), ["sent"]);
      assert.deepStrictEqual(yield* handoffStates(bo.id), ["sent"]);
      assert.isFalse((yield* awaitEntry(bo.id, "notice")).retryable);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps what a finished turn sent a teammate through a later Stop of the sender", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const ana = yield* createBot("Ana");
    const session = yield* engineSession(ana.id);
    const bo = yield* createBot("Bo");
    const boSession = yield* engineSession(bo.id);
    // Bo is busy, so the urgent messages wait for its turn to end.
    yield* sendToBot(bo.id, "Check the logs.");
    const boTurn = yield* nextTurn(bo.id);
    // A turn the operator started, then one the engine started on its own,
    // each sends Bo an urgent and a held message, and ends.
    yield* sendToBot(ana.id, "Tell Bo about the deploy.");
    const asked = yield* nextTurn(ana.id);
    yield* messageTeammate(session, asked, { to: bo.id, text: "Deploy now.", urgent: true });
    yield* messageTeammate(session, asked, { to: bo.id, text: "Staging is down.", urgent: false });
    yield* finished(ana.id, session, asked);
    const own = yield* control.startEngineTurn(session);
    yield* nextTurn(ana.id, asked);
    yield* messageTeammate(session, own, { to: bo.id, text: "The build passed.", urgent: true });
    yield* messageTeammate(session, own, { to: bo.id, text: "Tests are green.", urgent: false });
    yield* finished(ana.id, session, own);

    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
    assert.deepStrictEqual(yield* teammateMessagesFor(bo.id), { wakes: 2, held: 2 });

    // Bo's next turn carries all four.
    yield* finished(bo.id, boSession, boTurn);
    yield* nextTurn(bo.id, boTurn);
    for (const text of [
      "Deploy now.",
      "Staging is down.",
      "The build passed.",
      "Tests are green.",
    ]) {
      assert.strictEqual(yield* timesSent(boSession, text), 1);
    }
    assert.deepStrictEqual(yield* handoffStates(bo.id), ["sent", "sent", "sent", "sent"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a message again on the operator's retry after a Stop of its sender", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
    const bo = yield* createBot("Bo");
    const boSession = yield* engineSession(bo.id);
    yield* control.rejectNextDispatch;
    yield* messageTeammate(session, turnId, { to: bo.id, text: "The date?", urgent: true });
    const first = yield* awaitEntry(bo.id, "notice");
    // The operator stops Ana while the turn that sent it still runs.
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });

    // The retry fails too: it shows, and can be retried, again.
    yield* control.rejectNextDispatch;
    yield* pipeline.retryNotice({ commandId: command(), entryId: first.id });
    yield* until(noticesOf(bo.id).pipe(Effect.map((kinds) => kinds.length === 2)));
    const second = yield* awaitEntry(bo.id, "notice");
    assert.deepStrictEqual(second.notice, { _tag: "handoff-failed", senders: [ana.id] });
    assert.isTrue(second.retryable);
    assert.deepStrictEqual(yield* handoffStates(bo.id), ["not-delivered"]);

    yield* pipeline.retryNotice({ commandId: command(), entryId: second.id });
    yield* nextTurn(bo.id);
    assert.strictEqual(yield* timesSent(boSession, "The date?"), 1);
    yield* statesBecome(ana.id, ["sent"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("retries only the urgent messages that failed, never one a Stop cancelled", () =>
  Effect.gen(function* () {
    yield* concurrentTurns(4);
    const control = yield* TestEngineControl;
    const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
    const bo = yield* createBot("Bo");
    const boSession = yield* engineSession(bo.id);
    const cy = yield* createBot("Cy");
    // Bo is busy, so both messages wait and share its next envelope.
    yield* sendToBot(bo.id, "Check the logs.");
    const boTurn = yield* nextTurn(bo.id);
    yield* messageTeammate(session, turnId, { to: bo.id, text: "From Ana.", urgent: true });
    yield* wokenBy(cy.id, bo.id, "From Cy.");

    // The engine refuses that envelope, and Ana is stopped while it is on its way.
    yield* control.rejectNextDispatch;
    const held = yield* control.holdNextAnswer("dispatch");
    yield* finished(bo.id, boSession, boTurn);
    yield* held.entered;
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
    yield* held.release;
    const notice = yield* awaitEntry(bo.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "handoff-failed", senders: [cy.id] });
    yield* statesBecome(bo.id, ["stopped", "not-delivered"]);

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bo.id, boTurn);
    assert.strictEqual(yield* timesSent(boSession, "From Cy."), 1);
    assert.strictEqual(yield* timesSent(boSession, "From Ana."), 0);
    assert.deepStrictEqual(yield* handoffStates(bo.id), ["stopped", "sent"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows a stopped message as sent once the engine turns out to have taken it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
    const bo = yield* createBot("Bo");
    yield* engineSession(bo.id);
    // Whether the engine took Bo's envelope cannot be learned yet.
    const deferred = yield* control.deferNextDispatch;
    yield* messageTeammate(session, turnId, { to: bo.id, text: "The date?", urgent: true });
    yield* flushed(bo.id);
    // Ana is stopped while it is on its way, and the recovery gives up on it.
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* statesBecome(bo.id, ["stopped"]);

    yield* deferred.land;
    yield* nextTurn(bo.id);
    yield* statesBecome(bo.id, ["sent"]);
    assert.deepStrictEqual(yield* handoffStates(ana.id), ["sent"]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a message sent once its original lands late, whatever becomes of its Retry", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
    const bo = yield* createBot("Bo");
    yield* engineSession(bo.id);
    // Whether the engine took Bo's envelope cannot be learned, and the recovery gives up.
    const original = yield* control.deferNextDispatch;
    yield* messageTeammate(session, turnId, { to: bo.id, text: "The date?", urgent: true });
    yield* flushed(bo.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* statesBecome(bo.id, ["not-delivered"]);
    const notice = yield* awaitEntry(bo.id, "notice");

    // The operator retries it, and that envelope's fate cannot be learned either.
    yield* control.deferNextDispatch;
    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* flushed(bo.id);
    // The original lands: Bo read it. Then the Retry's recovery gives up.
    yield* original.land;
    yield* nextTurn(bo.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* until(retryFailed);

    assert.deepStrictEqual(yield* handoffStates(bo.id), ["sent"]);
    assert.deepStrictEqual(yield* handoffStates(ana.id), ["sent"]);
    assert.deepStrictEqual(yield* noticesOf(bo.id), ["handoff-failed"]);
    assert.isFalse((yield* awaitEntry(bo.id, "notice")).retryable);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a Stop's end of a message through the deletion of its sender", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
    const bo = yield* createBot("Bo");
    yield* engineSession(bo.id);
    // Whether the engine took Bo's envelope cannot be learned yet. Ana is
    // stopped, then deleted, and then the recovery gives up on it.
    yield* control.deferNextDispatch;
    yield* messageTeammate(session, turnId, { to: bo.id, text: "The date?", urgent: true });
    yield* flushed(bo.id);
    yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
    yield* (yield* Bots).remove({ commandId: command(), botId: ana.id, deleteFiles: true });
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);

    yield* statesBecome(bo.id, ["stopped"]);
    assert.deepStrictEqual(yield* noticesOf(bo.id), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "does not cancel an operator's Retry already on its way through a Stop of the sender",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
      const bo = yield* createBot("Bo");
      yield* engineSession(bo.id);
      yield* control.rejectNextDispatch;
      yield* messageTeammate(session, turnId, { to: bo.id, text: "The date?", urgent: true });
      const first = yield* awaitEntry(bo.id, "notice");

      // The Retry is refused too, and Ana is stopped while it is on its way.
      yield* control.rejectNextDispatch;
      const held = yield* control.holdNextAnswer("dispatch");
      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: first.id });
      yield* held.entered;
      yield* (yield* Stops).stopBot({ commandId: command(), botId: ana.id });
      yield* held.release;

      yield* until(noticesOf(bo.id).pipe(Effect.map((kinds) => kinds.length === 2)));
      assert.isTrue((yield* awaitEntry(bo.id, "notice")).retryable);
      assert.deepStrictEqual(yield* handoffStates(bo.id), ["not-delivered"]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

/**
 * Ana, in a turn the operator started, sends Bo an urgent and a held
 * message while Bo works on a message from the operator.
 */
const toldWhileBusy = Effect.gen(function* () {
  const { bot: ana, session, turnId } = yield* working("Tell Bo about the deploy.");
  const bo = yield* createBot("Bo");
  const boSession = yield* engineSession(bo.id);
  yield* sendToBot(bo.id, "Check the logs.");
  const boTurn = yield* nextTurn(bo.id);
  yield* messageTeammate(session, turnId, { to: bo.id, text: "Deploy now.", urgent: true });
  yield* messageTeammate(session, turnId, { to: bo.id, text: "Staging is down.", urgent: false });
  return { ana, bo, boSession, boTurn };
});

it.effect("keeps what teammates sent through a Stop of the recipient, for its next turn", () =>
  Effect.gen(function* () {
    const { ana, bo, boSession, boTurn } = yield* toldWhileBusy;

    yield* (yield* Stops).stopBot({ commandId: command(), botId: bo.id });
    yield* turnEnded(bo.id);
    assert.deepStrictEqual(yield* teammateMessagesFor(bo.id), { wakes: 0, held: 2 });
    assert.deepStrictEqual(yield* handoffStates(ana.id), ["sent", "sent"]);
    assert.deepStrictEqual(yield* handoffStates(bo.id), ["sent", "sent"]);

    // Bo's next turn carries both, and the one after it neither.
    yield* sendToBot(bo.id, "Anything else?");
    const next = yield* nextTurn(bo.id, boTurn);
    yield* finished(bo.id, boSession, next);
    yield* sendToBot(bo.id, "And now?");
    yield* nextTurn(bo.id, next);
    for (const text of ["Deploy now.", "Staging is down."]) {
      assert.strictEqual(yield* timesSent(boSession, text), 1);
    }
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("delivers what teammates sent after a fresh start of the recipient", () =>
  Effect.gen(function* () {
    const { bo, boSession } = yield* toldWhileBusy;

    // A fresh start clears Bo's context, not its inbox.
    yield* (yield* Bots).freshStart({ commandId: command(), botId: bo.id });
    yield* sendToBot(bo.id, "Start over.");
    yield* turnEnded(bo.id);
    const replacement = yield* sessionAfter(bo.id, boSession);
    yield* nextTurn(bo.id);
    for (const text of ["Deploy now.", "Staging is down."]) {
      assert.strictEqual(yield* timesSent(replacement, text), 1);
      assert.strictEqual(yield* timesSent(boSession, text), 0);
    }
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "stops a chain between bots at the hop limit with one notice, until the operator speaks",
  () =>
    Effect.gen(function* () {
      yield* chainLimits({ hops: 1, fanOut: 1 });
      const { bot: ana, session, turnId } = yield* working("Ask Bo for the date.");
      const bo = yield* createBot("Bo");
      const boSession = yield* engineSession(bo.id);

      yield* messageTeammate(session, turnId, { to: bo.id, text: "The date?", urgent: true });
      const boTurn = yield* nextTurn(bo.id);
      for (const text of ["Friday.", "Friday, I mean."]) {
        const reply = yield* messageTeammate(boSession, boTurn, { to: ana.id, text, urgent: true });
        assert.include(refusal(reply), "reached your user's limit of 1");
      }
      assert.deepStrictEqual(yield* noticesOf(bo.id), ["chain-stopped"]);
      assert.deepStrictEqual(yield* teammateMessagesFor(ana.id), { wakes: 0, held: 0 });

      // The operator writes to Bo: the chain starts again from them.
      yield* (yield* TestEngineControl).finishTurn({
        sessionId: boSession,
        turnId: boTurn,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(bo.id);
      yield* sendToBot(bo.id, "Tell Ana it is Friday.");
      const asked = yield* nextTurn(bo.id, boTurn);
      const reply = yield* messageTeammate(boSession, asked, {
        to: ana.id,
        text: "Friday.",
        urgent: false,
      });
      assert.strictEqual(reply._tag, "result");
      assert.deepStrictEqual(yield* teammateMessagesFor(ana.id), { wakes: 0, held: 1 });
    }).pipe(Effect.provide(TestDomain.layer)),
);
