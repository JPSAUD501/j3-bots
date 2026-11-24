// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  CommandId,
  type EntryTarget,
  type RoomId,
  type Entry,
  type EntryId,
  EntryOrder,
  type MessageDelivery,
  type ModelChoice,
  type Notice,
  PositiveInt,
  type ProviderId,
  type ProviderStatus,
  type QuestionEntry,
} from "@j3-bots/contracts";
import { type IdempotencyKey, SessionId, TurnId } from "@j3-bots/engine-t3";
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
import { EngineState } from "../engine/EngineState.ts";
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
import { TestProviders } from "./domain.ts";

let commands = 0;
/** A fresh operator command id. */
export const command = () => CommandId.make(`command-${++commands}`);

/**
 * A bot just created, on `model` or the default one: its `first-run` wake is
 * pending, its first turn not begun.
 */
export const createNewBot = (name: string, model?: ModelChoice) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    yield* TestClock.adjust("1 second");
    return yield* bots.create({
      commandId: command(),
      draft: model === undefined ? { name, job: "" } : { name, job: "", model },
    });
  });

const sameStatus = (a: ProviderStatus["status"], b: ProviderStatus["status"]) =>
  a._tag === b._tag &&
  (a._tag !== "unavailable" || b._tag !== "unavailable" || a.checking === b.checking);

/** The engine reports the provider in `status` from now on, and the server has taken it in. */
export const providerIs = (providerId: ProviderId, status: ProviderStatus["status"]) =>
  Effect.gen(function* () {
    yield* (yield* TestProviders).setStatus(providerId, status);
    const engineState = yield* EngineState;
    yield* until(
      engineState.current.pipe(
        Effect.map((now) =>
          now.providers.some(
            (provider) => provider.id === providerId && sameStatus(provider.status, status),
          ),
        ),
      ),
    );
  });

/** The engine lists these models of the provider from now on, and the server has taken them in. */
export const providerLists = (providerId: ProviderId, models: ProviderStatus["models"]) =>
  Effect.gen(function* () {
    yield* (yield* TestProviders).setModels(providerId, models);
    const engineState = yield* EngineState;
    yield* until(
      engineState.current.pipe(
        Effect.map((now) =>
          now.providers.some(
            (provider) =>
              provider.id === providerId &&
              provider.models.length === models.length &&
              provider.models.every((model, index) => model.id === models[index]?.id),
          ),
        ),
      ),
    );
  });

/** The opening dispatch of each bot `createBot` made, which `received` leaves out. */
const openings = new Set<IdempotencyKey>();

/**
 * A bot past its first turn, the one its `first-run` wake starts, which ends
 * without a word: what most tests begin with, an empty conversation and an
 * idle session.
 */
export const createBot = (name: string, model?: ModelChoice) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const bot = yield* createNewBot(name, model);
    const session = yield* engineSession(bot.id);
    const turnId = yield* nextTurn(bot.id);
    const [opening, ...more] = yield* control.dispatches(session);
    if (opening === undefined || more.length > 0) {
      return yield* Effect.die(new Error("A new bot's session got something besides its opening"));
    }
    openings.add(opening.key);
    yield* control.finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(bot.id);
    return bot;
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

/** Waits for the bot's main session to be one other than `previous`, opened in the engine. */
export const sessionAfter = (botId: BotId, previous: SessionId) =>
  eventually(
    sessionRow(botId).pipe(
      Effect.map((row) =>
        Option.flatMap(row, (found) => Option.fromNullishOr(found.engine_session_id)).pipe(
          Option.filter((id) => id !== previous),
        ),
      ),
    ),
  );

/**
 * Waits for whatever holds the bot's session gate (a send, a Stop round, a
 * resume) to finish what it started.
 */
export const gateSettled = (botId: BotId) =>
  Effect.gen(function* () {
    // A bot between a retired main session and the next has no gate to wait for.
    const row = yield* sessionRow(botId);
    if (Option.isSome(row)) yield* (yield* SessionGate).run(row.value.id)(Effect.void);
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

/**
 * The bot's next turn says it is done and ends, so no `undelivered` wake
 * follows it.
 */
export const finishRunning = (botId: BotId, previous: Parameters<typeof nextTurn>[1] = null) =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const session = yield* engineSession(botId);
    const turnId = yield* nextTurn(botId, previous);
    const args = { text: "Done.", done: true };
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
    return turnId;
  });

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

/** The target's entries, oldest first. */
const history = (target: EntryTarget) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    const page = yield* entries.history({
      target,
      before: EntryOrder.make(Number.MAX_SAFE_INTEGER),
      limit: 500,
    });
    return page.entries;
  });

/** The bot's conversation, oldest first. */
export const conversation = (botId: BotId) => history({ _tag: "conversation", botId });

/** The room's entries, oldest first. */
export const roomEntries = (roomId: RoomId) => history({ _tag: "room", roomId });

const entry = (entryId: EntryId) =>
  Effect.gen(function* () {
    const found = yield* (yield* Entries).find(entryId);
    return Option.getOrThrow(found).entry;
  });

/** The message's delivery as it stands, or `null` for an entry that is no message. */
export const delivery = (entryId: EntryId) =>
  entry(entryId).pipe(
    Effect.map((found): MessageDelivery | null =>
      found._tag === "message" ? found.delivery : null,
    ),
  );

/** The teammate messages the bot's conversation shows, oldest first. */
export const handoffs = (botId: BotId) =>
  conversation(botId).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) =>
        entry._tag === "handoff" ? [`${entry.direction}: ${entry.text}`] : [],
      ),
    ),
  );

/** How many teammate wakes and held teammate messages the bot has, cancelled ones left out. */
export const teammateMessagesFor = (botId: BotId) =>
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

/** Waits for the message to reach `tag`. */
export const deliveryIs = (entryId: EntryId, tag: MessageDelivery["_tag"]) =>
  until(delivery(entryId).pipe(Effect.map((found) => found?._tag === tag)));

/** Waits for the message to fail for `reason`. */
export const failedAs = (
  entryId: EntryId,
  reason: Extract<MessageDelivery, { readonly _tag: "failed" }>["reason"],
) =>
  until(
    delivery(entryId).pipe(
      Effect.map((found) => found?._tag === "failed" && found.reason === reason),
    ),
  );

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

/**
 * What the engine applied to the session, oldest first, leaving out the
 * opening `createBot` ran: the work a test gave it. Any other opening, such as
 * a second hello, shows.
 */
export const received = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const all = yield* (yield* TestEngineControl).dispatches(sessionId);
    return all.filter((dispatch) => !openings.has(dispatch.key));
  });

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

/** The operator writes in a room, mentioning the bot, which wakes it for the room. */
export const sendInRoom = (botId: BotId, roomId: RoomId, text: string) =>
  Effect.gen(function* () {
    const pipeline = yield* Pipeline;
    const entryId = yield* pipeline.sendMessage({
      commandId: command(),
      target: { _tag: "room", roomId },
      text,
      attachments: [],
      mentions: { _tag: "bots", ids: [botId] },
    });
    yield* pipeline.dispatchPending;
    return entryId;
  });

/** The operator writes to the bot with a file attached. */
export const sendWithFile = (botId: BotId, text: string, name = "notes.txt") =>
  Effect.gen(function* () {
    const file = yield* (yield* Attachments).store({
      name,
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

/**
 * Sends the bot a message with a text file of each name, in that order, placed
 * in the text at `offsets` when given.
 */
export const sendWithFiles = (
  botId: BotId,
  text: string,
  names: ReadonlyArray<string>,
  offsets?: ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    const attachments = yield* Attachments;
    const files = yield* Effect.forEach(names, (name) =>
      attachments.store({
        name,
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(name),
      }),
    );
    return yield* (yield* Pipeline).sendMessage({
      commandId: command(),
      target: { _tag: "conversation", botId },
      text,
      attachments: files.map((file) => file.id),
      ...(offsets === undefined ? {} : { attachmentOffsets: offsets }),
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
      { zoneChosen: false },
    );
  });

/** Bot-caused wakes stop after `hops` in a chain; one bot turn messages at most `fanOut` teammates. */
export const chainLimits = (limits: { readonly hops: number; readonly fanOut: number }) =>
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const settings = yield* store.get;
    yield* store.save(
      {
        ...settings,
        budgets: {
          ...settings.budgets,
          hops: PositiveInt.make(limits.hops),
          fanOut: PositiveInt.make(limits.fanOut),
        },
      },
      yield* DateTime.now,
      { zoneChosen: false },
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

/**
 * The bot asks the operator, in its running turn, which region to deploy to;
 * with `allowCustom`, a typed answer is taken too.
 */
export const askRegion = (
  botId: BotId,
  sessionId: SessionId,
  turnId: TurnId,
  allowCustom = false,
) =>
  Effect.gen(function* () {
    const args = {
      prompt: "Which region?",
      options: [{ label: "Europe", value: "eu-west-1" }],
      allow_custom: allowCustom,
    };
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

/**
 * The bot, in its running turn, sends the teammate `to` a message: the
 * response the tool gives it.
 */
export const messageTeammate = (
  sessionId: SessionId,
  turnId: TurnId,
  message: { readonly to: string; readonly text: string; readonly urgent: boolean },
) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "message_bot",
      input: message,
      recorded: "now",
    });
    return yield* (yield* BotTools).call({
      requestId: `call-${++calls}`,
      sessionId,
      tool: "message_bot",
      arguments: { ...message },
    });
  });

/**
 * In one turn the operator started, which ends after them, `sender` sends
 * each teammate its message, held for the teammate's next turn.
 */
export const heldForTeammates = (
  sender: BotId,
  messages: ReadonlyArray<{ readonly to: BotId; readonly text: string }>,
) =>
  Effect.gen(function* () {
    const session = yield* engineSession(sender);
    yield* sendToBot(sender, "Pass it on.");
    const turnId = yield* nextTurn(sender);
    for (const { to, text } of messages) {
      const reply = yield* messageTeammate(session, turnId, { to, text, urgent: false });
      if (reply._tag !== "result")
        return yield* Effect.die(new Error("A teammate message was refused"));
    }
    yield* (yield* TestEngineControl).finishTurn({
      sessionId: session,
      turnId,
      outcome: { _tag: "completed" },
    });
    yield* turnEnded(sender);
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
