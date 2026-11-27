// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  type Delivered,
  type EventsFakeOptions,
  sdkHttpServer,
} from "@j3-bots/connectors/testing/sdk";
import {
  type BotId,
  CommandId,
  type Connector,
  ConnectorId,
  type Routine,
  type RoutineId,
  ServerOrigin,
} from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { Bots } from "../bots/Bots.ts";
import { ServerConfig } from "../config.ts";
import { Connectors } from "../connectors/Connectors.ts";
import { connectorSecretIdOf } from "../connectors/credentials.ts";
import * as Domain from "../domain.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import { json } from "../persistence/columns.ts";
import { CatchUpNote } from "../turns/model.ts";
import { EventItemJson, EventRunDataJson } from "./eventRuns.ts";
import { type DeliveryAnswer, EVENT_HOOK_PATH, RoutineEvents } from "./RoutineEvents.ts";
import { Routines } from "./Routines.ts";

/**
 * Routines on a connector's event (`RoutineEvents.ts`), against a fake MCP
 * server on loopback that offers events beside the SDK's own, in each way an
 * event is delivered: polled, streamed, and posted to J3 Bots' webhook, which
 * here reaches the server's own receiver in place of the network.
 */

const ID = ConnectorId.make("conn_mail000000000000");
const NAME = "email.received";
const PUBLIC = ServerOrigin.make("https://j3.example");

const typeWith = (delivery: ReadonlyArray<string>): Schema.JsonObject => ({
  name: NAME,
  description: "A new email arrived.",
  delivery: [...delivery],
  inputSchema: { type: "object", properties: { from: { type: "string" } } },
  payloadSchema: { type: "object", properties: { subject: { type: "string" } } },
});

/** The server as it runs at home: no public origin, so no webhook. */
const atHome = Domain.layer.pipe(Layer.provide(reachFakes));

/** The server behind a public HTTPS origin, which a connector's server can post to. */
const published = Domain.layer.pipe(
  Layer.updateService(ServerConfig, (config) => ({ ...config, publicOrigin: Option.some(PUBLIC) })),
  Layer.provide(reachFakes),
);

/** `server` on a machine of its own, whose database a test reads too. */
const onMachine = <A, E>(server: Layer.Layer<A, E, Layer.Success<typeof TestDomain.machine>>) =>
  server.pipe(Layer.provideMerge(TestDomain.machine));

/** Each test talks to a server over a socket and waits on its pace. */
const SLOW = 30_000;

/** `look`'s value once it has one, looked at every 100 ms. */
const eventually = <A, R>(what: string, look: Effect.Effect<Option.Option<A>, never, R>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200; tries++) {
      const found = yield* look;
      if (Option.isSome(found)) return found.value;
      yield* Effect.sleep(Duration.millis(100));
    }
    return yield* Effect.die(`Never: ${what}`);
  });

const listed = (connector: Connector) =>
  connector.status._tag === "connected" && connector.tools.length > 0;

/** A bot, and the connector to `url` it alone may use, listed. */
const connectBot = (url: string) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const secrets = yield* Secrets;
    const connectors = yield* Connectors;
    const ana = yield* bots.create({ commandId: CommandId.make("ana"), draft: { name: "Ana" } });
    yield* connectors.add({
      id: ID,
      source: {
        _tag: "remote",
        name: "Mail",
        url: Redacted.make("https://mail.example/mcp"),
        headers: [],
        oauthClient: null,
        privateNetwork: false,
      },
      grant: { _tag: "bots", ids: [ana.id] },
      by: { _tag: "operator" },
    });
    const secret = yield* secrets.connectorSecrets.get(connectorSecretIdOf(ID));
    if (Option.isNone(secret)) return yield* Effect.die("The connector's secret was sealed");
    yield* secrets.connectorSecrets.put({ ...secret.value, address: Redacted.make(url) });
    yield* connectors.toolsFor(ana.id);
    yield* connectors.subscribe.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(event._tag === "snapshot" ? event.connectors : event.upsert),
      ),
      Stream.filter(listed),
      Stream.runHead,
    );
    return ana.id;
  }).pipe(Effect.orDie);

/** The bot's routine on the connector's email event, as `set_routine` saves one. */
const mailRoutine = (botId: BotId) =>
  Effect.gen(function* () {
    const routines = yield* Routines;
    return yield* routines.create({
      commandId: null,
      botId,
      draft: {
        name: "Mail from Bia",
        instruction: "Tell me the subject of each email from Bia.",
        trigger: {
          _tag: "event",
          connectorId: ID,
          name: NAME,
          arguments: { from: "bia@example.com" },
          summary: "an email from Bia arrives",
        },
      },
      author: { _tag: "bot", botId },
    });
  }).pipe(Effect.orDie);

/** The routine as clients see it, once J3 Bots' listening for its event is `state`. */
const listeningAs = (botId: BotId, id: RoutineId, state: string) =>
  eventually(
    `the routine is ${state}`,
    Effect.gen(function* () {
      const routine = (yield* (yield* Routines).list(botId)).find((each) => each.id === id);
      return routine?.listening?._tag === state ? Option.some(routine) : Option.none<Routine>();
    }),
  );

const decodeRun = Schema.decodeSync(EventRunDataJson);
const decodeItem = Schema.decodeSync(EventItemJson);
const decodeNote = Schema.decodeSync(json(CatchUpNote));
const subjectOf = (data: string) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ subject: Schema.String })))(data).subject;

/** The routine's runs, oldest first, with the events each was started for. */
const runsOf = (id: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly trigger_data: string | null }>`
      SELECT trigger_data FROM routine_runs WHERE routine_id = ${id} ORDER BY rowid
    `;
    return rows.map((row) => {
      const run = decodeRun(row.trigger_data ?? "");
      return { subjects: run.events.map((event) => subjectOf(event.data)), missed: run.missed };
    });
  }).pipe(Effect.orDie);

/** The events waiting for the routine's next run, oldest first. */
const waitingOf = (id: RoutineId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly occurrence_json: string }>`
      SELECT occurrence_json FROM routine_event_pending WHERE routine_id = ${id} ORDER BY id
    `;
    return rows.map((row) => subjectOf(decodeItem(row.occurrence_json).data));
  }).pipe(Effect.orDie);

const firstRun = (id: RoutineId) =>
  eventually(
    "a run started",
    Effect.map(runsOf(id), (runs) => Option.fromUndefinedOr(runs[0])),
  );

describe("RoutineEvents", () => {
  it.live(
    "polls only once a routine asks, runs it with the event, and tells it what was missed",
    () =>
      Effect.gen(function* () {
        const fake = yield* sdkHttpServer({
          revision: "2026-07-28",
          events: { types: [typeWith(["poll"])], nextPollMs: 1_000 },
        });
        const control = fake.events;
        if (control === null) return yield* Effect.die("The fake offers events");
        const ana = yield* connectBot(fake.url);
        // The bot sees what the connector offers, as data from it.
        const connectors = yield* Connectors;
        const offered = yield* connectors.events({ botId: ana });
        assert.include(
          offered.text,
          '- email.received: A new email arrived. [arguments: {"type":"object","properties":{"from":{"type":"string"}}}]',
        );
        assert.include(offered.text, "[delivery: poll]");
        const unknown = yield* connectors.eventOf({ botId: ana, slug: "mail", name: "email.sent" });
        assert.strictEqual(unknown._tag, "unknown");
        // Events wake no one by themselves: listing them subscribes to nothing.
        assert.isFalse(
          fake.requests.some(
            (request) => request.method.startsWith("events/") && request.method !== "events/list",
          ),
        );

        const routine = yield* mailRoutine(ana);
        const seen = yield* listeningAs(ana, routine.id, "listening");
        assert.strictEqual(seen.connectorName, "Mail");
        // The first poll asks from now, with the trigger's arguments.
        assert.strictEqual(control.cursorsAsked[0], null);
        // A client that does not ask for event routines, as one built before them, is never sent one.
        const routines = yield* Routines;
        const idsOf = (withEvents: boolean) =>
          routines.subscribe(ana, null, withEvents).pipe(
            Stream.runHead,
            Effect.map((frame) =>
              Option.isSome(frame) && frame.value._tag === "snapshot"
                ? frame.value.routines.map((each) => each.id)
                : [],
            ),
          );
        assert.deepStrictEqual(yield* idsOf(false), []);
        assert.deepStrictEqual(yield* idsOf(true), [routine.id]);

        // An event lost before J3 Bots asked again: the server says so.
        yield* Effect.promise(() => control.emit(NAME, { subject: "Lost" }));
        control.forget();
        yield* Effect.promise(() => control.emit(NAME, { subject: "Lunch?" }));
        const run = yield* firstRun(routine.id);
        assert.deepStrictEqual(run, { subjects: ["Lunch?"], missed: true });
      }).pipe(Effect.scoped, Effect.provide(onMachine(atHome))),
    SLOW,
  );

  it.live(
    "takes each streamed event once, holds a burst for one run after the one going, and resumes where it stood after a restart",
    () =>
      Effect.gen(function* () {
        const fake = yield* sdkHttpServer({
          revision: "2026-07-28",
          events: { types: [typeWith(["push", "poll"])], heartbeatMs: 60_000 },
        });
        const control = fake.events;
        if (control === null) return yield* Effect.die("The fake offers events");

        const { ana, routine } = yield* Effect.gen(function* () {
          const ana = yield* connectBot(fake.url);
          const routine = yield* mailRoutine(ana);
          yield* listeningAs(ana, routine.id, "listening");
          yield* eventually(
            "a stream is open",
            Effect.sync(() => (control.openStreams() === 1 ? Option.some(true) : Option.none())),
          );
          yield* Effect.promise(() => control.emit(NAME, { subject: "One" }, "evt_one"));
          assert.deepStrictEqual(yield* firstRun(routine.id), { subjects: ["One"], missed: false });

          // The same event again is taken once; what arrives while the run
          // goes on waits for one run together.
          yield* Effect.promise(() => control.emit(NAME, { subject: "One" }, "evt_one"));
          yield* Effect.promise(() => control.emit(NAME, { subject: "Two" }));
          yield* Effect.promise(() => control.emit(NAME, { subject: "Three" }));
          yield* eventually(
            "the burst waits",
            Effect.map(waitingOf(routine.id), (waiting) =>
              waiting.length === 2 ? Option.some(waiting) : Option.none(),
            ),
          );
          assert.deepStrictEqual(yield* waitingOf(routine.id), ["Two", "Three"]);
          assert.strictEqual((yield* runsOf(routine.id)).length, 1);
          return { ana, routine };
        }).pipe(Effect.provide(atHome));

        // While J3 Bots is not running, the server keeps what happens.
        yield* Effect.promise(() => control.emit(NAME, { subject: "Four" }));
        const asked = control.cursorsAsked.length;

        yield* Effect.gen(function* () {
          yield* listeningAs(ana, routine.id, "listening");
          yield* eventually(
            "the stream resumed",
            Effect.map(waitingOf(routine.id), (waiting) =>
              waiting.length === 3 ? Option.some(waiting) : Option.none(),
            ),
          );
          assert.deepStrictEqual(yield* waitingOf(routine.id), ["Two", "Three", "Four"]);
          // From where it stood: after the last event it took.
          assert.strictEqual(control.cursorsAsked[asked], "c4");
        }).pipe(Effect.provide(atHome));
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(TestDomain.machine))),
    SLOW,
  );

  it.live(
    "stops listening when the server ends the subscription, shows why, and tells the bot",
    () =>
      Effect.gen(function* () {
        const fake = yield* sdkHttpServer({
          revision: "2026-07-28",
          events: { types: [typeWith(["push"])], heartbeatMs: 60_000 },
        });
        const control = fake.events;
        if (control === null) return yield* Effect.die("The fake offers events");
        const ana = yield* connectBot(fake.url);
        const routine = yield* mailRoutine(ana);
        yield* listeningAs(ana, routine.id, "listening");
        yield* eventually(
          "a stream is open",
          Effect.sync(() => (control.openStreams() === 1 ? Option.some(true) : Option.none())),
        );

        yield* Effect.promise(() => control.terminate({ code: -32024, message: "Forbidden" }));
        const stopped = yield* listeningAs(ana, routine.id, "stopped");
        assert.strictEqual(
          stopped.listening?._tag === "stopped" ? stopped.listening.reason : null,
          "access-revoked",
        );

        const sql = yield* SqlClient.SqlClient;
        const notes = yield* sql<{ readonly note_json: string }>`
          SELECT note_json FROM catch_up_notes WHERE bot_id = ${ana}
        `;
        const told = notes
          .map((note) => decodeNote(note.note_json))
          .find((note) => note._tag === "routine-stopped");
        assert.deepStrictEqual(
          told?._tag === "routine-stopped"
            ? [told.routine, told.routineId, told.connector, told.reason]
            : [],
          ["Mail from Bia", routine.id, "Mail", "access-revoked"],
        );
        const [entry] = yield* sql<{ readonly kind: string }>`
          SELECT kind FROM entries WHERE conversation_bot_id = ${ana} ORDER BY seq DESC LIMIT 1
        `;
        assert.strictEqual(entry?.kind, "event-routine-change");
      }).pipe(Effect.scoped, Effect.provide(onMachine(atHome))),
    SLOW,
  );

  it.live(
    "subscribes a webhook behind a public origin, proves it to the server, and refuses a delivery it did not sign",
    () =>
      Effect.gen(function* () {
        const events = yield* RoutineEvents;
        const context = yield* Effect.context<RoutineEvents>();
        const answers: Array<DeliveryAnswer["_tag"]> = [];
        // The server's posts reach J3 Bots' own receiver, as through its route.
        const deliver: EventsFakeOptions["deliver"] = (url, request) =>
          Effect.runPromiseWith(context)(
            events.delivered({
              token: url.slice(`${PUBLIC}${EVENT_HOOK_PATH}/`.length),
              id: request.headers["webhook-id"] ?? null,
              timestamp: request.headers["webhook-timestamp"] ?? null,
              signature: request.headers["webhook-signature"] ?? null,
              body: new TextEncoder().encode(request.body),
            }),
          ).then((answer): Delivered => {
            answers.push(answer._tag);
            return answer._tag === "challenge"
              ? { status: 200, body: `{"challenge":"${answer.challenge}"}` }
              : { status: answer._tag === "taken" ? 204 : 401, body: "" };
          });
        const fake = yield* sdkHttpServer({
          revision: "2026-07-28",
          events: { types: [typeWith(["webhook", "push"])], deliver },
        });
        const control = fake.events;
        if (control === null) return yield* Effect.die("The fake offers events");
        const ana = yield* connectBot(fake.url);
        const routine = yield* mailRoutine(ana);
        yield* listeningAs(ana, routine.id, "listening");

        const [hook] = control.webhooks();
        assert.isTrue(hook?.url.startsWith(`${PUBLIC}${EVENT_HOOK_PATH}/`));
        assert.strictEqual(control.openStreams(), 0);
        assert.strictEqual(answers[0], "challenge");

        yield* Effect.promise(() => control.emit(NAME, { subject: "Posted" }));
        assert.deepStrictEqual(yield* firstRun(routine.id), {
          subjects: ["Posted"],
          missed: false,
        });

        // A delivery signed with another secret, or to an address no routine
        // listens at, is refused before anything of it is read.
        const token = hook?.url.split("/").at(-1) ?? "";
        const now = yield* Clock.currentTimeMillis;
        const forged = {
          token,
          id: "msg_forged",
          timestamp: String(Math.floor(now / 1000)),
          signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          body: new TextEncoder().encode(
            `{"eventId":"evt_x","name":"${NAME}","timestamp":"2026-01-01T00:00:00Z","data":{}}`,
          ),
        };
        assert.strictEqual((yield* events.delivered(forged))._tag, "refused");
        assert.strictEqual((yield* events.delivered({ ...forged, token: "nobody" }))._tag, "gone");
        assert.deepStrictEqual(yield* waitingOf(routine.id), []);

        // New words for the same event keep its subscription and its address.
        const routines = yield* Routines;
        if (routine.trigger._tag !== "event") return yield* Effect.die("An event routine");
        yield* routines.update({
          commandId: null,
          routineId: routine.id,
          changes: { trigger: { ...routine.trigger, summary: "Bia writes" } },
          author: { _tag: "bot", botId: ana },
        });
        yield* Effect.promise(() => control.emit(NAME, { subject: "Again" }));
        yield* eventually(
          "the event waits for the run going on",
          Effect.map(waitingOf(routine.id), (waiting) =>
            waiting.length === 1 ? Option.some(waiting) : Option.none(),
          ),
        );
        assert.deepStrictEqual(yield* waitingOf(routine.id), ["Again"]);
        assert.deepStrictEqual(
          control.webhooks().map((each) => each.url),
          [hook?.url],
        );

        // The operator takes the connector from the bot: the routine stops at
        // once, and what the server still posts there wakes nobody.
        yield* (yield* Connectors)
          .setBots({
            commandId: CommandId.make("revoke"),
            connectorId: ID,
            grant: { _tag: "bots", ids: [] },
            by: { _tag: "operator" },
          })
          .pipe(Effect.orDie);
        const stopped = yield* listeningAs(ana, routine.id, "stopped");
        assert.strictEqual(
          stopped.listening?._tag === "stopped" ? stopped.listening.reason : null,
          "connector-gone",
        );
        assert.strictEqual((yield* events.delivered({ ...forged, signature: null }))._tag, "gone");
      }).pipe(Effect.scoped, Effect.provide(onMachine(published))),
    SLOW,
  );

  it.live(
    "gives way to polls when a stream never opens, and takes a burst in runs that fit",
    () =>
      Effect.gen(function* () {
        const fake = yield* sdkHttpServer({
          revision: "2026-07-28",
          events: { types: [typeWith(["push", "poll"])], streamStatus: 502, nextPollMs: 1_000 },
        });
        const control = fake.events;
        if (control === null) return yield* Effect.die("The fake offers events");
        const ana = yield* connectBot(fake.url);
        const routine = yield* mailRoutine(ana);
        yield* listeningAs(ana, routine.id, "listening");
        assert.isTrue(fake.requests.some((request) => request.method === "events/stream"));
        assert.isTrue(fake.requests.some((request) => request.method === "events/poll"));

        // Four long emails at once: one run takes as many as fit, oldest
        // first, and the rest wait for the next.
        const long = "x".repeat(15_000);
        yield* Effect.promise(async () => {
          for (const subject of ["A", "B", "C", "D"]) {
            await control.emit(NAME, { subject, body: long });
          }
        });
        assert.deepStrictEqual(yield* firstRun(routine.id), {
          subjects: ["A", "B", "C"],
          missed: false,
        });
        assert.deepStrictEqual(yield* waitingOf(routine.id), ["D"]);
      }).pipe(Effect.scoped, Effect.provide(onMachine(atHome))),
    SLOW,
  );

  it.live(
    "falls back to a stream when the server cannot verify the webhook's address",
    () =>
      Effect.gen(function* () {
        const fake = yield* sdkHttpServer({
          revision: "2026-07-28",
          events: {
            types: [typeWith(["webhook", "push"])],
            // The address answers, but not with the challenge.
            deliver: () => Promise.resolve({ status: 200, body: "{}" }),
            heartbeatMs: 60_000,
          },
        });
        const control = fake.events;
        if (control === null) return yield* Effect.die("The fake offers events");
        const ana = yield* connectBot(fake.url);
        const routine = yield* mailRoutine(ana);
        yield* listeningAs(ana, routine.id, "listening");
        assert.deepStrictEqual(control.webhooks(), []);
        assert.strictEqual(control.openStreams(), 1);
      }).pipe(Effect.scoped, Effect.provide(onMachine(published))),
    SLOW,
  );
});
