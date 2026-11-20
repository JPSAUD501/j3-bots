// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert } from "@effect/vitest";
import type { Vitest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
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

const turnOf = (disposition: DispatchDisposition) => disposition.turnId;

const finished = (events: Watch, turnId: TurnId) =>
  events.next("turn-finished", (event) => event.turnId === turnId);

export const scenarios = (it: Methods) => {
  it.effect("applies a dispatch key once", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("key-once");
      const dispatch = { ...(yield* start(key("work"), { _tag: "work" })), sessionId };

      const first = yield* engine.dispatch(dispatch);
      const again = yield* engine.dispatch(dispatch);

      assert.strictEqual(first._tag, "started");
      assert.deepStrictEqual(again, first);
      assert.deepStrictEqual(yield* engine.lookupDispatch({ sessionId, key: dispatch.key }), {
        _tag: "applied",
        disposition: first,
      });
      const started = yield* events.next("turn-started");
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: dispatch.key });
      yield* engine.stop({ key: key("key-once-stop"), sessionId });
      yield* finished(events, turnOf(first));
    }),
  );

  it.effect("refuses a start into a busy session, applying nothing", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("busy");
      const running = yield* engine.dispatch({
        ...(yield* start(key("work"), { _tag: "work" })),
        sessionId,
      });
      yield* events.next("turn-started");

      const second = { ...(yield* start(key("second"), { _tag: "reply" })), sessionId };
      const refused = yield* engine.dispatch(second).pipe(Effect.flip);

      assert.strictEqual(refused._tag, "SessionBusy");
      assert.isTrue(refused._tag === "SessionBusy" && refused.turnId === running.turnId);
      assert.deepStrictEqual(yield* engine.lookupDispatch({ sessionId, key: second.key }), {
        _tag: "not-applied",
      });
      yield* engine.stop({ key: key("busy-stop"), sessionId });
      yield* finished(events, running.turnId);
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
      assert.strictEqual(started.turnId, disposition.turnId);
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: dispatch.key });
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
    }),
  );

  it.effect("steers a running turn and reports the steer read", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("steer");
      const running = yield* engine.dispatch({
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
      const read = yield* events.next("steered");
      yield* bench.perform({ sessionId, turnId: running.turnId, act: { _tag: "reply" } });
      const end = yield* finished(events, running.turnId);

      assert.deepStrictEqual(disposition, { _tag: "steered", turnId: running.turnId });
      assert.strictEqual(read.key, steering.key);
      assert.strictEqual(read.turnId, running.turnId);
      assert.deepStrictEqual(end.outcome, { _tag: "completed" });
      assert.notInclude(turnLevel(events.seen), "steer-dropped");
    }),
  );

  it.effect("makes a steer for a turn that already ended a turn of its own", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("late-steer");
      const first = yield* engine.dispatch({
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
      assert.notStrictEqual(disposition.turnId, first.turnId);
      assert.strictEqual(started.turnId, disposition.turnId);
      assert.deepStrictEqual(started.cause, { _tag: "dispatch", key: late.key });
    }),
  );

  it.effect("stops a running turn, and does nothing to an idle session", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("stop");
      const running = yield* engine.dispatch({
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

  it.effect("holds a turn on an approval until it is answered, once per key", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("approval");
      const running = yield* engine.dispatch({
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
      const running = yield* engine.dispatch({
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
      const running = yield* engine.dispatch({
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

  it.effect("reports what the bot said through the engine's own tool", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key } = yield* session("speech");
      const act = { _tag: "speak", text: "Back-in-five-minutes." } as const;
      const running = yield* engine.dispatch({ ...(yield* start(key("speak"), act)), sessionId });
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
      const { sessionId, events, key } = yield* session("foreign");

      yield* bench.startForeignTurn(sessionId);
      const started = yield* events.next("turn-started");
      yield* bench.perform({ sessionId, turnId: started.turnId, act: { _tag: "reply" } });
      yield* finished(events, started.turnId);

      assert.deepStrictEqual(started.cause, { _tag: "background" });
    }),
  );

  it.effect("resumes from a cursor without repeating or skipping events", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const bench = yield* Bench;
      const { sessionId, events, key, start: cursor } = yield* session("resume");
      const dispatch = { ...(yield* start(key("reply"), { _tag: "reply" })), sessionId };
      const disposition = yield* engine.dispatch(dispatch);
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

  it.effect("marks a point in every open stream on request", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const { sessionId, events, key } = yield* session("sync");
      const token = SyncToken.make("conformance-sync");

      yield* engine.synchronize({ sessionId, token });
      const marker = yield* events.next("synchronized");

      assert.strictEqual(marker.token, token);
    }),
  );
};
