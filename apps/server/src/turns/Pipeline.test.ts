// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, Conflict, type EntryId, type EntryTarget, Invalid } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import * as Domain from "../domain.ts";
import { Entries } from "../entries/Entries.ts";
import { timeText } from "../persistence/columns.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { BotTools } from "../tools/BotTools.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  answerFirstOption,
  askRegion,
  awaitEntry,
  command,
  concurrentTurns,
  conversation,
  createBot,
  createNewBot,
  deliveryIs,
  engineSession,
  finishRunning,
  flushed,
  gateSettled,
  holdGate,
  messageTeammate,
  nextTurn,
  noticesOf,
  providerIs,
  received,
  recoverTimes,
  sendToBot,
  sendWithFile,
  sendWithFiles,
  sessionAfter,
  timesSent,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { Cards } from "./Cards.ts";
import { busyBackoff, DispatchRowId, MAX_INDETERMINATE_ANSWERS, recoveryBackoff } from "./model.ts";
import { Pipeline } from "./Pipeline.ts";
import { DEFECT_RETRY } from "./reconciler.ts";
import { Wakes } from "./Wakes.ts";

const FIRST_RUN = 'event="first-run"';

it.effect("opens a new bot's conversation with its first turn once the engine can take it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    // Created while the engine is down: its first-run wake waits for a session.
    yield* control.setReachable(false);
    const bot = yield* createNewBot("Ana");
    yield* control.setReachable(true);

    const session = yield* engineSession(bot.id);
    yield* flushed(bot.id);
    const turnId = yield* nextTurn(bot.id);
    const [opening] = yield* control.dispatches(session);
    assert.include(opening?.text, FIRST_RUN);

    const args = { text: "Hi, I'm Ana. What should I look after first?", done: true };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "say",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: `say-${turnId}`,
      sessionId: session,
      tool: "say",
      arguments: args,
    });
    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    yield* turnEnded(bot.id);

    const said = yield* awaitEntry(bot.id, "message");
    assert.deepStrictEqual([said.author, said.text], [{ _tag: "bot", botId: bot.id }, args.text]);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves the opening out when the operator writes before the bot's first turn", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* control.setReachable(false);
    const bot = yield* createNewBot("Ana");
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* control.setReachable(true);

    const session = yield* engineSession(bot.id);
    yield* finishRunning(bot.id);
    yield* deliveryIs(message, "delivered");
    yield* turnEnded(bot.id);
    yield* flushed(bot.id);
    assert.deepStrictEqual(
      [yield* timesSent(session, "Book the venue."), yield* timesSent(session, FIRST_RUN)],
      [1, 0],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "opens a bot's conversation once: not on a retried creation, a restart, a fresh start, a lost session or a model change",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const created = Effect.gen(function* () {
        const bots = yield* Bots;
        const commandId = command();
        const draft = { name: "Ana", job: "" };
        const bot = yield* bots.create({ commandId, draft });
        const retried = yield* bots.create({ commandId, draft });
        assert.strictEqual(retried.id, bot.id);
        const session = yield* engineSession(bot.id);
        yield* flushed(bot.id);
        const turnId = yield* nextTurn(bot.id);
        yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
        yield* turnEnded(bot.id);
        return { bot, session };
      });
      const { bot, session } = yield* created.pipe(Effect.provide(Domain.layer));

      // The server starts again; the operator starts the bot fresh, the
      // engine loses the next session, and the operator changes the model.
      yield* Effect.gen(function* () {
        yield* flushed(bot.id);
        yield* (yield* Bots).freshStart({ commandId: command(), botId: bot.id });
        const fresh = yield* sessionAfter(bot.id, session);
        // The next send finds the session lost.
        yield* control.loseSession(fresh);
        yield* sendToBot(bot.id, "Where were we?");
        const replaced = yield* sessionAfter(bot.id, fresh);
        yield* finishRunning(bot.id);
        yield* turnEnded(bot.id);
        yield* (yield* Bots).update({
          commandId: command(),
          botId: bot.id,
          changes: { model: TestDomain.OTHER_PROVIDER_MODEL },
        });
        const moved = yield* sessionAfter(bot.id, replaced);
        yield* flushed(bot.id);
        const sent = [];
        for (const one of [session, fresh, replaced, moved]) {
          sent.push(yield* timesSent(one, FIRST_RUN));
        }
        assert.deepStrictEqual(sent, [1, 0, 0, 0]);
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("keeps a new bot's hello waiting while its provider is not ready", () =>
  Effect.gen(function* () {
    const { providerId } = TestDomain.OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, { _tag: "sign-in-required", command: "connect" });
    const bot = yield* createNewBot("Ana", TestDomain.OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, FIRST_RUN), 0);

    // Signed in: the hello goes without anything else waking the bot.
    yield* providerIs(providerId, { _tag: "ready" });
    yield* nextTurn(bot.id);
    assert.strictEqual(yield* timesSent(session, FIRST_RUN), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a new bot's hello through a change of provider, for the new one", () =>
  Effect.gen(function* () {
    const { providerId } = TestDomain.OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, { _tag: "unavailable", checking: false });
    const bot = yield* createNewBot("Ana", TestDomain.OTHER_PROVIDER_MODEL);
    const first = yield* engineSession(bot.id);
    yield* flushed(bot.id);

    // The operator moves the bot to a ready provider before it spoke.
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { model: TestDomain.DEFAULT_MODEL },
    });
    const moved = yield* sessionAfter(bot.id, first);
    yield* nextTurn(bot.id);
    assert.deepStrictEqual(
      [yield* timesSent(first, FIRST_RUN), yield* timesSent(moved, FIRST_RUN)],
      [0, 1],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "offers a retry of a new bot's opening that failed, before or after its turn started",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      // The engine refuses the opening: no turn ever starts.
      yield* control.rejectNextDispatch;
      const bot = yield* createNewBot("Ana");
      const session = yield* engineSession(bot.id);
      const refused = yield* awaitEntry(bot.id, "notice");
      assert.deepStrictEqual(refused.notice, { _tag: "turn-failed", failure: "unknown" });
      assert.isTrue(refused.retryable);

      // The retry's turn starts, and fails.
      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: refused.id });
      const turnId = yield* nextTurn(bot.id);
      yield* control.finishTurn({
        sessionId: session,
        turnId,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });
      yield* until(noticesOf(bot.id).pipe(Effect.map((shown) => shown.length === 2)));
      const [, failed] = (yield* conversation(bot.id)).flatMap((entry) =>
        entry._tag === "notice" ? [entry] : [],
      );
      assert.isDefined(failed);
      assert.deepStrictEqual(failed.notice, { _tag: "turn-failed", failure: "provider-error" });
      assert.isTrue(failed.retryable);

      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: failed.id });
      yield* nextTurn(bot.id, turnId);
      assert.strictEqual(yield* timesSent(session, FIRST_RUN), 2);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("drops a written opening the engine never got when the operator writes first", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { providerId } = TestDomain.OTHER_PROVIDER_MODEL;
    yield* providerIs(providerId, { _tag: "sign-in-required", command: "connect" });
    const bot = yield* createNewBot("Ana", TestDomain.OTHER_PROVIDER_MODEL);
    const session = yield* engineSession(bot.id);
    yield* flushed(bot.id);

    // The opening is written once the provider is ready, and its send waits.
    const gate = yield* holdGate(bot.id);
    yield* providerIs(providerId, { _tag: "ready" });
    yield* until(
      sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM dispatches`.pipe(
        Effect.orDie,
        Effect.map(([row]) => (row?.n ?? 0) > 0),
      ),
    );
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* gate.release;

    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.deepStrictEqual(
      [yield* timesSent(session, "Book the venue."), yield* timesSent(session, FIRST_RUN)],
      [1, 0],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("offers a failed opening no more once the operator has written", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* control.rejectNextDispatch;
    const bot = yield* createNewBot("Ana");
    const session = yield* engineSession(bot.id);
    const failed = yield* awaitEntry(bot.id, "notice");
    assert.isTrue(failed.retryable);

    // The operator writes instead, and the bot takes it up.
    const message = yield* sendToBot(bot.id, "Book the venue.");
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    const shown = (yield* conversation(bot.id)).find((entry) => entry.id === failed.id);
    assert.strictEqual(shown?._tag === "notice" ? shown.retryable : null, false);

    // A client that still shows the old retry is refused.
    const refused = yield* (yield* Pipeline)
      .retryNotice({ commandId: command(), entryId: failed.id })
      .pipe(Effect.flip);
    assert.deepStrictEqual(refused, new Conflict({ reason: "not-retryable" }));
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, FIRST_RUN), 0);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds an opening written before a restart until its provider is ready", () =>
  Effect.gen(function* () {
    const { providerId } = TestDomain.OTHER_PROVIDER_MODEL;
    // The opening is written, the provider signs out, and the server stops
    // before the opening is sent.
    const { bot, session } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* providerIs(providerId, { _tag: "sign-in-required", command: "connect" });
      const bot = yield* createNewBot("Ana", TestDomain.OTHER_PROVIDER_MODEL);
      const session = yield* engineSession(bot.id);
      yield* flushed(bot.id);
      yield* holdGate(bot.id);
      yield* providerIs(providerId, { _tag: "ready" });
      yield* until(
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM dispatches`.pipe(
          Effect.orDie,
          Effect.map(([row]) => (row?.n ?? 0) > 0),
        ),
      );
      yield* providerIs(providerId, { _tag: "sign-in-required", command: "connect" });
      return { bot, session };
    }).pipe(Effect.provide(Domain.layer));

    yield* Effect.gen(function* () {
      yield* flushed(bot.id);
      assert.strictEqual(yield* timesSent(session, FIRST_RUN), 0);
      yield* providerIs(providerId, { _tag: "ready" });
      yield* nextTurn(bot.id);
      assert.strictEqual(yield* timesSent(session, FIRST_RUN), 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("offers a retry of an opening whose session was lost before it ended", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createNewBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* nextTurn(bot.id);
    yield* control.loseSession(session);

    yield* until(noticesOf(bot.id).pipe(Effect.map((kinds) => kinds.length === 2)));
    assert.deepStrictEqual(yield* noticesOf(bot.id), ["session-lost", "turn-failed"]);
    const failed = yield* awaitEntry(bot.id, "notice");
    assert.isTrue(failed.retryable);

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: failed.id });
    const replaced = yield* sessionAfter(bot.id, session);
    yield* nextTurn(bot.id);
    assert.strictEqual(yield* timesSent(replaced, FIRST_RUN), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("delivers a message once when its send's reply is lost while the session is busy", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // The engine applies the start behind a turn of its own, and the answer is lost.
    yield* control.startEngineTurnDuringNextDispatch(session);
    yield* control.loseNextReply;
    const message = yield* sendToBot(bot.id, "Ship the report.");
    const ownTurn = yield* nextTurn(bot.id);
    yield* gateSettled(bot.id);

    // Recovery resends the same key once its backoff passes.
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* pipeline.recoverDue;
    yield* control.finishTurn({
      sessionId: session,
      turnId: ownTurn,
      outcome: { _tag: "completed" },
    });

    const delivered = yield* nextTurn(bot.id, ownTurn);
    yield* deliveryIs(message, "delivered");
    yield* control.finishTurn({
      sessionId: session,
      turnId: delivered,
      outcome: { _tag: "completed" },
    });
    yield* flushed(bot.id);

    assert.strictEqual(yield* timesSent(session, "Ship the report."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** An operator message written without waking anyone, for a test to wake the bot itself. */
const writeMessage = (target: EntryTarget, text: string) =>
  Effect.gen(function* () {
    const entry = yield* (yield* Entries).append({
      target,
      entry: {
        _tag: "message",
        author: { _tag: "operator" },
        text,
        attachments: [],
        mentions: { _tag: "bots", ids: [] },
        delivery: { _tag: "pending" },
        commandId: null,
      },
    });
    return entry.id;
  });

it.effect("coalesces waiting wakes only with wakes of the same kind and audience", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wakes = yield* Wakes;
    const bot = yield* createBot("Ana");
    const other = yield* createBot("Bia");
    const session = yield* engineSession(bot.id);
    const room = yield* (yield* Rooms).create({
      commandId: command(),
      name: "Launch",
      members: [bot.id, other.id],
    });
    const inConversation = { _tag: "conversation", botId: bot.id } as const;
    const first = yield* writeMessage(inConversation, "First in private.");
    const inRoom = yield* writeMessage({ _tag: "room", roomId: room.id }, "Said in the room.");
    const second = yield* writeMessage(inConversation, "Second in private.");

    const wake = (payload: Parameters<typeof wakes.record>[0][number]["payload"]) => ({
      botId: bot.id,
      sourceEntryId: null,
      hops: 0,
      retryOf: null,
      cause: { _tag: "operator" } as const,
      payload,
    });
    yield* sql.withTransaction(
      wakes.record([
        {
          ...wake({ _tag: "message", entryId: first }),
          kind: "user",
          audience: { _tag: "conversation" },
        },
        {
          ...wake({ _tag: "undelivered", dispatchId: DispatchRowId.make("earlier") }),
          kind: "system",
          audience: { _tag: "conversation" },
        },
        {
          ...wake({ _tag: "message", entryId: inRoom }),
          kind: "user",
          audience: { _tag: "room", roomId: room.id },
        },
        {
          ...wake({ _tag: "message", entryId: second }),
          kind: "user",
          audience: { _tag: "conversation" },
        },
      ]),
    );

    const one = yield* finishRunning(bot.id);
    const two = yield* finishRunning(bot.id, one);
    yield* finishRunning(bot.id, two);
    yield* flushed(bot.id);
    assert.lengthOf(yield* received(session), 3);

    const [private_, room_, system] = yield* received(session);
    assert.include(private_?.text, "First in private.");
    assert.include(private_?.text, "Second in private.");
    // In the order the operator wrote them, though written in one transaction.
    assert.isBelow(
      private_?.text.indexOf("First in private.") ?? -1,
      private_?.text.indexOf("Second in private.") ?? -1,
    );
    assert.notInclude(private_?.text, "Said in the room.");
    assert.include(room_?.text, "Said in the room.");
    assert.notInclude(room_?.text, "in private.");
    assert.notInclude(system?.text, "in private.");
    assert.notInclude(system?.text, "Said in the room.");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("splits waiting messages too long for one envelope across dispatches, in order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wakes = yield* Wakes;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    // Each fits the engine's input limit alone; the first two together do not.
    const first = `First. ${"a".repeat(70_000)}`;
    const second = `Second. ${"b".repeat(70_000)}`;
    const inConversation = { _tag: "conversation", botId: bot.id } as const;
    const ids = [
      yield* writeMessage(inConversation, first),
      yield* writeMessage(inConversation, second),
      yield* writeMessage(inConversation, "Third."),
    ];
    yield* sql.withTransaction(
      wakes.record(
        ids.map((entryId) => ({
          botId: bot.id,
          kind: "user",
          audience: { _tag: "conversation" },
          payload: { _tag: "message", entryId },
          sourceEntryId: entryId,
          hops: 0,
          retryOf: null,
          cause: { _tag: "operator" },
        })),
      ),
    );

    const one = yield* finishRunning(bot.id);
    yield* finishRunning(bot.id, one);
    yield* flushed(bot.id);

    const sent = yield* received(session);
    assert.deepStrictEqual(
      sent.map(({ text }) => [
        text.includes("First."),
        text.includes("Second."),
        text.includes("Third."),
      ]),
      [
        [true, false, false],
        [false, true, true],
      ],
    );
    for (const entryId of ids) yield* deliveryIs(entryId, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a message too long for the engine as the bot would read it", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // Within the message limit as typed, but each `<j3` is defused to `&lt;j3`
    // in the envelope: 175,000 characters.
    const refused = yield* Effect.flip(sendToBot(bot.id, "<j3 ".repeat(25_000)));
    assert.deepStrictEqual(refused, new Invalid({ reason: "message-length" }));
    assert.lengthOf(yield* conversation(bot.id), 0);

    // The longest plain message is taken and delivered.
    const longest = yield* sendToBot(bot.id, "a".repeat(100_000));
    yield* finishRunning(bot.id);
    yield* flushed(bot.id);
    yield* deliveryIs(longest, "delivered");
    assert.lengthOf(yield* received(session), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps where the operator placed each file, and refuses places that do not fit", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    yield* engineSession(bot.id);

    for (const offsets of [[3], [6, 2], [0, 99], [1.5, 2]]) {
      const refused = yield* Effect.flip(
        sendWithFiles(bot.id, "see  and ", ["a.txt", "b.txt"], offsets),
      );
      assert.deepStrictEqual(refused, new Invalid({ reason: "attachment" }));
    }
    // Between the two halves of a character.
    const split = yield* Effect.flip(sendWithFiles(bot.id, "🙂", ["a.txt"], [1]));
    assert.deepStrictEqual(split, new Invalid({ reason: "attachment" }));
    assert.lengthOf(yield* conversation(bot.id), 0);

    const placed = yield* sendWithFiles(bot.id, "see  and ", ["a.txt", "b.txt"], [4, 9]);
    const unplaced = yield* sendWithFiles(bot.id, "see these", ["c.txt"]);
    const [first, second] = yield* conversation(bot.id);
    assert.strictEqual(first?.id, placed);
    assert.deepStrictEqual(first?._tag === "message" && first.attachmentOffsets, [4, 9]);
    assert.strictEqual(second?.id, unplaced);
    assert.isFalse(second?._tag === "message" && "attachmentOffsets" in second);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** Records `user` wakes for the bot's messages, past `message.send`'s checks. */
const recordMessages = (botId: BotId, entryIds: ReadonlyArray<EntryId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      (yield* Wakes).record(
        entryIds.map((entryId) => ({
          botId,
          kind: "user",
          audience: { _tag: "conversation" },
          payload: { _tag: "message", entryId },
          sourceEntryId: entryId,
          hops: 0,
          retryOf: null,
          cause: { _tag: "operator" },
        })),
      ),
    );
  });

it.effect("fails a waiting message too long to send alone, and sends the one behind it", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const inConversation = { _tag: "conversation", botId: bot.id } as const;
    // Each `<j3` renders as `&lt;j3`: 175,000 characters, which no envelope takes.
    const tooLong = yield* writeMessage(inConversation, "<j3 ".repeat(25_000));
    const next = yield* writeMessage(inConversation, "Then draft the plan.");
    yield* recordMessages(bot.id, [tooLong, next]);

    yield* finishRunning(bot.id);
    yield* flushed(bot.id);
    yield* deliveryIs(tooLong, "failed");
    yield* deliveryIs(next, "delivered");
    const sent = yield* received(session);
    assert.deepStrictEqual(
      sent.map(({ text }) => text.includes("Then draft the plan.")),
      [true],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves out, visibly, what the session has not seen and no envelope can carry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const now = yield* DateTime.now;
    const note = (id: string, text: string) =>
      sql`
        INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json)
        VALUES (
          ${id}, ${bot.id}, ${text}, ${timeText(now)},
          ${JSON.stringify({
            _tag: "routine-delivered",
            routine: "Morning check",
            at: DateTime.formatIso(now),
            text,
          })}
        )
      `;
    yield* note("note-too-long", `Overnight. ${"a".repeat(130_000)}`);
    yield* note("note-after", "The build is green.");

    const message = yield* sendToBot(bot.id, "What happened overnight?");
    yield* finishRunning(bot.id);
    yield* flushed(bot.id);
    yield* deliveryIs(message, "delivered");
    const sent = yield* received(session);
    assert.deepStrictEqual(
      sent.map(({ text }) => [text.includes("Overnight."), text.includes("The build is green.")]),
      [[false, true]],
    );
    const notes = yield* sql<{ readonly id: string }>`SELECT id FROM catch_up_notes`;
    assert.deepStrictEqual(
      notes.map((row) => row.id),
      ["note-after"],
    );
    assert.include(yield* noticesOf(bot.id), "too-long");
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** A teammate, in a turn the operator started, leaves the bot a message that is not urgent. */
const holdMessageFor = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const sender = yield* createBot("Cy");
    const session = yield* engineSession(sender.id);
    yield* sendToBot(sender.id, "Let Ana know.");
    const turnId = yield* nextTurn(sender.id);
    const reply = yield* messageTeammate(session, turnId, { to: botId, text, urgent: false });
    assert.strictEqual(reply._tag, "result");
    return sender.id;
  });

/** Where the teammate messages each bot's conversation shows stand, oldest first. */
const handoffStates = (botIds: ReadonlyArray<BotId>) =>
  Effect.forEach(botIds, (botId) =>
    conversation(botId).pipe(
      Effect.map((entries) =>
        entries.flatMap((entry) => (entry._tag === "handoff" ? [entry.state] : [])),
      ),
    ),
  );

it.effect("delivers a held teammate message in one envelope, again after a refused one", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* holdMessageFor(bot.id, "The launch moved to Friday.");
    // It wakes nobody.
    yield* flushed(bot.id);
    assert.deepStrictEqual(yield* received(session), []);

    // The envelope that carried it was refused: the next one carries it.
    yield* control.rejectNextDispatch;
    yield* deliveryIs(yield* sendToBot(bot.id, "Any news?"), "failed");
    yield* gateSettled(bot.id);
    yield* sendToBot(bot.id, "Any news now?");
    const first = yield* finishRunning(bot.id);
    yield* sendToBot(bot.id, "And the venue?");
    yield* finishRunning(bot.id, first);

    const sent = yield* received(session);
    assert.deepStrictEqual(
      sent.map(({ text }) => text.includes("The launch moved to Friday.")),
      [true, false],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a held teammate message with an envelope whose fate is unknown", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const sender = yield* holdMessageFor(bot.id, "The launch moved to Friday.");

    // The send carrying it is never answered, and its recovery gives up: it may still land.
    const deferred = yield* control.deferNextDispatch;
    const lost = yield* sendToBot(bot.id, "Any news?");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(lost, "failed");
    // Neither card can tell whether it was read.
    assert.deepStrictEqual(yield* handoffStates([sender, bot.id]), [
      ["unconfirmed"],
      ["unconfirmed"],
    ]);

    yield* sendToBot(bot.id, "And the venue?");
    const turnId = yield* finishRunning(bot.id);
    assert.strictEqual(yield* timesSent(session, "The launch moved to Friday."), 0);

    // It lands after all: the bot read it.
    yield* deferred.land;
    yield* nextTurn(bot.id, turnId);
    yield* until(
      handoffStates([sender, bot.id]).pipe(
        Effect.map((states) => states.flat().every((state) => state === "sent")),
      ),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "keeps a held teammate message unconfirmed when its recipient goes before the send is answered",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      yield* engineSession(bot.id);
      const sender = yield* holdMessageFor(bot.id, "The launch moved to Friday.");

      // The send carrying it is never answered: it may still land.
      yield* control.deferNextDispatch;
      yield* sendToBot(bot.id, "Any news?");
      yield* flushed(bot.id);
      yield* (yield* Bots).remove({ commandId: command(), botId: bot.id, deleteFiles: true });
      assert.deepStrictEqual(yield* handoffStates([sender]), [["unconfirmed"]]);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("shows a held teammate message no envelope can carry as not delivered", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const sender = yield* holdMessageFor(bot.id, "The launch moved.");
    // Every writer refuses such a message; the envelope's defence meets one all the same.
    yield* sql`UPDATE held_messages SET text = ${`The launch moved. ${"a".repeat(130_000)}`}`;

    yield* sendToBot(bot.id, "Any news?");
    yield* finishRunning(bot.id);
    assert.strictEqual(yield* timesSent(session, "The launch moved."), 0);
    assert.deepStrictEqual(yield* handoffStates([sender, bot.id]), [
      ["not-delivered"],
      ["not-delivered"],
    ]);
    assert.include(yield* noticesOf(bot.id), "too-long");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a refused message failed until the operator retries it, then delivers it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    yield* control.rejectNextDispatch;
    const message = yield* sendToBot(bot.id, "Draft the plan.");
    yield* deliveryIs(message, "failed");
    yield* gateSettled(bot.id);
    assert.strictEqual(yield* timesSent(session, "Draft the plan."), 0);

    yield* pipeline.retryMessage({ commandId: command(), entryId: message });
    yield* nextTurn(bot.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Draft the plan."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses to send a message again once the engine accepted it late", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    // The message's send is never answered, and its recovery gives up.
    const { session, deferred, message } = yield* Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      const deferred = yield* control.deferNextDispatch;
      const message = yield* sendToBot(bot.id, "Ship the report.");
      yield* flushed(bot.id);
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* deliveryIs(message, "failed");
      return { session, deferred, message };
    }).pipe(Effect.provide(Domain.layer));

    // While the server is down the engine applies it after all, behind a turn
    // of its own, and forgets the history the server's cursor names: the
    // replacement shows it waiting, accepted.
    yield* control.startEngineTurn(session);
    yield* deferred.land;
    yield* control.pruneHistory(session);

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* until(
        sql<{ readonly status: string }>`
          SELECT status FROM dispatches
          WHERE id = (SELECT dispatch_id FROM wakes WHERE source_entry_id = ${message})
        `.pipe(
          Effect.orDie,
          Effect.map(([row]) => row?.status === "accepted"),
        ),
      );
      const refused = yield* (yield* Pipeline)
        .retryMessage({ commandId: command(), entryId: message })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "Conflict");
      yield* deliveryIs(message, "pending");
      assert.strictEqual(yield* timesSent(session, "Ship the report."), 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("refuses to send a message again once the engine queued it late", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const deferred = yield* control.deferNextDispatch;
    const message = yield* sendToBot(bot.id, "Ship the report.");
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    yield* deliveryIs(message, "failed");

    // The engine applies it after all, behind a turn of its own: its events
    // show it queued, accepted.
    yield* control.startEngineTurn(session);
    yield* deferred.land;
    yield* deliveryIs(message, "pending");
    const refused = yield* (yield* Pipeline)
      .retryMessage({ commandId: command(), entryId: message })
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "Conflict");
    assert.strictEqual(yield* timesSent(session, "Ship the report."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("holds an answer until the turn that asked ends, then starts a turn with it", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const turnId = yield* nextTurn(bot.id);
    const args = { prompt: "Which region?", options: [{ label: "Europe", value: "eu-west-1" }] };
    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: "call-1",
      sessionId: session,
      tool: "ask",
      arguments: args,
    });
    const card = yield* awaitEntry(bot.id, "question");

    // The operator answers before the bot ends the turn that asked.
    yield* (yield* Cards).answer({
      commandId: command(),
      entryId: card.id,
      answer: {
        _tag: "question",
        answers: { [card.questions[0].id]: { optionIds: ["option-1"], text: null } },
      },
    });
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 0);

    yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
    yield* nextTurn(bot.id, turnId);
    const answered = (yield* control.dispatches(session)).filter((dispatch) =>
      dispatch.text.includes("eu-west-1"),
    );
    assert.deepStrictEqual(
      answered.map((dispatch) => dispatch.delivery._tag),
      ["start"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows a retryable notice for an answer whose dispatch failed, and sends it on retry",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Deploy it.");
      const turnId = yield* nextTurn(bot.id);
      const args = { prompt: "Which region?", options: [{ label: "Europe", value: "eu-west-1" }] };
      yield* control.toolCall({
        sessionId: session,
        turnId,
        tool: "ask",
        input: args,
        recorded: "now",
      });
      yield* (yield* BotTools).call({
        requestId: "call-1",
        sessionId: session,
        tool: "ask",
        arguments: args,
      });
      const card = yield* awaitEntry(bot.id, "question");
      yield* control.finishTurn({ sessionId: session, turnId, outcome: { _tag: "completed" } });
      yield* turnEnded(bot.id);

      // The engine refuses the turn the answer starts.
      yield* control.rejectNextDispatch;
      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: card.id,
        answer: {
          _tag: "question",
          answers: { [card.questions[0].id]: { optionIds: ["option-1"], text: null } },
        },
      });
      const notice = yield* awaitEntry(bot.id, "notice");
      assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "unknown" });
      assert.isTrue(notice.retryable);

      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
      yield* nextTurn(bot.id, turnId);
      assert.strictEqual(yield* timesSent(session, "eu-west-1"), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends a failed turn's message again when the operator retries its notice", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    const message = yield* sendToBot(bot.id, "Compile the report.");
    const turnId = yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
    });
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.deepStrictEqual(notice.notice, { _tag: "turn-failed", failure: "provider-error" });

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bot.id, turnId);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Compile the report."), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends an engine card's answer again after a restart, once", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const firstRun = Effect.gen(function* () {
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Clean the build folder.");
      const turnId = yield* nextTurn(bot.id);
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
      // The answer is recorded, and the engine is gone before it is sent.
      yield* control.setReachable(false);
      yield* (yield* Cards).answer({
        commandId: command(),
        entryId: card.id,
        answer: { _tag: "approval", decision: "allow-once" },
      });
      return { bot, session };
    });
    const { bot, session } = yield* firstRun.pipe(Effect.provide(Domain.layer));

    yield* control.setReachable(true);
    yield* Effect.gen(function* () {
      yield* until(
        awaitEntry(bot.id, "approval").pipe(Effect.map((card) => card.status._tag === "decided")),
      );
      assert.strictEqual((yield* control.responses(session)).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("starts a bot refused busy once the deadline passes, after the turn's last event", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);

    // The engine starts a turn of its own while the start is at its door, and
    // the refusal reaches the server only after that turn's last event.
    const sending = yield* control.holdNext("dispatch");
    const message = yield* sendToBot(bot.id, "Draft the summary.");
    yield* sending.entered;
    const background = yield* control.startEngineTurn(session);
    const answer = yield* control.holdNextAnswer("dispatch");
    yield* sending.release;
    yield* answer.entered;
    yield* nextTurn(bot.id);
    yield* control.finishTurn({
      sessionId: session,
      turnId: background,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* answer.release;
    yield* gateSettled(bot.id);

    // The session is left alone until its deadline, and taken after it.
    yield* flushed(bot.id);
    assert.strictEqual(yield* timesSent(session, "Draft the summary."), 0);
    yield* TestClock.adjust(busyBackoff(1));
    yield* flushed(bot.id);
    yield* nextTurn(bot.id, background);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(session, "Draft the summary."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts a ready bot with the last slot while another bot's session catches up", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* concurrentTurns(1);
    const ana = yield* createBot("Ana");
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);
    // Ana's session is replaced, and nothing has followed the new one yet.
    const replaced = yield* engineSession(ana.id);
    yield* control.loseSession(replaced);
    const anaSession = yield* sessionAfter(ana.id, replaced);

    // Ana's new session never answers with its first snapshot.
    const stalled = yield* control.withholdEvents(anaSession);
    const waiting = yield* sendToBot(ana.id, "Plan the sprint.");
    const message = yield* sendToBot(bia.id, "Review the budget.");
    yield* flushed(bia.id);
    const biaTurn = yield* nextTurn(bia.id);
    yield* deliveryIs(message, "delivered");

    // Once caught up, Ana takes the slot Bia gives back.
    yield* stalled.release;
    yield* flushed(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Plan the sprint."), 0);
    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* nextTurn(ana.id);
    yield* deliveryIs(waiting, "delivered");
  }).pipe(Effect.provide(TestDomain.layer)),
);

/**
 * Waits until a steer is written. Writing a dispatch changes nothing a client
 * sees, so this reads the table again each time other fibers have run.
 */
const steerWritten = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM dispatches WHERE delivery = 'steer'
    `.pipe(Effect.orDie);
    if ((row?.n ?? 0) > 0) return;
    yield* Effect.yieldNow;
  }
});

it.effect("starts a turn with a steer whose turn ended while it waited for the gate", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Collect the metrics.");
    const running = yield* nextTurn(bot.id);

    // The message is planned into the running turn, and its send waits.
    const gate = yield* holdGate(bot.id);
    const message = yield* sendToBot(bot.id, "Include last week too.");
    yield* steerWritten;
    yield* control.finishTurn({
      sessionId: session,
      turnId: running,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    yield* gate.release;

    yield* nextTurn(bot.id, running);
    yield* deliveryIs(message, "delivered");
    const received = yield* control.dispatches(session);
    assert.deepStrictEqual(
      received
        .filter((dispatch) => dispatch.text.includes("Include last week too."))
        .map((dispatch) => dispatch.delivery._tag),
      ["start"],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("waits for a turn slot before sending a message whose file failed to stage", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const pipeline = yield* Pipeline;
    yield* concurrentTurns(1);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);

    // Ana's file is staged, and the reply is lost: nothing reached the engine.
    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(ana.id, "Read the notes.");
    yield* staging.entered;
    yield* control.loseNextReply;
    yield* staging.release;
    yield* gateSettled(ana.id);

    // Bia takes the only slot, and Ana's retry falls due.
    yield* sendToBot(bia.id, "Review the budget.");
    const biaTurn = yield* nextTurn(bia.id);
    yield* TestClock.adjust(recoveryBackoff(1));
    yield* pipeline.recoverDue;
    yield* flushed(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 0);

    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bia.id);
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends other bots' messages past a dispatch that cannot be read, and then that one", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const sql = yield* SqlClient.SqlClient;
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");

    // Ana's file fails to stage, and her dispatch's deadline is stored broken.
    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(ana.id, "Read the notes.");
    yield* staging.entered;
    yield* control.loseNextReply;
    yield* staging.release;
    yield* gateSettled(ana.id);
    yield* sql`UPDATE dispatches SET next_attempt_at = 'soon'`.pipe(Effect.orDie);

    yield* sendToBot(bia.id, "Review the budget.");
    yield* nextTurn(bia.id);

    // Ana's waits, given a readable deadline, and goes once it passes.
    yield* TestClock.adjust(DEFECT_RETRY);
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves a start unsent when the budget is lowered while its file stages", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    yield* concurrentTurns(2);
    const ana = yield* createBot("Ana");
    const anaSession = yield* engineSession(ana.id);
    const bia = yield* createBot("Bia");
    const biaSession = yield* engineSession(bia.id);
    yield* sendToBot(bia.id, "Review the budget.");
    const biaTurn = yield* nextTurn(bia.id);

    // Ana's start is planned with the second slot, and the operator lowers
    // the budget to one while its file stages.
    const staging = yield* control.holdNext("stageAttachment");
    const message = yield* sendWithFile(ana.id, "Read the notes.");
    yield* staging.entered;
    yield* concurrentTurns(1);
    yield* staging.release;
    yield* gateSettled(ana.id);
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 0);

    // It goes once Bia's turn frees the only slot.
    yield* control.finishTurn({
      sessionId: biaSession,
      turnId: biaTurn,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bia.id);
    yield* nextTurn(ana.id);
    yield* deliveryIs(message, "delivered");
    assert.strictEqual(yield* timesSent(anaSession, "Read the notes."), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "sends a message whose file failed to stage with the slot its session's continuation holds",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      yield* concurrentTurns(1);
      const bot = yield* createBot("Ana");
      const session = yield* engineSession(bot.id);
      yield* sendToBot(bot.id, "Translate the docs.");
      const first = yield* nextTurn(bot.id);
      const resumesAt = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
      yield* control.finishTurn({
        sessionId: session,
        turnId: first,
        outcome: { _tag: "failed", failure: "usage-limit", retryAt: resumesAt },
        continuation: { resumesAt },
      });
      yield* turnEnded(bot.id);

      // The operator's message may start a turn on the slot the pending
      // continuation holds, and its file's staging reply is lost.
      const staging = yield* control.holdNext("stageAttachment");
      const message = yield* sendWithFile(bot.id, "Read the notes.");
      yield* staging.entered;
      yield* control.loseNextReply;
      yield* staging.release;
      yield* gateSettled(bot.id);

      // Staged again once the backoff passes, it is sent on that same slot.
      yield* TestClock.adjust(recoveryBackoff(1));
      yield* flushed(bot.id);
      yield* nextTurn(bot.id, first);
      yield* deliveryIs(message, "delivered");
      assert.strictEqual(yield* timesSent(session, "Read the notes."), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("sends an answer again from its notice when its turn failed to start", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const asking = yield* nextTurn(bot.id);
    const card = yield* askRegion(bot.id, session, asking);
    yield* control.finishTurn({
      sessionId: session,
      turnId: asking,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);

    // The engine takes the answer, and its turn fails before the provider starts it.
    yield* control.failNextStart({ sessionId: session, failure: "provider-error" });
    yield* answerFirstOption(card);
    const notice = yield* awaitEntry(bot.id, "notice");
    assert.isTrue(notice.retryable);

    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bot.id, asking);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses to send an answer again once the engine applied it late", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Deploy it.");
    const asking = yield* nextTurn(bot.id);
    const card = yield* askRegion(bot.id, session, asking);
    yield* control.finishTurn({
      sessionId: session,
      turnId: asking,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);

    // The answer's send is never answered, and its recovery gives up.
    const deferred = yield* control.deferNextDispatch;
    yield* answerFirstOption(card);
    yield* flushed(bot.id);
    yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
    const notice = yield* awaitEntry(bot.id, "notice");

    // Then the engine applies it after all.
    yield* deferred.land;
    yield* nextTurn(bot.id, asking);
    const refused = yield* (yield* Pipeline)
      .retryNotice({ commandId: command(), entryId: notice.id })
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "Conflict");
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

/** The bot asks in a turn that then ends, and the card it asked with. */
const askedAndEnded = Effect.gen(function* () {
  const control = yield* TestEngineControl;
  const bot = yield* createBot("Ana");
  const session = yield* engineSession(bot.id);
  yield* sendToBot(bot.id, "Deploy it.");
  const asking = yield* nextTurn(bot.id);
  const card = yield* askRegion(bot.id, session, asking);
  yield* control.finishTurn({ sessionId: session, turnId: asking, outcome: { _tag: "completed" } });
  yield* turnEnded(bot.id);
  return { bot, session, asking, card };
});

/** Waits until the engine's events settled the bot's only answer dispatch as dropped. */
const answerDropped = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const [row] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM dispatches d JOIN wakes w ON w.dispatch_id = d.id
      WHERE d.status = 'dropped' AND json_extract(w.payload_json, '$._tag') = 'answer'
    `.pipe(Effect.orDie);
    if ((row?.n ?? 0) > 0) return;
    yield* Effect.yieldNow;
  }
});

it.effect("keeps an answer's notice retryable when the send's reply follows its failed start", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const { bot, session, asking, card } = yield* askedAndEnded;

    // The answer's turn fails before the provider starts it, and the events
    // say so before the send hears the engine took the key.
    yield* control.failNextStart({ sessionId: session, failure: "provider-error" });
    const reply = yield* control.holdNextAnswer("dispatch");
    yield* answerFirstOption(card);
    yield* reply.entered;
    yield* awaitEntry(bot.id, "notice");
    yield* reply.release;
    yield* gateSettled(bot.id);

    const notice = yield* awaitEntry(bot.id, "notice");
    assert.isTrue(notice.retryable);
    yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
    yield* nextTurn(bot.id, asking);
    assert.strictEqual(yield* timesSent(session, "eu-west-1"), 2);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "offers an answer's retry again when the engine drops it after its recovery gave up",
  () =>
    Effect.gen(function* () {
      const control = yield* TestEngineControl;
      const { bot, session, asking, card } = yield* askedAndEnded;

      // The answer's send is never answered, and its recovery gives up.
      const deferred = yield* control.deferNextDispatch;
      yield* answerFirstOption(card);
      yield* flushed(bot.id);
      yield* recoverTimes(MAX_INDETERMINATE_ANSWERS - 1);
      yield* awaitEntry(bot.id, "notice");

      // The engine applies it after all, and its turn fails before it starts:
      // the bot never read the answer.
      yield* control.failNextStart({ sessionId: session, failure: "provider-error" });
      yield* deferred.land;
      yield* answerDropped;

      const notice = yield* awaitEntry(bot.id, "notice");
      assert.isTrue(notice.retryable);
      yield* (yield* Pipeline).retryNotice({ commandId: command(), entryId: notice.id });
      yield* nextTurn(bot.id, asking);
      assert.strictEqual(yield* timesSent(session, "eu-west-1"), 2);
    }).pipe(Effect.provide(TestDomain.layer)),
);
