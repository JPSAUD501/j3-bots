// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId, WorkStepId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Engine } from "../Engine.ts";
import type { SessionEvent } from "../events.ts";
import { type EventCursor, IdempotencyKey, SessionId } from "../ids.ts";
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

  it.effect("steers a running turn, and makes a late steer a turn of its own", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const started = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      assert.strictEqual(started._tag, "started");

      const steer = (value: string) =>
        engine.dispatch({
          key: key(value),
          sessionId,
          text: value,
          attachments: [],
          delivery: { _tag: "steer", turnId: started.turnId },
        });

      assert.deepStrictEqual(yield* steer("dispatch-2"), {
        _tag: "steered",
        turnId: started.turnId,
      });
      yield* control.finishTurn({
        sessionId,
        turnId: started.turnId,
        outcome: { _tag: "completed" },
      });
      const late = yield* steer("dispatch-3");

      assert.strictEqual(late._tag, "new-turn");
      const [replaced] = yield* take(sessionId, null, 1);
      assert.isDefined(replaced);
      assert.strictEqual(replaced._tag, "replaced");
      assert.deepStrictEqual(
        replaced._tag === "replaced" && replaced.openTurns.map((turn) => turn.cause),
        [{ _tag: "dispatch", key: key("dispatch-3") }],
      );
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

  it.effect("replaces what cannot be replayed with one snapshot of open and ended work", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);

      const finished = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      yield* control.finishTurn({
        sessionId,
        turnId: finished.turnId,
        outcome: { _tag: "completed" },
      });
      const open = yield* engine.dispatch({ ...start("dispatch-2"), sessionId });
      const now = yield* DateTime.now;
      const step = {
        id: WorkStepId.make("step-1"),
        kind: "command",
        label: "pnpm test",
        status: "running",
        startedAt: now,
        finishedAt: null,
      } as const;
      yield* control.step({ sessionId, turnId: open.turnId, step });
      const requestId = yield* control.openRequest({
        sessionId,
        turnId: open.turnId,
        request: { _tag: "secret", label: "Token", reason: "Deploy", url: null, placeholder: null },
      });
      yield* control.pruneHistory(sessionId);

      const [replaced] = yield* take(sessionId, cursorOf(first), 1);

      assert.isDefined(replaced);
      assert.strictEqual(replaced._tag, "replaced");
      if (replaced._tag !== "replaced") return;
      assert.deepStrictEqual(
        replaced.endedTurns.map((turn) => [turn.turnId, turn.outcome._tag]),
        [[finished.turnId, "completed"]],
      );
      assert.deepStrictEqual(
        replaced.openTurns.map((turn) => [turn.turnId, turn.steps]),
        [[open.turnId, [step]]],
      );
      assert.deepStrictEqual(
        replaced.openRequests.map((request) => request.requestId),
        [requestId],
      );
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
