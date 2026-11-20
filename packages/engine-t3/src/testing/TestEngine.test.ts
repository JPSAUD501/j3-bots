// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId, WorkStepId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Engine } from "../Engine.ts";
import type { SessionEvent } from "../events.ts";
import { type EventCursor, IdempotencyKey, SessionId, SyncToken, type TurnId } from "../ids.ts";
import * as TestEngine from "./TestEngine.ts";

const key = (value: string) => IdempotencyKey.make(value);

const openSession = Effect.gen(function* () {
  const engine = yield* Engine;
  const projectId = yield* engine.ensureProject({ workspacePath: "/bots/scout", title: "Scout" });
  return yield* engine.openSession({
    key: key("session-1"),
    projectId,
    title: "Scout",
    model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("haiku") },
    permissionMode: "auto",
  });
});

const take = (sessionId: SessionId, after: EventCursor | null, count: number) =>
  Engine.use((engine) =>
    engine.events({ sessionId, after }).pipe(Stream.take(count), Stream.runCollect),
  );

const cursorOf = (event: SessionEvent | undefined) => {
  assert.isDefined(event);
  return event.cursor;
};

const start = (value: string) =>
  ({
    key: key(value),
    text: `<j3-wake>${value}</j3-wake>`,
    attachments: [],
    delivery: { _tag: "start", freshContext: false },
  }) as const;

const steer = (value: string, turnId: TurnId) =>
  ({
    key: key(value),
    text: value,
    attachments: [],
    delivery: { _tag: "steer", turnId },
  }) as const;

const tags = (events: Iterable<SessionEvent>) => [...events].map((event) => event._tag);

describe("TestEngine", () => {
  it.effect("applies a dispatch key once", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;

      const first = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      const again = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });

      assert.deepStrictEqual(again, first);
      assert.lengthOf(yield* control.dispatches(sessionId), 1);
      assert.deepStrictEqual(yield* engine.lookupDispatch({ sessionId, key: key("dispatch-1") }), {
        _tag: "applied",
        disposition: first,
      });
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("refuses a start into a session the engine woke itself, applying nothing", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const background = yield* control.startEngineTurn({
        sessionId,
        cause: { _tag: "background" },
      });

      const refused = yield* engine
        .dispatch({ ...start("dispatch-1"), sessionId })
        .pipe(Effect.flip);

      assert.strictEqual(refused._tag, "SessionBusy");
      assert.deepStrictEqual(refused._tag === "SessionBusy" && refused.turnId, background);
      assert.deepStrictEqual(yield* engine.lookupDispatch({ sessionId, key: key("dispatch-1") }), {
        _tag: "not-applied",
      });
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("queues a start behind a turn the engine began while it was on its way", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      yield* control.startEngineTurnDuringNextDispatch({
        sessionId,
        cause: { _tag: "background" },
      });

      const queued = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });

      assert.strictEqual(queued._tag, "queued");
      const [background] = yield* take(sessionId, cursorOf(first), 1);
      assert.isDefined(background);
      assert.isTrue(background._tag === "turn-started" && background.cause._tag === "background");
      if (background._tag !== "turn-started") return;
      yield* control.finishTurn({
        sessionId,
        turnId: background.turnId,
        outcome: { _tag: "completed" },
      });
      const delivered = yield* take(sessionId, background.cursor, 2);
      assert.deepStrictEqual(
        [...delivered].map((event) => event._tag === "turn-started" && event.cause),
        [false, { _tag: "dispatch", key: key("dispatch-1") }],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("delivers a steer that is read, and makes a late steer a turn of its own", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });

      assert.deepStrictEqual(
        yield* engine.dispatch({ ...steer("dispatch-2", started.turnId), sessionId }),
        { _tag: "steered", turnId: started.turnId },
      );
      yield* control.readSteers({ sessionId, turnId: started.turnId });
      yield* control.finishTurn({
        sessionId,
        turnId: started.turnId,
        outcome: { _tag: "completed" },
      });
      const late = yield* engine.dispatch({ ...steer("dispatch-3", started.turnId), sessionId });

      assert.strictEqual(late._tag, "new-turn");
      const [replaced] = yield* take(sessionId, null, 1);
      assert.deepStrictEqual(
        replaced?._tag === "replaced" && replaced.openTurns.map((turn) => turn.cause),
        [{ _tag: "dispatch", key: key("dispatch-3") }],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("starts a steer the agent never read as a follow-up turn of the same dispatch", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      const steered = yield* engine.dispatch({ ...steer("dispatch-2", started.turnId), sessionId });

      yield* control.finishTurn({
        sessionId,
        turnId: started.turnId,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });

      const events = yield* take(sessionId, cursorOf(first), 3);
      assert.deepStrictEqual(tags(events), ["turn-started", "turn-finished", "turn-started"]);
      const followUp = [...events][2];
      assert.deepStrictEqual(followUp?._tag === "turn-started" && followUp.cause, {
        _tag: "dispatch",
        key: key("dispatch-2"),
      });
      assert.deepStrictEqual(yield* engine.lookupDispatch({ sessionId, key: key("dispatch-2") }), {
        _tag: "applied",
        disposition: steered,
      });
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("stops a session: drops unread steers and cancels waiting turns", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      yield* engine.dispatch({ ...steer("dispatch-2", started.turnId), sessionId });
      const waiting = yield* control.startEngineTurn({ sessionId, cause: { _tag: "background" } });

      yield* engine.stop({ key: key("stop-1"), sessionId });

      const events = [...(yield* take(sessionId, cursorOf(first), 4))];
      assert.deepStrictEqual(
        events.map((event) =>
          event._tag === "turn-finished"
            ? [event.turnId, event.outcome._tag]
            : event._tag === "steer-dropped"
              ? [event.turnId, event.key]
              : event._tag,
        ),
        [
          "turn-started",
          [waiting, "cancelled"],
          [started.turnId, key("dispatch-2")],
          [started.turnId, "interrupted"],
        ],
      );
      // Applied once: the same key answers even after the session has gone.
      yield* engine.retireSession(sessionId);
      yield* engine.stop({ key: key("stop-1"), sessionId });
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("cannot tell whether a dispatch reached a session it does not have", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const sessionId = yield* openSession;
      yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      yield* engine.retireSession(sessionId);

      // A retired session keeps its history; an unknown one has none.
      assert.strictEqual(
        (yield* engine.lookupDispatch({ sessionId, key: key("dispatch-1") }))._tag,
        "applied",
      );
      assert.deepStrictEqual(
        yield* engine.lookupDispatch({
          sessionId: SessionId.make("session-unknown"),
          key: key("dispatch-1"),
        }),
        { _tag: "unknown" },
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("resumes by replaying the events after the cursor, and nothing else", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      yield* control.hostSpeech({ sessionId, turnId: started.turnId, text: "On it." });

      const replay = yield* take(sessionId, cursorOf(first), 2);

      assert.deepStrictEqual(
        replay.map((event) => event._tag),
        ["turn-started", "host-speech"],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("replaces what cannot be replayed with a snapshot complete for reconciliation", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const now = yield* DateTime.now;
      const step = {
        id: WorkStepId.make("step-1"),
        kind: "command",
        label: "pnpm test",
        status: "running",
        startedAt: now,
        finishedAt: null,
      } as const;

      const seen = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      yield* control.finishTurn({ sessionId, turnId: seen.turnId, outcome: { _tag: "completed" } });
      const history = yield* take(sessionId, null, 1);
      const cursor = cursorOf([...history][0]);

      const missed = yield* engine.dispatch({ ...start("dispatch-2"), sessionId });
      yield* control.step({ sessionId, turnId: missed.turnId, step });
      const speechId = yield* control.hostSpeech({
        sessionId,
        turnId: missed.turnId,
        text: "On it.",
      });
      const secretId = yield* control.openRequest({
        sessionId,
        turnId: missed.turnId,
        request: { _tag: "secret", label: "Token", reason: "Deploy", url: null, placeholder: null },
      });
      yield* engine.respondSecret({
        sessionId,
        requestId: secretId,
        answer: { _tag: "provide", value: Redacted.make("s3cr3t") },
      });
      yield* control.finishTurn({
        sessionId,
        turnId: missed.turnId,
        outcome: { _tag: "completed" },
      });
      const open = yield* engine.dispatch({ ...start("dispatch-3"), sessionId });
      yield* control.step({ sessionId, turnId: open.turnId, step });
      const approvalId = yield* control.openRequest({
        sessionId,
        turnId: open.turnId,
        request: {
          _tag: "approval",
          kind: "command",
          action: "pnpm deploy",
          detail: null,
          allowsSession: false,
        },
      });
      yield* control.pruneHistory(sessionId);

      const [replaced] = yield* take(sessionId, cursor, 1);

      assert.isDefined(replaced);
      if (replaced._tag !== "replaced") return assert.fail(replaced._tag);
      // The turn that ended before the cursor may come again; applying it changes nothing.
      assert.deepStrictEqual(
        replaced.endedTurns.map((turn) => [turn.turnId, turn.outcome._tag, turn.steps]),
        [
          [seen.turnId, "completed", []],
          [missed.turnId, "completed", [step]],
        ],
      );
      assert.deepStrictEqual(
        replaced.openTurns.map((turn) => [turn.turnId, turn.steps]),
        [[open.turnId, [step]]],
      );
      assert.deepStrictEqual(
        replaced.openRequests.map((request) => request.requestId),
        [approvalId],
      );
      assert.deepStrictEqual(
        replaced.hostSpeech.map((speech) => [speech.speechId, speech.text]),
        [[speechId, "On it."]],
      );
      assert.deepStrictEqual(replaced.closedRequests, [
        { requestId: secretId, turnId: missed.turnId, resolution: "provided" },
      ]);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("applies a command whose reply is lost, which only a lookup can tell", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      yield* control.loseNextReply;

      const lost = yield* engine.dispatch({ ...start("dispatch-1"), sessionId }).pipe(Effect.flip);

      assert.strictEqual(lost._tag, "EngineIndeterminate");
      const lookup = yield* engine.lookupDispatch({ sessionId, key: key("dispatch-1") });
      assert.strictEqual(lookup._tag === "applied" && lookup.disposition._tag, "started");
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("marks the point where a stream has caught up with the engine", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const token = SyncToken.make("sync-1");

      const events = yield* engine
        .events({ sessionId, after: cursorOf(first) })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      yield* engine.synchronize({ sessionId, token });

      const collected = [...(yield* Fiber.join(events))];
      assert.deepStrictEqual(tags(collected), ["turn-started", "synchronized"]);
      const [started, marker] = collected;
      assert.deepStrictEqual(marker?._tag === "synchronized" && [marker.token, marker.cursor], [
        token,
        cursorOf(started),
      ]);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("expires a turn's requests with it", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      const requestId = yield* control.openRequest({
        sessionId,
        turnId: started.turnId,
        request: {
          _tag: "approval",
          kind: "command",
          action: "rm -rf build",
          detail: null,
          allowsSession: true,
        },
      });

      yield* engine.stop({ key: key("stop-1"), sessionId });
      const refused = yield* engine
        .respond({
          key: key("respond-1"),
          sessionId,
          requestId,
          response: { _tag: "approval", decision: "allow-once" },
        })
        .pipe(Effect.flip);

      assert.strictEqual(refused._tag, "RequestClosed");
      const [replaced] = yield* take(sessionId, null, 1);
      assert.deepStrictEqual(
        replaced?._tag === "replaced" && [replaced.openTurns, replaced.openRequests],
        [[], []],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("hands a secret to the engine once", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      const requestId = yield* control.openRequest({
        sessionId,
        turnId: started.turnId,
        request: { _tag: "secret", label: "Token", reason: "Deploy", url: null, placeholder: null },
      });
      const answer = { _tag: "provide", value: Redacted.make("s3cr3t") } as const;

      yield* engine.respondSecret({ sessionId, requestId, answer });
      const again = yield* engine.respondSecret({ sessionId, requestId, answer }).pipe(Effect.flip);

      assert.strictEqual(again._tag, "RequestClosed");
      assert.deepStrictEqual(yield* control.secretAnswers(sessionId), [{ requestId, answer }]);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("applies nothing while unreachable", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      yield* control.setReachable(false);

      const refused = yield* engine
        .dispatch({ ...start("dispatch-1"), sessionId })
        .pipe(Effect.flip);
      yield* control.setReachable(true);

      assert.strictEqual(refused._tag, "EngineUnavailable");
      assert.deepStrictEqual(yield* engine.lookupDispatch({ sessionId, key: key("dispatch-1") }), {
        _tag: "not-applied",
      });
    }).pipe(Effect.provide(TestEngine.layer)),
  );
});
