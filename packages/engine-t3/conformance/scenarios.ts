// SPDX-License-Identifier: AGPL-3.0-or-later
import { secretRequestFieldId } from "@j3-bots/contracts";
import { assert } from "@effect/vitest";
import type { Vitest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { type DispatchDisposition, Engine } from "../src/Engine.ts";
import type { SessionEvent } from "../src/events.ts";
import {
  type EventCursor,
  type IdempotencyKey,
  type SessionId,
  SyncToken,
  type TurnId,
} from "../src/ids.ts";
import { type Act, Bench } from "./Bench.ts";

// The scenarios every `Engine` must pass. Each opens its own session.

type Methods = Vitest.MethodsNonLive<Engine | Bench>;

type Tagged<Tag extends SessionEvent["_tag"]> = Extract<SessionEvent, { readonly _tag: Tag }>;

/** One `events` stream, read as the scenario needs it. */
interface Watch {
  /** Every event read so far, in order. */
  readonly seen: ReadonlyArray<SessionEvent>;
  /** Reads the next event. */
  readonly take: Effect.Effect<SessionEvent>;
  /** Reads on until an event with `tag` that `match` accepts. */
  readonly next: <Tag extends SessionEvent["_tag"]>(
    tag: Tag,
    match?: (event: Tagged<Tag>) => boolean,
  ) => Effect.Effect<Tagged<Tag>>;
}

const watch = Effect.fnUntraced(function* (sessionId: SessionId, after: EventCursor | null) {
  const engine = yield* Engine;
  const queue = yield* engine
    .events({ sessionId, after })
    .pipe(Stream.orDie, Stream.toQueue({ capacity: "unbounded" }));
  const seen: Array<SessionEvent> = [];
  const take = Queue.take(queue).pipe(
    Effect.orDie,
    Effect.tap((event) => Effect.sync(() => seen.push(event))),
  );
  const next = <Tag extends SessionEvent["_tag"]>(
    tag: Tag,
    match: (event: Tagged<Tag>) => boolean = () => true,
  ): Effect.Effect<Tagged<Tag>> =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* take;
        if (isTag(event, tag) && match(event)) return event;
      }
    });
  const result: Watch = { seen, take, next };
  return result;
});

const isTag = <Tag extends SessionEvent["_tag"]>(
  event: SessionEvent,
  tag: Tag,
): event is Tagged<Tag> => event._tag === tag;

/** A fresh session, watched from its start. */
const session = Effect.fnUntraced(function* (name: string) {
  const engine = yield* Engine;
  const bench = yield* Bench;
  const projectId = yield* engine.ensureProject({
    workspacePath: bench.workspacePath,
    title: "Conformance",
  });
  const sessionId = yield* engine.openSession({
    key: bench.key(`session-${name}`),
    projectId,
    title: name,
    model: bench.model,
    effort: null,
    permissionMode: "supervised",
  });
  const events = yield* watch(sessionId, null);
  const first = yield* events.next("replaced");
  /** A key of this scenario's own. */
  const key = (purpose: string) => bench.key(`${name}-${purpose}`);
  return { sessionId, events, key, start: first.cursor };
});

const start = Effect.fnUntraced(function* (key: IdempotencyKey, act: Act) {
  const bench = yield* Bench;
  return {
    key,
    text: bench.prompt(act),
    attachments: [],
    delivery: { _tag: "start", freshContext: false } as const,
  };
});

const steer = Effect.fnUntraced(function* (key: IdempotencyKey, act: Act, turnId: TurnId) {
  const bench = yield* Bench;
  return {
    key,
    text: bench.prompt(act),
    attachments: [],
    delivery: { _tag: "steer", turnId } as const,
  };
});

/**
 * What a subscriber learns turn by turn. A replay may give only a step's
 * latest state, since a step event replaces the step it names.
 */
const turnLevel = (events: ReadonlyArray<SessionEvent>) =>
  events.filter((event) => event._tag !== "step").map((event) => event._tag);

/** The turn a disposition names. */
export const turnOf = (disposition: DispatchDisposition): TurnId => disposition.turnId;

/** Dispatches, and returns the turn the disposition names. */
const dispatchTurn = Effect.fnUntraced(function* (
  input: Parameters<Engine["Service"]["dispatch"]>[0],
) {
  const engine = yield* Engine;
  const disposition = yield* engine.dispatch(input);
  return { disposition, turnId: turnOf(disposition) };
});

const finished = (events: Watch, turnId: TurnId) =>
  events.next("turn-finished", (event) => event.turnId === turnId);

export const scenarios = (it: Methods) => {
  it.effect("applies a dispatch key once, and accepts a resend into its own busy turn", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("key-once");
      const dispatch = { ...(yield* start(key("work"), { _tag: "work" })), sessionId };

      const first = yield* engine.dispatch(dispatch);
      const started = yield* events.next("turn-started");
      // The session is busy with this key's own turn: a resend is still accepted.
      yield* engine.redispatch(dispatch);
      yield* engine.stop({ key: key("key-once-stop"), sessionId });
      yield* finished(events, turnOf(first));

      assert.strictEqual(first._tag, "started");
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: dispatch.key });
      // One turn for the key, however often it was sent.
      assert.lengthOf(
        events.seen.filter((event) => event._tag === "turn-started"),
        1,
      );
    }),
  );

  it.effect("refuses a start into a busy session, applying nothing", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("busy");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");

      const second = { ...(yield* start(key("second"), { _tag: "reply" })), sessionId };
      const refused = yield* engine.dispatch(second).pipe(Effect.flip);
      yield* engine.stop({ key: key("busy-stop"), sessionId });
      yield* finished(events, running.turnId);
      // Nothing was sent, so the key starts its turn once the session is idle.
      const later = yield* engine.dispatch(second);
      const started = yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: started.turnId, act: { _tag: "reply" } });
      yield* finished(events, started.turnId);

      assert.strictEqual(refused._tag, "SessionBusy");
      assert.isTrue(refused._tag === "SessionBusy" && refused.turnId === running.turnId);
      assert.strictEqual(later._tag, "started");
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: second.key });
    }),
  );

  it.effect("refuses a settings change while a turn runs, and takes it once the turn ended", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("configure-busy");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");

      const change = { sessionId, permissionMode: "auto-accept-edits" } as const;
      const refused = yield* engine.configureSession(change).pipe(Effect.flip);
      yield* engine.stop({ key: key("configure-busy-stop"), sessionId });
      yield* finished(events, running.turnId);
      // Nothing was sent, so the change is taken once the session is idle.
      yield* engine.configureSession(change);

      assert.isTrue(refused._tag === "SessionBusy" && refused.turnId === running.turnId);
    }),
  );

  it.effect("delivers a start as a turn caused by its dispatch, and reports its end", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("reply");
      const dispatch = { ...(yield* start(key("reply"), { _tag: "reply" })), sessionId };

      const disposition = yield* engine.dispatch(dispatch);
      const started = yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: started.turnId, act: { _tag: "reply" } });
      const end = yield* finished(events, started.turnId);

      assert.strictEqual(disposition._tag, "started");
      assert.strictEqual(started.turnId, turnOf(disposition));
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: dispatch.key });
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("steers a running turn, and reports the steer taken once the turn ends", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("steer");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");

      const steering = {
        ...(yield* steer(key("steer"), { _tag: "reply" }, running.turnId)),
        sessionId,
      };
      const disposition = yield* engine.dispatch(steering);
      yield* bench.readSteers({ sessionId, turnId: running.turnId });
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "reply" } });
      const end = yield* finished(events, running.turnId);
      const read = yield* events.next("steered");

      assert.deepStrictEqual(disposition, { _tag: "steered", turnId: running.turnId });
      assert.deepStrictEqual([read.key, read.turnId], [steering.key, running.turnId]);
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
      // One turn throughout: a provider that steers by restarting keeps the turn.
      assert.deepStrictEqual(
        events.seen.flatMap((event) => (event._tag === "turn-started" ? [event.cause] : [])),
        [{ _tag: "dispatch", key: key("work") }],
      );
    }),
  );

  it.effect("resumes from inside the batch that ended a steered turn, keeping the steer", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("steer-resume");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");
      const steering = {
        ...(yield* steer(key("steer"), { _tag: "reply" }, running.turnId)),
        sessionId,
      };
      yield* engine.dispatch(steering);
      yield* bench.readSteers({ sessionId, turnId: running.turnId });
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "reply" } });
      const end = yield* finished(events, running.turnId);
      yield* events.next("steered");

      // The cursor of the turn's end: the steer settles after it, in the same batch or later.
      const resumed = yield* watch(sessionId, end.cursor);
      const first = yield* resumed.take;

      if (first._tag === "replaced") {
        assert.deepStrictEqual(
          first.steers.filter((settled) => settled.key === steering.key),
          [{ key: steering.key, turnId: running.turnId, settlement: "read" }],
        );
      } else {
        const read = first._tag === "steered" ? first : yield* resumed.next("steered");
        assert.deepStrictEqual([read.key, read.turnId], [steering.key, running.turnId]);
        assert.isFalse(resumed.seen.some((event) => event.cursor === end.cursor));
      }
    }),
  );

  it.effect("steers a turn the engine has only just begun, with no turn for the carrier", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("early-steer");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      // Sent at once, perhaps before the provider turn starts: the engine keeps it aside until then.
      const steering = {
        ...(yield* steer(key("steer"), { _tag: "reply" }, running.turnId)),
        sessionId,
      };
      const disposition = yield* engine.dispatch(steering);
      yield* events.next("turn-started");
      yield* bench.readSteers({ sessionId, turnId: running.turnId });
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "reply" } });
      const end = yield* finished(events, running.turnId);
      const read = yield* events.next("steered");

      assert.deepStrictEqual(disposition, { _tag: "steered", turnId: running.turnId });
      assert.deepStrictEqual([read.key, read.turnId], [steering.key, running.turnId]);
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
      // A steer the engine kept aside rode on a run of its own: never a turn.
      const token = SyncToken.make("conformance-early-steer");
      yield* engine.synchronize({ sessionId, token });
      yield* events.next("synchronized", (event) => event.token === token);
      assert.isTrue(
        events.seen.every((event) => !("turnId" in event) || event.turnId === running.turnId),
      );
    }),
  );

  it.effect("makes a steer for a turn that completed a turn of its own", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("late-steer");
      const first = yield* dispatchTurn({
        ...(yield* start(key("reply"), { _tag: "reply" })),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: first.turnId, act: { _tag: "reply" } });
      yield* finished(events, first.turnId);

      const late = { ...(yield* steer(key("late"), { _tag: "reply" }, first.turnId)), sessionId };
      const disposition = yield* engine.dispatch(late);
      const started = yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: started.turnId, act: { _tag: "reply" } });
      yield* finished(events, started.turnId);

      assert.strictEqual(disposition._tag, "new-turn");
      assert.notStrictEqual(turnOf(disposition), first.turnId);
      assert.strictEqual(started.turnId, turnOf(disposition));
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: late.key });
    }),
  );

  it.effect("refuses a steer into a stopped turn on every repeat, applying nothing", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("rejected-steer");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* engine.stop({ key: key("stop"), sessionId });
      yield* finished(events, running.turnId);

      const late = { ...(yield* steer(key("late"), { _tag: "reply" }, running.turnId)), sessionId };
      const first = yield* engine.dispatch(late).pipe(Effect.flip);
      const again = yield* engine.redispatch(late).pipe(Effect.flip);
      const token = SyncToken.make("conformance-rejected-steer");
      yield* engine.synchronize({ sessionId, token });
      yield* events.next("synchronized", (event) => event.token === token);

      assert.deepStrictEqual([first._tag, again._tag], ["DispatchRejected", "DispatchRejected"]);
      assert.strictEqual(events.seen.filter((event) => event._tag === "turn-started").length, 1);
    }),
  );

  it.effect("stops a running turn, and does nothing to an idle session", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("stop");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");

      yield* engine.stop({ key: key("stop-1"), sessionId });
      const end = yield* finished(events, running.turnId);
      yield* engine.stop({ key: key("stop-2"), sessionId });

      assert.deepStrictEqual(end.outcome, { _tag: "interrupted" });
      assert.isFalse(end.backgroundWork);
    }),
  );

  it.effect("settles a recovered dispatch that Stop cancels before it starts by its cause", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("recovered-cancel");
      const running = yield* dispatchTurn({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");
      // A start whose first answer was lost: the resend reaches the engine, which queues it.
      const recovered = { ...(yield* start(key("recovered"), { _tag: "reply" })), sessionId };
      yield* engine.redispatch(recovered);

      yield* engine.stop({ key: key("stop"), sessionId });
      const cancelled = yield* events.next(
        "turn-finished",
        (event) => event.cause._tag === "dispatch" && event.cause.key === recovered.key,
      );
      const end = yield* finished(events, running.turnId);

      assert.deepStrictEqual(cancelled.outcome, { _tag: "cancelled" });
      assert.deepStrictEqual(end.outcome, { _tag: "interrupted" });
      assert.isFalse(
        events.seen.some(
          (event) => event._tag === "turn-started" && event.turnId === cancelled.turnId,
        ),
      );
    }),
  );

  it.effect("holds a turn on an approval until it is answered, once per key", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("approval");
      const running = yield* dispatchTurn({
        ...(yield* start(key("approval"), { _tag: "approval" })),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "approval" } });
      const opened = yield* events.next("request-opened");

      const answer = {
        key: key("allow"),
        sessionId,
        requestId: opened.open.requestId,
        response: { _tag: "approval", decision: "allow-once" },
      } as const;
      yield* engine.respond(answer);
      const closed = yield* events.next("request-closed");
      yield* engine.respond(answer);
      const late = yield* engine
        .respond({ ...answer, key: key("deny"), response: { _tag: "approval", decision: "deny" } })
        .pipe(Effect.flip);
      const end = yield* finished(events, running.turnId);

      assert.strictEqual(opened.open.turnId, running.turnId);
      assert.strictEqual(opened.open.request._tag, "approval");
      assert.deepStrictEqual(
        { requestId: closed.requestId, turnId: closed.turnId, resolution: closed.resolution },
        { requestId: opened.open.requestId, turnId: running.turnId, resolution: "answered" },
      );
      assert.strictEqual(late._tag, "RequestClosed");
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("passes the operator's answer to a question", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("question");
      const running = yield* dispatchTurn({
        ...(yield* start(key("question"), { _tag: "question" })),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "question" } });
      const opened = yield* events.next("request-opened");
      const request = opened.open.request;
      assert.strictEqual(request._tag, "question");
      if (request._tag !== "question") return;
      const [question] = request.questions;
      const [, option] = question.options;
      assert.isDefined(option);
      if (option === undefined) return;

      yield* engine.respond({
        key: key("answer"),
        sessionId,
        requestId: opened.open.requestId,
        response: {
          _tag: "question",
          answers: { [question.id]: { optionIds: [option.id], text: null } },
        },
      });
      const closed = yield* events.next("request-closed");
      const end = yield* finished(events, running.turnId);

      assert.strictEqual(closed.resolution, "answered");
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("takes a secret once", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("secret");
      const running = yield* dispatchTurn({
        ...(yield* start(key("secret"), { _tag: "secret" })),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "secret" } });
      const opened = yield* events.next("request-opened");

      yield* engine.respondSecret({
        sessionId,
        requestId: opened.open.requestId,
        answer: { _tag: "decline" },
      });
      const closed = yield* events.next("request-closed");
      const again = yield* engine
        .respondSecret({ sessionId, requestId: opened.open.requestId, answer: { _tag: "decline" } })
        .pipe(Effect.flip);
      const end = yield* finished(events, running.turnId);

      assert.strictEqual(opened.open.request._tag, "secret");
      assert.strictEqual(closed.resolution, "declined");
      assert.strictEqual(again._tag, "RequestClosed");
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("saves a secret asked for as one named field under its name", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const act = { _tag: "secret", fields: [{ name: "token", masked: true }] } as const;
      const { sessionId, events, key } = yield* session("secret-field");
      const running = yield* dispatchTurn({
        ...(yield* start(key("secret-field"), act)),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act });
      const opened = yield* events.next("request-opened");

      // A client before 0.12.0 answers a card with one value alone.
      yield* engine.respondSecret({
        sessionId,
        requestId: opened.open.requestId,
        answer: { _tag: "provide", value: Redacted.make("example-token") },
      });
      const closed = yield* events.next("request-closed");
      const end = yield* finished(events, running.turnId);

      // The card's one input is labelled as the field the value is saved under.
      const { request } = opened.open;
      assert(request._tag === "secret");
      assert.deepStrictEqual(
        request.fields.map(({ label }) => label),
        ["token"],
      );
      assert.strictEqual(closed.resolution, "provided");
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("asks for several values in one card and saves each under its name", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const act = {
        _tag: "secret",
        fields: [
          { name: "email", masked: false },
          { name: "password", masked: true },
        ],
      } as const;
      const { sessionId, events, key } = yield* session("secret-fields");
      const running = yield* dispatchTurn({
        ...(yield* start(key("secret-fields"), act)),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act });
      const opened = yield* events.next("request-opened");
      const { request, requestId } = opened.open;
      assert(request._tag === "secret");
      assert.deepStrictEqual(
        request.fields.map(({ id, label, masked }) => ({ id, label, masked })),
        [
          { id: "field-1", label: "email", masked: false },
          { id: "field-2", label: "password", masked: true },
        ],
      );
      assert.strictEqual(request.delivery, "file");

      // One value alone does not answer two: refused before it reaches the engine.
      const alone = yield* engine
        .respondSecret({
          sessionId,
          requestId,
          answer: { _tag: "provide", value: Redacted.make("someone@example.com") },
        })
        .pipe(Effect.flip);
      assert.strictEqual(alone._tag, "SecretAnswerMismatch");

      yield* engine.respondSecret({
        sessionId,
        requestId,
        answer: {
          _tag: "provide-fields",
          values: {
            [secretRequestFieldId(0)]: Redacted.make("someone@example.com"),
            [secretRequestFieldId(1)]: Redacted.make("example-password"),
          },
        },
      });
      const closed = yield* events.next("request-closed");
      const end = yield* finished(events, running.turnId);

      assert.strictEqual(closed.resolution, "provided");
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("reports what the bot said through the engine's own tool", () =>
    Effect.gen(function* () {
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("speech");
      const act = { _tag: "speak", text: "Back-in-five-minutes." } as const;
      const running = yield* dispatchTurn({ ...(yield* start(key("speak"), act)), sessionId });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act });
      const speech = yield* events.next("host-speech");
      yield* finished(events, running.turnId);

      assert.strictEqual(speech.turnId, running.turnId);
      assert.strictEqual(speech.text, act.text);
    }),
  );

  it.effect("reports a turn nobody in J3 Bots dispatched as background", () =>
    Effect.gen(function* () {
      const bench = yield* Bench;
      const { sessionId, events } = yield* session("foreign");

      yield* bench.startForeignTurn(sessionId);
      const started = yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: started.turnId, act: { _tag: "reply" } });
      yield* finished(events, started.turnId);

      assert.deepStrictEqual(started.cause, { _tag: "background", origin: null });
    }),
  );

  it.effect("names the turn whose delegated task woke the session", () =>
    Effect.gen(function* () {
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("delegate");
      const act = { _tag: "delegate" } as const;
      const running = yield* dispatchTurn({ ...(yield* start(key("delegate"), act)), sessionId });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act });
      yield* finished(events, running.turnId);
      const wake = yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: wake.turnId, act: { _tag: "reply" } });
      yield* finished(events, wake.turnId);

      assert.deepStrictEqual(wake.cause, { _tag: "background", origin: running.turnId });
    }),
  );

  it.effect("resumes from a cursor without repeating or skipping events", () =>
    Effect.gen(function* () {
      const bench = yield* Bench;
      const { sessionId, events, key, start: cursor } = yield* session("resume");
      const dispatch = { ...(yield* start(key("reply"), { _tag: "reply" })), sessionId };
      const disposition = yield* dispatchTurn(dispatch);
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: disposition.turnId, act: { _tag: "reply" } });
      yield* finished(events, disposition.turnId);

      const resumed = yield* watch(sessionId, cursor);
      const first = yield* resumed.take;

      if (first._tag === "replaced") {
        assert.isTrue(first.endedTurns.some((turn) => turn.turnId === disposition.turnId));
      } else {
        const end = yield* finished(resumed, disposition.turnId);
        assert.deepStrictEqual(end.outcome, { _tag: "completed" });
        // Everything after the cursor, once: the live stream read it after its `replaced`.
        assert.deepStrictEqual(turnLevel(resumed.seen), turnLevel(events.seen.slice(1)));
      }
    }),
  );

  it.effect("marks every open stream only after what the engine had recorded", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key, start: cursor } = yield* session("sync");
      const other = yield* watch(sessionId, cursor);
      const running = yield* dispatchTurn({
        ...(yield* start(key("approval"), { _tag: "approval" })),
        sessionId,
      });
      yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "approval" } });
      const opened = yield* events.next("request-opened");
      const token = SyncToken.make("conformance-sync");

      // Recorded by the engine before `synchronize` is called: both streams tell it first.
      yield* engine.respond({
        key: key("allow"),
        sessionId,
        requestId: opened.open.requestId,
        response: { _tag: "approval", decision: "allow-once" },
      });
      yield* engine.synchronize({ sessionId, token });

      for (const stream of [events, other]) {
        yield* stream.next("synchronized", (event) => event.token === token);
        const closed = stream.seen.findIndex(
          (event) => event._tag === "request-closed" && event.requestId === opened.open.requestId,
        );
        const marker = stream.seen.findIndex(
          (event) => event._tag === "synchronized" && event.token === token,
        );
        assert.isAtLeast(closed, 0);
        assert.isBelow(closed, marker);
      }
      yield* finished(events, running.turnId);
    }),
  );

  it.effect("counts a stream as open from its subscription, before it emits anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* Engine;
        const { sessionId, start: cursor } = yield* session("subscribed");
        // Subscribed, and not read yet: the stream has emitted nothing.
        const pull = yield* Stream.toPull(engine.events({ sessionId, after: cursor }));
        const token = SyncToken.make("conformance-subscribed");
        yield* engine.synchronize({ sessionId, token });
        while (true) {
          const batch = yield* pull.pipe(Effect.orDie);
          if (batch.some((event) => event._tag === "synchronized" && event.token === token)) {
            return;
          }
        }
      }),
    ),
  );
};
