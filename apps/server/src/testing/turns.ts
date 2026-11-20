// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  CommandId,
  type RoomId,
  type Entry,
  type EntryId,
  EntryOrder,
  type MessageDelivery,
  type Notice,
  PositiveInt,
  type QuestionEntry,
} from "@j3-bots/contracts";
import { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as TestClock from "effect/testing/TestClock";
import { Attachments } from "../attachments/Attachments.ts";
import { Bots } from "../bots/Bots.ts";
import { Entries } from "../entries/Entries.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Cards } from "../turns/Cards.ts";
import { recoveryBackoff, SessionRowId } from "../turns/model.ts";
import { Observer } from "../turns/Observer.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { SessionGate } from "../turns/SessionGate.ts";
import { Wakes } from "../turns/Wakes.ts";

let commands = 0;
/** A fresh operator command id. */
export const command = () => CommandId.make(`command-${++commands}`);

export const createBot = (name: string) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    yield* TestClock.adjust("1 second");
    return yield* bots.create({ commandId: command(), draft: { name, job: "" } });
  });

/** How long `eventually` waits for a change before it reads again anyway, in real time. */
const POLL_INTERVAL = "20 millis";

/**
 * Re-reads `read` each time the server commits a change a client could see,
 * until it finds a value. Every event the observer applies and every write to
 * an entry signals one; state written without one is read again after a short
 * real-time interval, which the test clock does not hold back.
 */
export const eventually = <A, E, R>(read: Effect.Effect<Option.Option<A>, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* (yield* ChangeLog).subscribe;
      while (true) {
        const found = yield* read;
        if (Option.isSome(found)) return found.value;
        yield* Effect.raceFirst(
          Effect.asVoid(PubSub.take(changes)),
          TestClock.withLive(Effect.sleep(POLL_INTERVAL)),
        );
      }
    }),
  );

/** Waits until `check` holds. */
export const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  eventually(check.pipe(Effect.map((holds) => (holds ? Option.some(true) : Option.none()))));

const sessionRow = Effect.fn(function* (botId: BotId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      id: SessionRowId,
      engine_session_id: Schema.NullOr(SessionId),
      admitted_turn_id: Schema.NullOr(TurnId),
      lost_at: Schema.NullOr(Schema.String),
    }),
    execute: (bot) => sql`
      SELECT id, engine_session_id, admitted_turn_id, lost_at FROM sessions
      WHERE bot_id = ${bot} AND purpose = 'main' AND retired_at IS NULL
    `,
  })(botId).pipe(Effect.orDie);
});

/** J3 Bots' own id of the bot's main session. */
export const mainSessionId = (botId: BotId) =>
  sessionRow(botId).pipe(Effect.map((row) => Option.getOrThrow(row).id));

/** The engine session the bot works in, which the test drives the engine through. */
export const engineSession = (botId: BotId) =>
  eventually(
    sessionRow(botId).pipe(
      Effect.map((row) =>
        Option.flatMap(row, (found) => Option.fromNullishOr(found.engine_session_id)),
      ),
    ),
  );

/**
 * Waits for whatever holds the bot's session gate (a send, a Stop round, a
 * resume) to finish what it started.
 */
export const gateSettled = (botId: BotId) =>
  Effect.gen(function* () {
    const row = Option.getOrThrow(yield* sessionRow(botId));
    yield* (yield* SessionGate).run(row.id)(Effect.void);
  });

/**
 * Holds the bot's session gate, as a long send or Stop round would, until
 * `release`: whatever needs the gate waits behind it.
 */
export const holdGate = (botId: BotId) =>
  Effect.gen(function* () {
    const row = Option.getOrThrow(yield* sessionRow(botId));
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* (yield* SessionGate)
      .run(row.id)(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    return { release: Deferred.succeed(release, undefined).pipe(Effect.asVoid) };
  });

/**
 * Waits until every wake the bot can take now has reached the engine: its
 * session's events are caught up (a session not caught up takes nothing),
 * then one pass of the dispatcher, then whatever send of the bot's still runs.
 */
export const flushed = (botId: BotId) =>
  Effect.gen(function* () {
    const observer = yield* Observer;
    yield* until(
      sessionRow(botId).pipe(
        Effect.flatMap((row) =>
          Option.isNone(row) || row.value.lost_at !== null
            ? Effect.succeed(true)
            : // Following a session is what lets it be ready.
              observer.watch(row.value.id).pipe(Effect.andThen(observer.ready(row.value.id))),
        ),
      ),
    );
    yield* (yield* Pipeline).dispatchPending;
    yield* gateSettled(botId);
  });

/** The turn the server saw start and not yet end. */
export const admittedTurn = (botId: BotId) =>
  sessionRow(botId).pipe(
    Effect.map((row) =>
      Option.flatMap(row, (found) => Option.fromNullishOr(found.admitted_turn_id)),
    ),
  );

/** Waits for a turn other than `previous` to be running. */
export const nextTurn = (botId: BotId, previous: TurnId | null = null) =>
  eventually(admittedTurn(botId).pipe(Effect.map(Option.filter((turnId) => turnId !== previous))));

/** Waits until the server saw the bot's turn end. */
export const turnEnded = (botId: BotId) =>
  until(admittedTurn(botId).pipe(Effect.map(Option.isNone)));

/** The operator writes to the bot in its conversation. */
export const sendToBot = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const pipeline = yield* Pipeline;
    return yield* pipeline.sendMessage({
      commandId: command(),
      target: { _tag: "conversation", botId },
      text,
      attachments: [],
    });
  });

/** The bot's conversation, oldest first. */
export const conversation = (botId: BotId) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    const page = yield* entries.history({
      target: { _tag: "conversation", botId },
      before: EntryOrder.make(Number.MAX_SAFE_INTEGER),
      limit: 500,
    });
    return page.entries;
  });

const entry = (entryId: EntryId) =>
  Effect.gen(function* () {
    const found = yield* (yield* Entries).find(entryId);
    return Option.getOrThrow(found).entry;
  });

const delivery = (entryId: EntryId) =>
  entry(entryId).pipe(
    Effect.map((found): MessageDelivery | null =>
      found._tag === "message" ? found.delivery : null,
    ),
  );

/** Waits for the message to reach `tag`. */
export const deliveryIs = (entryId: EntryId, tag: MessageDelivery["_tag"]) =>
  until(delivery(entryId).pipe(Effect.map((found) => found?._tag === tag)));

/** Waits for an entry of the kind to appear in the bot's conversation, and returns the latest. */
export const awaitEntry = <T extends Entry["_tag"]>(botId: BotId, tag: T) =>
  eventually(
    conversation(botId).pipe(
      Effect.map((entries) =>
        Option.fromNullishOr(
          entries.findLast(
            (found): found is Extract<Entry, { readonly _tag: T }> => found._tag === tag,
          ),
        ),
      ),
    ),
  );

/** How many dispatches the engine applied to the session carried `text`. */
export const timesSent = (sessionId: SessionId, text: string) =>
  Effect.gen(function* () {
    const received = yield* (yield* TestEngineControl).dispatches(sessionId);
    return received.filter((dispatch) => dispatch.text.includes(text)).length;
  });

/** A room of the bot and a second member, which the bot hosts. */
export const roomOf = (botId: BotId) =>
  Effect.gen(function* () {
    const other = yield* createBot("Bia");
    return yield* (yield* Rooms).create({
      commandId: command(),
      name: "Launch",
      members: [botId, other.id],
      hostId: botId,
    });
  });

/**
 * The operator writes in a room and the bot is woken for it, as room routing
 * will once it addresses members (part 2b).
 */
export const sendInRoom = (botId: BotId, roomId: RoomId, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entry = yield* (yield* Entries).append({
      target: { _tag: "room", roomId },
      entry: {
        _tag: "message",
        author: { _tag: "operator" },
        text,
        attachments: [],
        mentions: { _tag: "bots", ids: [botId] },
        delivery: { _tag: "pending" },
        commandId: null,
      },
    });
    yield* sql.withTransaction(
      (yield* Wakes).record([
        {
          botId,
          kind: "user",
          audience: { _tag: "room", roomId },
          payload: { _tag: "message", entryId: entry.id },
          sourceEntryId: entry.id,
          hops: 0,
          retryOf: null,
          cause: { _tag: "operator" },
        },
      ]),
    );
    yield* (yield* Pipeline).dispatchPending;
    return entry.id;
  });

/** The operator writes to the bot with a file attached. */
export const sendWithFile = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const file = yield* (yield* Attachments).store({
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("Release notes."),
    });
    return yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "conversation", botId },
      text,
      attachments: [file.id],
    });
  });

/** At most `n` turns run at once across all bots. */
export const concurrentTurns = (n: number) =>
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const settings = yield* store.get;
    yield* store.save(
      { ...settings, budgets: { ...settings.budgets, concurrentTurns: PositiveInt.make(n) } },
      yield* DateTime.now,
    );
  });

/** Runs the recovery once each backoff passes, `times` times. */
export const recoverTimes = (times: number) =>
  Effect.gen(function* () {
    const pipeline = yield* Pipeline;
    for (let answer = 1; answer <= times; answer++) {
      yield* TestClock.adjust(recoveryBackoff(answer));
      yield* pipeline.recoverDue;
    }
  });

/** Waits until no Stop waits on the engine. */
export const stopSettled = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* until(
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM stop_targets WHERE stopped_at IS NULL
    `.pipe(
      Effect.orDie,
      Effect.map(([row]) => (row?.n ?? 0) === 0),
    ),
  );
});

/** The kinds of notice the bot's conversation shows, oldest first. */
export const noticesOf = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((found): ReadonlyArray<Notice["_tag"]> =>
        found._tag === "notice" ? [found.notice._tag] : [],
      ),
    ),
  );

let calls = 0;

/** The bot asks the operator, in its running turn, which region to deploy to. */
export const askRegion = (botId: BotId, sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function* () {
    const args = { prompt: "Which region?", options: [{ label: "Europe", value: "eu-west-1" }] };
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "ask",
      input: args,
      recorded: "now",
    });
    yield* (yield* BotTools).call({
      requestId: `call-${++calls}`,
      sessionId,
      tool: "ask",
      arguments: args,
    });
    return yield* awaitEntry(botId, "question");
  });

/** The operator answers the card with its first option. */
export const answerFirstOption = (card: QuestionEntry) =>
  Effect.gen(function* () {
    yield* (yield* Cards).answer({
      commandId: command(),
      entryId: card.id,
      answer: {
        _tag: "question",
        answers: { [card.questions[0].id]: { optionIds: ["option-1"], text: null } },
      },
    });
  });
