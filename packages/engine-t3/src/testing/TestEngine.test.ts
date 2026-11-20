// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId, WorkStepId } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { type DispatchDisposition, Engine } from "../Engine.ts";
import type { SessionEvent } from "../events.ts";
import {
  type EventCursor,
  IdempotencyKey,
  type SessionId,
  SyncToken,
  type TurnId,
} from "../ids.ts";
import { toolInputDigest } from "../toolCaller.ts";
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

/** The turn a first submission's disposition names. */
const turnOf = (disposition: DispatchDisposition): TurnId => {
  if (disposition._tag === "applied-earlier") return assert.fail("no turn on a repeat");
  return disposition.turnId;
};

describe("TestEngine", () => {
  it.effect("applies a dispatch key once, and cannot say how a repeat was accepted", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;

      yield* engine.dispatch({ ...start("dispatch-1"), sessionId });
      const again = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });

      assert.deepStrictEqual(again, { _tag: "applied-earlier" });
      assert.lengthOf(yield* control.dispatches(sessionId), 1);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("resolves a dispatch whose reply was lost by sending it again", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      yield* control.loseNextReply;

      const lost = yield* engine.dispatch({ ...start("dispatch-1"), sessionId }).pipe(Effect.flip);
      const repeat = yield* engine.dispatch({ ...start("dispatch-1"), sessionId });

      assert.strictEqual(lost._tag, "EngineIndeterminate");
      assert.deepStrictEqual(repeat, { _tag: "applied-earlier" });
      const [delivered] = yield* take(sessionId, cursorOf(first), 1);
      assert.deepStrictEqual(delivered?._tag === "turn-started" && delivered.cause, {
        _tag: "dispatch",
        key: key("dispatch-1"),
      });
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("refuses a rejected dispatch key on every repeat, applying nothing", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      yield* control.rejectNextDispatch;
      yield* control.loseNextReply;

      const lost = yield* engine.dispatch({ ...start("dispatch-1"), sessionId }).pipe(Effect.flip);
      const repeat = yield* engine
        .dispatch({ ...start("dispatch-1"), sessionId })
        .pipe(Effect.flip);

      assert.strictEqual(lost._tag, "EngineIndeterminate");
      assert.strictEqual(repeat._tag, "DispatchRejected");
      assert.deepStrictEqual(yield* control.dispatches(sessionId), []);
      const [replaced] = yield* take(sessionId, null, 1);
      assert.deepStrictEqual(replaced?._tag === "replaced" && replaced.openTurns, []);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("refuses a start into a session the engine woke itself, sending nothing", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const background = yield* control.startEngineTurn(sessionId);

      const refused = yield* engine
        .dispatch({ ...start("dispatch-1"), sessionId })
        .pipe(Effect.flip);

      assert.strictEqual(refused._tag, "SessionBusy");
      assert.deepStrictEqual(refused._tag === "SessionBusy" && refused.turnId, background);
      assert.deepStrictEqual(yield* control.dispatches(sessionId), []);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("queues a start behind a turn the engine began while it was on its way", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      yield* control.startEngineTurnDuringNextDispatch(sessionId);

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

  it.effect("settles a steer the turn took once the turn ends, and makes a late one a turn", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));

      assert.deepStrictEqual(
        yield* engine.dispatch({ ...steer("dispatch-2", turnId), sessionId }),
        { _tag: "steered", turnId },
      );
      yield* control.readSteers({ sessionId, turnId });
      yield* control.finishTurn({ sessionId, turnId, outcome: { _tag: "completed" } });
      const late = yield* engine.dispatch({ ...steer("dispatch-3", turnId), sessionId });

      assert.strictEqual(late._tag, "new-turn");
      const events = yield* take(sessionId, cursorOf(first), 4);
      assert.deepStrictEqual(tags(events), [
        "turn-started",
        "turn-finished",
        "steered",
        "turn-started",
      ]);
      const settled = [...events][2];
      assert.deepStrictEqual(settled?._tag === "steered" && [settled.key, settled.turnId], [
        key("dispatch-2"),
        turnId,
      ]);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("requeues a steer the turn never took as a follow-up turn of the same dispatch", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      yield* engine.dispatch({ ...steer("dispatch-2", turnId), sessionId });

      yield* control.finishTurn({
        sessionId,
        turnId,
        outcome: { _tag: "failed", failure: "provider-error", retryAt: null },
      });

      const events = [...(yield* take(sessionId, cursorOf(first), 4))];
      assert.deepStrictEqual(tags(events), [
        "turn-started",
        "turn-finished",
        "steer-requeued",
        "turn-started",
      ]);
      const [, , requeued, followUp] = events;
      assert.isTrue(
        requeued?._tag === "steer-requeued" &&
          followUp?._tag === "turn-started" &&
          requeued.followUpTurnId === followUp.turnId,
      );
      assert.deepStrictEqual(followUp?._tag === "turn-started" && followUp.cause, {
        _tag: "dispatch",
        key: key("dispatch-2"),
      });
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("holds a steer for a turn that has not started until that turn ends", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const background = yield* control.startEngineTurn(sessionId);
      const waiting = yield* control.startEngineTurn(sessionId);
      const [first] = yield* take(sessionId, null, 1);

      assert.deepStrictEqual(
        yield* engine.dispatch({ ...steer("dispatch-1", waiting), sessionId }),
        { _tag: "steered", turnId: waiting },
      );
      yield* control.finishTurn({
        sessionId,
        turnId: background,
        outcome: { _tag: "completed" },
      });
      yield* control.readSteers({ sessionId, turnId: waiting });
      yield* control.finishTurn({ sessionId, turnId: waiting, outcome: { _tag: "completed" } });

      const events = [...(yield* take(sessionId, cursorOf(first), 4))];
      assert.deepStrictEqual(
        events.map((event) => ("turnId" in event ? [event._tag, event.turnId] : event._tag)),
        [
          ["turn-finished", background],
          ["turn-started", waiting],
          ["turn-finished", waiting],
          ["steered", waiting],
        ],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect(
    "stops a session: drops untaken steers after the turn ends, then cancels the queue",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const control = yield* TestEngine.TestEngineControl;
        const sessionId = yield* openSession;
        const [first] = yield* take(sessionId, null, 1);
        const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
        yield* engine.dispatch({ ...steer("dispatch-2", turnId), sessionId });
        const waiting = yield* control.startEngineTurn(sessionId);

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
            [turnId, "interrupted"],
            [turnId, key("dispatch-2")],
            [waiting, "cancelled"],
          ],
        );
        // Applied once: the same key answers even after the session has gone.
        yield* engine.retireSession(sessionId);
        yield* engine.stop({ key: key("stop-1"), sessionId });
      }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("lets a message that reaches the engine mid-Stop restart a turn the Stop misses", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const running = yield* control.startEngineTurn(sessionId);
      const held = yield* control.startEngineTurn(sessionId);
      yield* control.dispatchDuringNextStop({ sessionId, key: key("dispatch-1"), text: "Hi" });

      yield* engine.stop({ key: key("stop-1"), sessionId });

      // The Stop's cancels miss the held turn the message released.
      const [snapshot] = yield* take(sessionId, null, 1);
      assert.deepStrictEqual(
        snapshot?._tag === "replaced" &&
          snapshot.openTurns.map((turn) => [turn.turnId, turn.startedAt !== null]),
        [[held, true]],
      );
      const [slipped] = yield* control.dispatches(sessionId);
      assert.strictEqual(slipped?.disposition._tag, "queued");
      assert.isTrue(
        snapshot?._tag === "replaced" &&
          !snapshot.openTurns.some((turn) => turn.turnId === running),
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );
  it.effect("resumes by replaying the events after the cursor, and nothing else", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      yield* control.hostSpeech({ sessionId, turnId, text: "On it." });

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

      const seen = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      yield* control.finishTurn({ sessionId, turnId: seen, outcome: { _tag: "completed" } });
      const history = yield* take(sessionId, null, 1);
      const cursor = cursorOf([...history][0]);

      const missed = turnOf(yield* engine.dispatch({ ...start("dispatch-2"), sessionId }));
      yield* control.step({ sessionId, turnId: missed, step });
      const speechId = yield* control.hostSpeech({
        sessionId,
        turnId: missed,
        text: "On it.",
      });
      const secretId = yield* control.openRequest({
        sessionId,
        turnId: missed,
        request: { _tag: "secret", label: "Token", reason: "Deploy", url: null, placeholder: null },
      });
      yield* engine.respondSecret({
        sessionId,
        requestId: secretId,
        answer: { _tag: "provide", value: Redacted.make("s3cr3t") },
      });
      yield* control.finishTurn({
        sessionId,
        turnId: missed,
        outcome: { _tag: "completed" },
      });
      const open = turnOf(yield* engine.dispatch({ ...start("dispatch-3"), sessionId }));
      yield* control.step({ sessionId, turnId: open, step });
      const approvalId = yield* control.openRequest({
        sessionId,
        turnId: open,
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
          [seen, "completed", []],
          [missed, "completed", [step]],
        ],
      );
      assert.deepStrictEqual(
        replaced.openTurns.map((turn) => [turn.turnId, turn.steps]),
        [[open, [step]]],
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
        { requestId: secretId, turnId: missed, resolution: "provided" },
      ]);
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
      const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      const requestId = yield* control.openRequest({
        sessionId,
        turnId,
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
      const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      const requestId = yield* control.openRequest({
        sessionId,
        turnId,
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
      assert.deepStrictEqual(yield* control.dispatches(sessionId), []);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("resumes a held queue once, and leaves it held when the engine holds it again", () =>
    Effect.gen(function* () {
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const running = yield* control.startEngineTurn(sessionId);
      const waiting = yield* control.startEngineTurn(sessionId);

      yield* control.holdQueue({ sessionId, heldAgainOnResume: true });
      yield* control.finishTurn({ sessionId, turnId: running, outcome: { _tag: "completed" } });
      const [held] = yield* take(sessionId, null, 1);
      yield* control.holdQueue({ sessionId, heldAgainOnResume: false });
      const [resumed] = yield* take(sessionId, null, 1);

      const startedOf = (event: SessionEvent | undefined) =>
        event?._tag === "replaced" &&
        event.openTurns.map((turn) => [turn.turnId, turn.startedAt !== null]);
      assert.deepStrictEqual(startedOf(held), [[waiting, false]]);
      assert.deepStrictEqual(startedOf(resumed), [[waiting, true]]);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("tells a turn that failed before it started from one that ran unseen", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      yield* control.failNextStart({ sessionId, failure: "provider-error" });

      const failed = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      const ran = turnOf(yield* engine.dispatch({ ...start("dispatch-2"), sessionId }));
      yield* control.finishTurn({ sessionId, turnId: ran, outcome: { _tag: "completed" } });
      yield* control.pruneHistory(sessionId);
      const [replaced] = yield* take(sessionId, cursorOf(first), 1);

      if (replaced?._tag !== "replaced") return assert.fail(replaced?._tag);
      assert.deepStrictEqual(
        replaced.endedTurns.map((turn) => [
          turn.turnId,
          turn.outcome._tag,
          turn.startedAt !== null,
          turn.startedAt === null || DateTime.isLessThanOrEqualTo(turn.startedAt, turn.finishedAt),
        ]),
        [
          [failed, "failed", false, true],
          [ran, "completed", true, true],
        ],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("closes a turn's tool calls with it, so the next turn has none open", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const turnA = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      const input = { text: "Done.", audience: "operator" };
      const callId = yield* control.toolCall({
        sessionId,
        turnId: turnA,
        tool: "say",
        input,
        recorded: "now",
      });
      yield* control.finishTurn({ sessionId, turnId: turnA, outcome: { _tag: "completed" } });
      const turnB = turnOf(yield* engine.dispatch({ ...start("dispatch-2"), sessionId }));

      // The bridge receives turn A's call only now, while turn B runs.
      const events = [...(yield* take(sessionId, cursorOf(first), 4))];
      assert.deepStrictEqual(
        events.map((event) => ("turnId" in event ? [event._tag, event.turnId] : event._tag)),
        [
          ["turn-started", turnA],
          ["tool-call", turnA],
          ["turn-finished", turnA],
          ["turn-started", turnB],
        ],
      );
      const [, opened] = events;
      assert.deepStrictEqual(opened?._tag === "tool-call" && [opened.call, opened.state], [
        { callId, tool: "say", inputDigest: yield* toolInputDigest(input) },
        "open",
      ]);
      const [replaced] = yield* take(sessionId, null, 1);
      assert.deepStrictEqual(
        replaced?._tag === "replaced" &&
          replaced.openTurns.map((turn) => [turn.turnId, turn.toolCalls]),
        [[turnB, []]],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("records a tool call late, after the marker of the next synchronize", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const turnId = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      const [snapshot] = yield* take(sessionId, null, 1);
      const events = yield* engine
        .events({ sessionId, after: cursorOf(snapshot) })
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;

      yield* control.toolCall({
        sessionId,
        turnId,
        tool: "say",
        input: {},
        recorded: "after-next-synchronize",
      });
      yield* engine.synchronize({ sessionId, token: SyncToken.make("sync-1") });
      yield* engine.synchronize({ sessionId, token: SyncToken.make("sync-2") });

      assert.deepStrictEqual(tags(yield* Fiber.join(events)), [
        "synchronized",
        "tool-call",
        "synchronized",
      ]);
    }).pipe(Effect.provide(TestEngine.layer)),
  );

  it.effect("keeps a usage-limited turn's work open until its continuation runs or drops", () =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const control = yield* TestEngine.TestEngineControl;
      const sessionId = yield* openSession;
      const [first] = yield* take(sessionId, null, 1);
      const resumesAt = DateTime.add(yield* DateTime.now, { hours: 1 });
      const limited = turnOf(yield* engine.dispatch({ ...start("dispatch-1"), sessionId }));
      const failed = { _tag: "failed", failure: "usage-limit", retryAt: resumesAt } as const;

      yield* control.finishTurn({
        sessionId,
        turnId: limited,
        outcome: failed,
        continuation: { resumesAt },
      });
      const resumed = yield* control.resumeContinuation({ sessionId, turnId: limited });
      yield* control.finishTurn({
        sessionId,
        turnId: resumed,
        outcome: failed,
        continuation: { resumesAt },
      });
      yield* control.dropContinuation({ sessionId, turnId: resumed });

      const events = [...(yield* take(sessionId, cursorOf(first), 5))];
      assert.deepStrictEqual(
        events.map((event) =>
          event._tag === "turn-finished"
            ? [event._tag, event.turnId, event.continuation]
            : event._tag === "turn-started"
              ? [event._tag, event.turnId, event.cause]
              : "turnId" in event
                ? [event._tag, event.turnId]
                : event._tag,
        ),
        [
          ["turn-started", limited, { _tag: "dispatch", key: key("dispatch-1") }],
          ["turn-finished", limited, { resumesAt }],
          ["turn-started", resumed, { _tag: "continuation", turnId: limited }],
          ["turn-finished", resumed, { resumesAt }],
          ["continuation-dropped", resumed],
        ],
      );
    }).pipe(Effect.provide(TestEngine.layer)),
  );
});
