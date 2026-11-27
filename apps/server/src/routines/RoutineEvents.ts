// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectorFailure,
  type DeliveryMode,
  type EventRefusal,
  type EventsRefused,
  type EventType,
  type McpEvents,
  type Occurrence,
  type StreamFrame,
  verifyWebhook,
  webhookBodyOf,
} from "@j3-bots/connectors";
import {
  BotId,
  type EventStopReason,
  type EventTrigger,
  RoutineId,
  RoutineTrigger,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ServerConfig } from "../config.ts";
import { Connectors, type EventsOutcome } from "../connectors/Connectors.ts";
import { Entries } from "../entries/Entries.ts";
import { Ids } from "../Ids.ts";
import { ChangeLog } from "../persistence/ChangeLog.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { CatchUpNote } from "../turns/model.ts";
import { Signals } from "../turns/Signals.ts";
import { type EventItem, EventItemJson, EventRunDataJson } from "./eventRuns.ts";
import { RoutineRuns } from "./RoutineRuns.ts";
import { WEBHOOK_PATH } from "./webhook.ts";

/** Where a connector's server posts an event routine's events: `<EVENT_HOOK_PATH>/<token>`. */
export const EVENT_HOOK_PATH = `${WEBHOOK_PATH}/events`;

/** How long a webhook subscription is asked to last; it is renewed before it ends. */
const WEBHOOK_TTL = Duration.hours(1);

/**
 * How long before a webhook subscription would end it is renewed: this, or
 * half of what is left of a shorter one.
 */
const RENEW_AHEAD = Duration.minutes(5);

/** The heartbeat asked of a stream: a stream silent for three of them is open again. */
const HEARTBEAT = Duration.seconds(30);

/** The shortest wait between two polls, whatever the server suggests. */
const POLL_FLOOR = Duration.seconds(1);

/** The wait between two polls when the server suggests none. */
const POLL_DEFAULT = Duration.seconds(30);

/** The most events one poll asks for. */
const POLL_EVENTS = 50;

/**
 * How far back a listener resumes after J3 Bots was not running: events
 * older than this are not asked for again, and the run is told some may have
 * been missed.
 */
const MAX_AGE = Duration.hours(6);

/** How long a listener waits after it could not reach its connector, doubling up to `WAIT_MAX`. */
const WAIT_FIRST = Duration.seconds(5);
const WAIT_MAX = Duration.minutes(5);

/** How long a stream the server closed waits before it opens again. */
const REOPEN_AFTER = Duration.seconds(1);

/** How many times in a row a listener starts again on its event's change before it stops. */
const CHANGES_IN_A_ROW = 3;

/** How often the listeners and the waiting events are looked at with nothing else to wake them. */
const LOOK_EVERY = Duration.minutes(10);

/** How many event ids a routine remembers, to take each event once. */
const SEEN_KEPT = 1_000;

/** How many events wait for a run at most; one past it is dropped, and the run told some were missed. */
const PENDING_KEPT = 100;

/** How many events one run takes at most; the rest wait for the next. */
const RUN_EVENTS = 20;

/**
 * The most characters of payload one run carries, all its events together,
 * so its envelope stays well within what the engine takes. A run always
 * takes the oldest event; the next ones wait while they would pass it.
 */
const RUN_EVENT_CHARACTERS = 48_000;

/** The most characters of one event's payload a run carries. */
const EVENT_DATA_CHARACTERS = 16_000;

/** The bytes of an event webhook's token. */
const TOKEN_BYTES = 32;

/** What answers a delivery to an event webhook's address, as the route sends it. */
export type DeliveryAnswer =
  /** No routine listens there now: the delivery is refused for good. */
  | { readonly _tag: "gone" }
  /** The signature does not hold, or the delivery is too old. */
  | { readonly _tag: "refused" }
  /** The body is not what the extension posts. */
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "taken" }
  /** The server asks the address to prove it wants deliveries. */
  | { readonly _tag: "challenge"; readonly challenge: string };

/** A delivery to an event webhook's address, as the route reads it. */
export interface Delivery {
  readonly token: string;
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly body: Uint8Array;
}

/**
 * The routines that run on a connector's event (MCP's Events extension,
 * `docs/architecture/server.md`, "Event routines"). J3 Bots' server holds
 * every subscription, never a bot: one listener per event routine that is
 * on, which subscribes with the routine's own bot's session of the
 * connector, by webhook when the server has a public HTTPS origin and the
 * event is delivered so, else by a stream it holds open, else by polling.
 * A way that fails gives way to the next. Each event is taken once, by its
 * id; where the listener stands is kept after each, so a restart resumes
 * there, up to `MAX_AGE` back. Events wait in the database and start one run
 * of the routine together once its previous run has ended, within its runs
 * per minute. A listener its server ends or refuses is stopped, which the
 * routine shows, the conversation records and the bot is told at its next
 * turn.
 */
export class RoutineEvents extends Context.Service<
  RoutineEvents,
  {
    /** A delivery to an event webhook's address. */
    readonly delivered: (delivery: Delivery) => Effect.Effect<DeliveryAnswer>;
    /** Looks again at once at which routines listen, and at the events waiting to run. */
    readonly nudge: Effect.Effect<void>;
  }
>()("@j3-bots/server/routines/RoutineEvents") {}

const ListenerRow = Schema.Struct({
  routine_id: RoutineId,
  bot_id: BotId,
  trigger_json: json(RoutineTrigger),
  trigger_key: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  state: Schema.Literals(["listening", "waiting", "stopped"]),
  state_since: Time,
  webhook_token: Schema.NullOr(Schema.String),
  webhook_secret: Schema.NullOr(Schema.String),
});
type ListenerRow = typeof ListenerRow.Type;

/** A listener as its fiber holds it: the routine, and the trigger it listens for. */
interface Listener {
  readonly routineId: RoutineId;
  readonly botId: BotId;
  readonly trigger: EventTrigger;
  readonly key: string;
}

const listenerOf = (row: ListenerRow): Option.Option<Listener> =>
  row.trigger_json._tag === "event"
    ? Option.some({
        routineId: row.routine_id,
        botId: row.bot_id,
        trigger: row.trigger_json,
        key: row.trigger_key,
      })
    : Option.none();

/** Why a listener stops, from its server's refusal; none for one it waits out or starts again on. */
const stopOf = (reason: EventRefusal): Option.Option<EventStopReason> => {
  switch (reason) {
    case "forbidden":
      return Option.some("access-revoked");
    case "invalid":
      return Option.some("refused");
    case "not-offered":
    case "changed":
    case "subscription-gone":
    case "exhausted":
    case "mode-unsupported":
    case "callback-failed":
      return Option.none();
  }
};

/** What a listener does after one way of listening ended. */
type Next =
  | { readonly _tag: "again" }
  | { readonly _tag: "wait" }
  | { readonly _tag: "stop"; readonly reason: EventStopReason }
  /** The event changed under it: listed again, and stopped once it no longer is. */
  | { readonly _tag: "changed" }
  | { readonly _tag: "avoid"; readonly mode: DeliveryMode };

/** What an outcome of the connector's means for a listener using `mode`. */
const nextOf = <A>(outcome: EventsOutcome<A>, mode: DeliveryMode | null): Next => {
  switch (outcome._tag) {
    case "done":
      return { _tag: "again" };
    case "gone":
      return { _tag: "stop", reason: "connector-gone" };
    case "none":
      return { _tag: "stop", reason: "event-gone" };
    case "unavailable":
      return { _tag: "wait" };
    case "refused": {
      const stop = stopOf(outcome.reason);
      if (Option.isSome(stop)) return { _tag: "stop", reason: stop.value };
      switch (outcome.reason) {
        case "mode-unsupported":
        case "callback-failed":
          return mode === null ? { _tag: "wait" } : { _tag: "avoid", mode };
        case "exhausted":
          return { _tag: "wait" };
        default:
          return { _tag: "changed" };
      }
    }
  }
};

const clipped = (text: string) =>
  text.length <= EVENT_DATA_CHARACTERS ? text : `${text.slice(0, EVENT_DATA_CHARACTERS)}…`;

/** An event as it waits for a run: when its server says it happened, or when it arrived. */
const itemOf = (occurrence: Occurrence, now: DateTime.Utc): EventItem => ({
  name: occurrence.name,
  at: Option.getOrElse(Option.map(DateTime.make(occurrence.timestamp), DateTime.toUtc), () => now),
  data: clipped(JSON.stringify(occurrence.data)),
});

/** How long from `now` until `at`, at least `POLL_FLOOR`. */
const waitUntil = (now: DateTime.Utc, at: DateTime.Utc): Duration.Duration =>
  Duration.millis(
    Math.max(
      Duration.toMillis(POLL_FLOOR),
      DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now),
    ),
  );

/** When a webhook subscription that ends at `ends` is renewed. */
const renewalOf = (now: DateTime.Utc, ends: DateTime.Utc): DateTime.Utc => {
  const left = DateTime.toEpochMillis(ends) - DateTime.toEpochMillis(now);
  const ahead = Math.min(Duration.toMillis(RENEW_AHEAD), left / 2);
  return DateTime.subtractDuration(ends, Duration.millis(Math.max(0, ahead)));
};

/** An event waiting for a run, as `drain` reads it: none when this server cannot read it. */
interface Waiting {
  readonly id: number;
  readonly item: Option.Option<EventItem>;
}

/**
 * The oldest waiting events whose payloads fit one run together, always the
 * first that can be read. One that cannot be read takes no room: the run is
 * told some were missed.
 */
const fitting = (waiting: ReadonlyArray<Waiting>): ReadonlyArray<Waiting> => {
  let total = 0;
  let readable = 0;
  const taken: Array<Waiting> = [];
  for (const one of waiting) {
    if (Option.isSome(one.item)) {
      total += one.item.value.data.length;
      if (readable > 0 && total > RUN_EVENT_CHARACTERS) break;
      readable++;
    }
    taken.push(one);
  }
  return taken;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

const encodeItem = Schema.encodeEffect(EventItemJson);
const decodeItem = Schema.decodeUnknownOption(EventItemJson);
const encodeRun = Schema.encodeEffect(EventRunDataJson);
const encodeNote = Schema.encodeEffect(json(CatchUpNote));

export const layer = Layer.effect(
  RoutineEvents,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const connectors = yield* Connectors;
    const runs = yield* RoutineRuns;
    const changes = yield* ChangeLog;
    const entries = yield* Entries;
    const ids = yield* Ids;
    const signals = yield* Signals;
    const random = yield* SecureRandom.SecureRandom;
    const { publicOrigin } = yield* ServerConfig;
    const nudges = yield* Queue.sliding<void>(1);
    const nudge = Queue.offer(nudges, undefined).pipe(Effect.asVoid);
    const fibers = yield* FiberMap.make<RoutineId>();
    /** The trigger each running listener listens for, by routine. */
    const running = new Map<RoutineId, string>();
    /** The listeners to start again at the next look, their server having ended their subscription. */
    const restarts = new Set<RoutineId>();

    /** Where a webhook is posted: only at a public HTTPS origin, which servers on the internet reach. */
    const webhookOrigin = Option.filter(publicOrigin, (origin) => origin.startsWith("https://"));

    const listenerRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ListenerRow,
      execute: () => sql`
        SELECT l.routine_id, r.bot_id, r.trigger_json, l.trigger_key, l.cursor, l.state,
          l.state_since, l.webhook_token, l.webhook_secret
        FROM routine_event_listeners l JOIN routines r ON r.id = l.routine_id
        WHERE r.enabled = 1 AND l.state <> 'stopped'
      `,
    });

    const listenerRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ routineId: RoutineId, key: Schema.String }),
      Result: ListenerRow,
      execute: ({ routineId, key }) => sql`
        SELECT l.routine_id, r.bot_id, r.trigger_json, l.trigger_key, l.cursor, l.state,
          l.state_since, l.webhook_token, l.webhook_secret
        FROM routine_event_listeners l JOIN routines r ON r.id = l.routine_id
        WHERE l.routine_id = ${routineId} AND l.trigger_key = ${key}
          AND r.enabled = 1 AND l.state <> 'stopped'
      `,
    });

    const tokenRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ListenerRow,
      execute: (token) => sql`
        SELECT l.routine_id, r.bot_id, r.trigger_json, l.trigger_key, l.cursor, l.state,
          l.state_since, l.webhook_token, l.webhook_secret
        FROM routine_event_listeners l JOIN routines r ON r.id = l.routine_id
        WHERE l.webhook_token = ${token} AND r.enabled = 1 AND l.state <> 'stopped'
      `,
    });

    /** Whether the listener's bot may still use its connector. */
    const granted = (listener: Listener) =>
      connectors.granted({ botId: listener.botId, connectorId: listener.trigger.connectorId });

    /** The listener's row while it still listens for its trigger: a change since makes it stale. */
    const current = (listener: Listener) =>
      listenerRow({ routineId: listener.routineId, key: listener.key }).pipe(Effect.orDie);

    /** Moves a listener that still listens for its trigger to `state`, recorded as the routine's change. */
    const setState = Effect.fn("RoutineEvents.setState")(function* (
      listener: Listener,
      state: "listening" | "waiting",
    ) {
      yield* transaction(
        Effect.gen(function* () {
          const row = yield* current(listener);
          if (Option.isNone(row) || row.value.state === state) return;
          const at = timeText(yield* DateTime.now);
          yield* sql`
            UPDATE routine_event_listeners
            SET state = ${state}, state_since = ${at}, updated_at = ${at}
            WHERE routine_id = ${listener.routineId}
          `;
          yield* changes.record({ _tag: "routines", botId: listener.botId }, listener.routineId);
        }),
      ).pipe(Effect.orDie);
    });

    /**
     * Takes what arrived for a listener, in one transaction: each event once,
     * by its id, kept to wait for a run; where the listener now stands; and
     * whether some may have been missed. A listener whose routine changed
     * since takes nothing, and one whose bot may no longer use the connector
     * stops: a stream or a webhook made before the operator took it away
     * wakes the bot with nothing.
     */
    const accept = Effect.fn("RoutineEvents.accept")(function* (
      listener: Listener,
      arrived: {
        readonly occurrences: ReadonlyArray<Occurrence>;
        readonly cursor: string | null;
        readonly missed: boolean;
      },
    ) {
      if (!(yield* granted(listener))) return yield* stop(listener, "connector-gone");
      const taken = yield* transaction(
        Effect.gen(function* () {
          const row = yield* current(listener);
          if (Option.isNone(row)) return false;
          const now = yield* DateTime.now;
          const at = timeText(now);
          let missed = arrived.missed;
          let fresh = 0;
          for (const occurrence of arrived.occurrences) {
            const seen = yield* sql`
              INSERT INTO routine_event_seen (routine_id, event_id, seen_at)
              VALUES (${listener.routineId}, ${occurrence.eventId}, ${at})
              ON CONFLICT DO NOTHING
              RETURNING event_id
            `;
            if (seen.length === 0) continue;
            const [waiting] = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM routine_event_pending
              WHERE routine_id = ${listener.routineId}
            `;
            if ((waiting?.count ?? 0) >= PENDING_KEPT) {
              missed = true;
              continue;
            }
            yield* sql`
              INSERT INTO routine_event_pending (routine_id, occurrence_json, received_at)
              VALUES (
                ${listener.routineId}, ${yield* encodeItem(itemOf(occurrence, now))}, ${at}
              )
            `;
            fresh++;
          }
          if (arrived.occurrences.length > 0) {
            yield* sql`
              DELETE FROM routine_event_seen
              WHERE routine_id = ${listener.routineId} AND event_id NOT IN (
                SELECT event_id FROM routine_event_seen WHERE routine_id = ${listener.routineId}
                ORDER BY seen_at DESC, rowid DESC LIMIT ${SEEN_KEPT}
              )
            `;
          }
          yield* sql`
            UPDATE routine_event_listeners
            SET cursor = COALESCE(${arrived.cursor}, cursor),
              missed = MAX(missed, ${missed ? 1 : 0}), updated_at = ${at}
            WHERE routine_id = ${listener.routineId}
          `;
          return fresh > 0;
        }),
      ).pipe(Effect.orDie);
      if (taken) yield* nudge;
    });

    /**
     * Stops a listener that still listens for its trigger, for `reason`: the
     * routine shows why, its conversation records it, and the bot is told at
     * its next turn. The events still waiting are dropped.
     */
    const stop = Effect.fn("RoutineEvents.stop")(function* (
      listener: Listener,
      reason: EventStopReason,
    ) {
      yield* transaction(
        Effect.gen(function* () {
          if (Option.isNone(yield* current(listener))) return;
          const now = yield* DateTime.now;
          const at = timeText(now);
          yield* sql`
            UPDATE routine_event_listeners
            SET state = 'stopped', stop_reason = ${reason}, state_since = ${at},
              webhook_token = NULL, webhook_secret = NULL, subscription_id = NULL,
              refresh_before = NULL, updated_at = ${at}
            WHERE routine_id = ${listener.routineId}
          `;
          yield* sql`DELETE FROM routine_event_pending WHERE routine_id = ${listener.routineId}`;
          yield* changes.record({ _tag: "routines", botId: listener.botId }, listener.routineId);
          const [named] = yield* sql<{ readonly name: string; readonly connector: string | null }>`
            SELECT r.name, (SELECT c.name FROM connectors c WHERE c.id = ${listener.trigger.connectorId})
              AS connector
            FROM routines r WHERE r.id = ${listener.routineId}
          `;
          if (named === undefined) return;
          const entry = yield* entries.append({
            target: { _tag: "conversation", botId: listener.botId },
            entry: {
              _tag: "event-routine-change",
              author: { _tag: "system" },
              routineId: listener.routineId,
              name: named.name,
              change: "stopped",
              trigger: listener.trigger,
              connector: named.connector,
              stopped: reason,
            },
          });
          const note = {
            _tag: "routine-stopped",
            routine: named.name,
            routineId: listener.routineId,
            connector: named.connector ?? "a removed connector",
            at: now,
            reason,
          } as const;
          yield* sql`
            INSERT INTO catch_up_notes (id, bot_id, text, created_at, note_json, source_position)
            VALUES (
              ${yield* ids.make("note")}, ${listener.botId}, ${named.name}, ${at},
              ${yield* encodeNote(note)},
              (SELECT position FROM entries WHERE id = ${entry.id})
            )
          `;
        }),
      ).pipe(Effect.orDie);
      yield* nudge;
    });

    /** Has the next look start a running listener again, from where it stands. */
    const restart = (listener: Listener) =>
      Effect.sync(() => {
        if (running.get(listener.routineId) === listener.key) restarts.add(listener.routineId);
      }).pipe(Effect.andThen(nudge));

    /** The position a listener asks from: where it stood, or now, and no further back than `MAX_AGE`. */
    const positionOf = (listener: Listener) =>
      Effect.map(current(listener), (row) => ({
        cursor: Option.getOrNull(
          Option.flatMap(row, (found) => Option.fromNullishOr(found.cursor)),
        ),
        maxAgeMs: Duration.toMillis(MAX_AGE),
      }));

    const requestOf = (type: EventType, listener: Listener) => ({
      type,
      arguments: listener.trigger.arguments,
    });

    const withEvents = <A>(
      listener: Listener,
      use: (events: McpEvents) => Effect.Effect<A, ConnectorFailure | EventsRefused>,
    ) =>
      connectors.withEvents({
        botId: listener.botId,
        connectorId: listener.trigger.connectorId,
        use,
      });

    /** Polls until the connector answers otherwise: each answer taken, the server's pace kept. */
    const poll = Effect.fn("RoutineEvents.poll")(function* (listener: Listener, type: EventType) {
      for (;;) {
        const position = yield* positionOf(listener);
        const outcome = yield* withEvents(listener, (events) =>
          events.poll({ ...requestOf(type, listener), ...position, maxEvents: POLL_EVENTS }),
        );
        if (outcome._tag !== "done") return nextOf(outcome, "poll");
        const answer = outcome.value;
        yield* setState(listener, "listening");
        yield* accept(listener, {
          occurrences: answer.events,
          cursor: answer.cursor,
          missed: answer.truncated,
        });
        if (answer.hasMore) continue;
        yield* Effect.sleep(
          Duration.max(
            POLL_FLOOR,
            answer.nextPollMs === null ? POLL_DEFAULT : Duration.millis(answer.nextPollMs),
          ),
        );
      }
    });

    /**
     * Holds the event's stream open, taking each frame as it arrives, until
     * it ends. A stream that never opened, when the event is also polled,
     * gives way to polls: something between J3 Bots and the server (a proxy
     * that holds a response until it ends) may keep it from ever arriving.
     */
    const push = Effect.fn("RoutineEvents.push")(function* (listener: Listener, type: EventType) {
      const position = yield* positionOf(listener);
      let opened = false;
      const frame = (received: StreamFrame): Effect.Effect<void> => {
        opened = true;
        switch (received._tag) {
          case "active":
            return setState(listener, "listening").pipe(
              Effect.andThen(
                accept(listener, {
                  occurrences: [],
                  cursor: received.cursor,
                  missed: received.truncated,
                }),
              ),
            );
          case "event":
            return accept(listener, {
              occurrences: [received.occurrence],
              cursor: received.occurrence.cursor,
              missed: false,
            });
          case "heartbeat":
            return accept(listener, { occurrences: [], cursor: received.cursor, missed: false });
          case "missed":
            return accept(listener, { occurrences: [], cursor: null, missed: true });
          case "terminated":
            // The stream fails with the server's reason, which the listener acts on.
            return Effect.void;
        }
      };
      const outcome = yield* withEvents(listener, (events) =>
        events.stream(
          { ...requestOf(type, listener), ...position, heartbeatMs: Duration.toMillis(HEARTBEAT) },
          frame,
        ),
      );
      if (outcome._tag === "done") yield* Effect.sleep(REOPEN_AFTER);
      if (outcome._tag === "unavailable" && !opened && type.delivery.includes("poll")) {
        return { _tag: "avoid", mode: "push" } satisfies Next;
      }
      return nextOf(outcome, "push");
    });

    /**
     * The listener's webhook: its address and secret, drawn once and kept
     * with it, so the server's verification, which arrives before the
     * subscription is answered, finds them.
     */
    const webhookOf = Effect.fn("RoutineEvents.webhookOf")(function* (
      listener: Listener,
      origin: string,
    ) {
      const row = yield* current(listener);
      if (Option.isNone(row)) return Option.none();
      const { webhook_token: token, webhook_secret: secret } = row.value;
      if (token !== null && secret !== null) {
        return Option.some({ url: `${origin}${EVENT_HOOK_PATH}/${token}`, secret });
      }
      const drawn = Base64Url.encode(yield* random.randomBytes(TOKEN_BYTES));
      const signing = `whsec_${Base64.encode(yield* random.randomBytes(32))}`;
      yield* sql`
        UPDATE routine_event_listeners
        SET webhook_token = ${drawn}, webhook_secret = ${signing}
        WHERE routine_id = ${listener.routineId} AND trigger_key = ${listener.key}
      `.pipe(Effect.orDie);
      return Option.some({ url: `${origin}${EVENT_HOOK_PATH}/${drawn}`, secret: signing });
    });

    /**
     * Has the server post the event to the listener's address, renewed
     * before it ends, for as long as it is asked to listen; once it is not,
     * the server is asked to stop.
     */
    const webhook = Effect.fn("RoutineEvents.webhook")(function* (
      listener: Listener,
      type: EventType,
      origin: string,
    ) {
      const address = yield* webhookOf(listener, origin);
      if (Option.isNone(address)) return { _tag: "again" } satisfies Next;
      const { url, secret } = address.value;
      const unsubscribe = withEvents(listener, (events) =>
        events
          .unsubscribe({ ...requestOf(type, listener), url })
          .pipe(Effect.catchTag("EventsRefused", () => Effect.void)),
      ).pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
      return yield* Effect.gen(function* () {
        for (;;) {
          const position = yield* positionOf(listener);
          const outcome = yield* withEvents(listener, (events) =>
            events.subscribe({
              ...requestOf(type, listener),
              ...position,
              url,
              secret: Redacted.make(secret),
              ttlMs: Duration.toMillis(WEBHOOK_TTL),
            }),
          );
          if (outcome._tag !== "done") return nextOf(outcome, "webhook");
          const answer = outcome.value;
          const now = yield* DateTime.now;
          yield* sql`
            UPDATE routine_event_listeners
            SET subscription_id = ${answer.id},
              refresh_before = ${
                answer.refreshBefore === null
                  ? null
                  : timeText(DateTime.makeUnsafe(answer.refreshBefore))
              }
            WHERE routine_id = ${listener.routineId} AND trigger_key = ${listener.key}
          `.pipe(Effect.orDie);
          yield* setState(listener, "listening");
          yield* accept(listener, {
            occurrences: [],
            cursor: answer.cursor,
            missed: answer.truncated,
          });
          const ends =
            answer.refreshBefore === null
              ? DateTime.addDuration(now, WEBHOOK_TTL)
              : DateTime.makeUnsafe(answer.refreshBefore);
          yield* Effect.sleep(waitUntil(now, renewalOf(now, ends)));
        }
      }).pipe(Effect.onInterrupt(() => unsubscribe));
    });

    /** The event's type as its server lists it now, or what the listener does instead. */
    const listedType = Effect.fn("RoutineEvents.listedType")(function* (
      listener: Listener,
    ): Effect.fn.Return<{ readonly type: EventType } | { readonly next: Next }> {
      const listed = yield* withEvents(listener, (events) => events.list);
      if (listed._tag !== "done") return { next: nextOf(listed, null) };
      const type = listed.value.find((offered) => offered.name === listener.trigger.name);
      return type === undefined ? { next: { _tag: "stop", reason: "event-gone" } } : { type };
    });

    /** The way to listen for `type`: by webhook, then a stream, then polls, leaving out those that failed. */
    const modeOf = (
      type: EventType,
      avoid: ReadonlySet<DeliveryMode>,
    ): Option.Option<DeliveryMode> => {
      const offered = (mode: DeliveryMode) => type.delivery.includes(mode) && !avoid.has(mode);
      if (Option.isSome(webhookOrigin) && offered("webhook")) return Option.some("webhook");
      if (offered("push")) return Option.some("push");
      if (offered("poll")) return Option.some("poll");
      return Option.none();
    };

    /** One listener, for as long as its routine listens for its trigger. */
    const listen = Effect.fn("RoutineEvents.listen")(function* (listener: Listener) {
      const avoid = new Set<DeliveryMode>();
      let wait = WAIT_FIRST;
      let changedInARow = 0;
      for (;;) {
        const found = yield* listedType(listener);
        let next: Next;
        if ("next" in found) {
          next = found.next;
        } else {
          const mode = modeOf(found.type, avoid);
          if (Option.isNone(mode)) {
            next = { _tag: "stop", reason: "refused" };
          } else {
            switch (mode.value) {
              case "webhook":
                next = Option.isSome(webhookOrigin)
                  ? yield* webhook(listener, found.type, webhookOrigin.value)
                  : { _tag: "avoid", mode: "webhook" };
                break;
              case "push":
                next = yield* push(listener, found.type);
                break;
              case "poll":
                next = yield* poll(listener, found.type);
                break;
            }
          }
        }
        switch (next._tag) {
          case "stop":
            return yield* stop(listener, next.reason);
          case "avoid":
            avoid.add(next.mode);
            break;
          case "changed":
            changedInARow++;
            if (changedInARow >= CHANGES_IN_A_ROW) return yield* stop(listener, "event-gone");
            yield* Effect.sleep(wait);
            wait = Duration.min(Duration.times(wait, 2), WAIT_MAX);
            break;
          case "wait":
            yield* setState(listener, "waiting");
            yield* Effect.sleep(wait);
            wait = Duration.min(Duration.times(wait, 2), WAIT_MAX);
            break;
          case "again":
            changedInARow = 0;
            wait = WAIT_FIRST;
            break;
        }
      }
    });

    /** Starts a listener for every event routine that is on and has none, and ends those no longer asked for. */
    const reconcile = Effect.gen(function* () {
      const wanted = new Map<RoutineId, Listener>();
      for (const row of yield* listenerRows(undefined).pipe(Effect.orDie)) {
        const listener = listenerOf(row);
        if (Option.isNone(listener)) continue;
        // A connector removed or taken from the bot stops its routines now,
        // not when a listener next asks it.
        if (!(yield* granted(listener.value))) yield* stop(listener.value, "connector-gone");
        else wanted.set(row.routine_id, listener.value);
      }
      // Taken now: one asked for while this look goes on waits for the next.
      const restarting = new Set(restarts);
      restarts.clear();
      for (const [routineId, key] of running) {
        if (
          !restarting.has(routineId) &&
          wanted.get(routineId)?.key === key &&
          (yield* FiberMap.has(fibers, routineId))
        )
          continue;
        running.delete(routineId);
        yield* FiberMap.remove(fibers, routineId);
      }
      for (const [routineId, listener] of wanted) {
        if (running.has(routineId)) continue;
        running.set(routineId, listener.key);
        yield* FiberMap.run(
          fibers,
          routineId,
          listen(listener).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("An event routine's listener failed; it starts again", cause),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (running.get(routineId) === listener.key) running.delete(routineId);
              }),
            ),
          ),
        );
      }
    });

    /**
     * Starts a run of each routine with events waiting whose previous run
     * has ended: the oldest waiting, up to `RUN_EVENTS` and as many as fit
     * `RUN_EVENT_CHARACTERS`, together. When a
     * routine is past its runs per minute, when it may run again.
     */
    const drain = Effect.gen(function* () {
      const waiting = yield* sql<{ readonly routine_id: string }>`
        SELECT DISTINCT p.routine_id FROM routine_event_pending p
        JOIN routines r ON r.id = p.routine_id WHERE r.enabled = 1
      `;
      let retry: DateTime.Utc | null = null;
      for (const { routine_id } of waiting) {
        const routineId = RoutineId.make(routine_id);
        const limited = yield* transaction(
          Effect.gen(function* () {
            const [routine] = yield* sql<{ readonly bot_id: string; readonly missed: number }>`
              SELECT r.bot_id, l.missed FROM routines r
              JOIN routine_event_listeners l ON l.routine_id = r.id
              WHERE r.id = ${routineId} AND r.enabled = 1
            `;
            if (routine === undefined) return Option.none<DateTime.Utc>();
            const pending = yield* sql<{ readonly id: number; readonly occurrence_json: string }>`
              SELECT id, occurrence_json FROM routine_event_pending
              WHERE routine_id = ${routineId} ORDER BY id LIMIT ${RUN_EVENTS}
            `;
            const taken = fitting(
              pending.map((row) => ({ id: row.id, item: decodeItem(row.occurrence_json) })),
            );
            if (taken.length === 0) return Option.none<DateTime.Utc>();
            const items = taken.flatMap((one) => Option.toArray(one.item));
            const body = yield* encodeRun({
              events: items,
              // An event this server cannot read counts as one missed.
              missed: routine.missed === 1 || items.length < taken.length,
            });
            const started = yield* runs.events(
              { id: routineId, botId: BotId.make(routine.bot_id) },
              body,
            );
            switch (started._tag) {
              case "busy":
                return Option.none<DateTime.Utc>();
              case "limited":
                return Option.some(started.until);
              case "started":
                yield* sql`
                  DELETE FROM routine_event_pending
                  WHERE ${sql.in(
                    "id",
                    taken.map((one) => one.id),
                  )}
                `;
                yield* sql`UPDATE routine_event_listeners SET missed = 0 WHERE routine_id = ${routineId}`;
                yield* sql.afterCommit(signals.routines.fire);
                return Option.none<DateTime.Utc>();
            }
          }),
        );
        if (
          Option.isSome(limited) &&
          (retry === null || DateTime.isLessThan(limited.value, retry))
        ) {
          retry = limited.value;
        }
      }
      return retry;
    }).pipe(Effect.orDie);

    const delivered = Effect.fn("RoutineEvents.delivered")(function* (delivery: Delivery) {
      const row = yield* tokenRow(delivery.token).pipe(Effect.orDie);
      if (Option.isNone(row) || row.value.webhook_secret === null) {
        return { _tag: "gone" } satisfies DeliveryAnswer;
      }
      const now = yield* DateTime.now;
      const refused = verifyWebhook({
        secret: row.value.webhook_secret,
        id: delivery.id,
        timestamp: delivery.timestamp,
        signature: delivery.signature,
        body: delivery.body,
        nowSeconds: Math.floor(DateTime.toEpochMillis(now) / 1000),
      });
      if (Option.isSome(refused)) return { _tag: "refused" } satisfies DeliveryAnswer;
      const listener = listenerOf(row.value);
      const text = Result.try(() => decoder.decode(delivery.body));
      const body = Result.isSuccess(text) ? webhookBodyOf(text.success) : Option.none();
      if (Option.isNone(listener) || Option.isNone(body)) {
        return { _tag: "unreadable" } satisfies DeliveryAnswer;
      }
      switch (body.value._tag) {
        case "verification":
          return { _tag: "challenge", challenge: body.value.challenge } satisfies DeliveryAnswer;
        case "event":
          yield* accept(listener.value, {
            occurrences: [body.value.occurrence],
            cursor: body.value.occurrence.cursor,
            missed: false,
          });
          break;
        case "gap":
          yield* accept(listener.value, {
            occurrences: [],
            cursor: body.value.cursor,
            missed: true,
          });
          break;
        case "terminated": {
          // The server ended the subscription: the listener stops for a
          // refusal that names why, and otherwise lists the event again and
          // listens anew, as a stream that ends so does.
          const reason = stopOf(body.value.reason);
          if (Option.isSome(reason)) yield* stop(listener.value, reason.value);
          else yield* restart(listener.value);
          break;
        }
      }
      return { _tag: "taken" } satisfies DeliveryAnswer;
    });

    const changed = yield* changes.subscribe;
    yield* Stream.fromSubscription(changed).pipe(
      Stream.filter((scope) => scope._tag === "routines"),
      Stream.runForEach(() => nudge),
      Effect.forkScoped,
    );
    // A bot gains or loses a connector, or one is removed.
    yield* connectors.toolsChanged.pipe(
      Stream.runForEach(() => nudge),
      Effect.forkScoped,
    );

    // A look at the listeners and the waiting events after every change of
    // routines, when a routine may run again, and every `LOOK_EVERY`.
    yield* Effect.gen(function* () {
      yield* Queue.poll(nudges);
      yield* reconcile;
      const retry = yield* drain;
      const now = yield* DateTime.now;
      const until = retry === null ? LOOK_EVERY : Duration.min(LOOK_EVERY, waitUntil(now, retry));
      // Woken by a nudge, or once `until` passes.
      yield* Queue.take(nudges).pipe(Effect.timeout(until), Effect.ignore);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          "Event routines could not be looked at; they are looked at again",
          cause,
        ).pipe(Effect.andThen(Effect.sleep(WAIT_FIRST))),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return RoutineEvents.of({ delivered, nudge });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
