// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  EngineStatus,
  ModelChoice,
  PermissionMode,
  WorkStep,
  WorkStepId,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  Engine,
  type DispatchAttachment,
  type DispatchDisposition,
  type Delivery,
  type RequestResponse,
  type SecretAnswer,
} from "../Engine.ts";
import {
  EngineUnavailable,
  ProjectNotFound,
  RequestClosed,
  SessionBusy,
  SessionNotFound,
} from "../errors.ts";
import type {
  EndedTurn,
  EngineRequest,
  OpenRequest,
  OpenTurn,
  SessionEvent,
  TurnCause,
  TurnOutcome,
} from "../events.ts";
import {
  EngineProjectId,
  EventCursor,
  type IdempotencyKey,
  RequestId,
  SessionId,
  TurnId,
} from "../ids.ts";

// An in-memory engine that keeps the `Engine` contract, for testing the server
// without an engine process. It models what the server has to get right: keys
// applied once, start and steer dispositions (including a late steer becoming a
// turn of its own), turns the engine starts by itself, requests that expire
// with their turn, host speech, and resume by cursor with replay or replacement.
// The adapter's conformance suite runs the same scenarios against the real
// engine, which keeps this double honest.

/** A dispatch the engine received, as the test inspects it. */
export interface ReceivedDispatch {
  readonly key: IdempotencyKey;
  readonly text: string;
  readonly attachments: ReadonlyArray<DispatchAttachment>;
  readonly delivery: Delivery;
  readonly disposition: DispatchDisposition;
}

/** Drives the engine's side of a session, and inspects what reached it. */
export class TestEngineControl extends Context.Service<
  TestEngineControl,
  {
    /** While false, every command fails with `EngineUnavailable` and applies nothing. */
    readonly setReachable: (reachable: boolean) => Effect.Effect<void>;
    /** Adds or replaces (by id) a step of a running turn. */
    readonly step: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly step: WorkStep;
    }) => Effect.Effect<void>;
    /** The turn holds on the operator. */
    readonly openRequest: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly request: EngineRequest;
    }) => Effect.Effect<RequestId>;
    /** The bot called the host's own speech tool. */
    readonly hostSpeech: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly text: string;
    }) => Effect.Effect<void>;
    /** The turn leaves background work running when it ends. */
    readonly startBackgroundWork: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }) => Effect.Effect<void>;
    /** Ends a running turn the way the provider would. Its open requests expire. */
    readonly finishTurn: (input: {
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly outcome: TurnOutcome;
    }) => Effect.Effect<void>;
    /**
     * The engine or the harness wakes the session itself, as when background
     * work finishes. The turn starts at once, or after the running one.
     */
    readonly startEngineTurn: (input: {
      readonly sessionId: SessionId;
      readonly cause: Exclude<TurnCause, { readonly _tag: "dispatch" }>;
    }) => Effect.Effect<TurnId>;
    /** Forgets the session's event history, so a resume from any cursor gets a `replaced`. */
    readonly pruneHistory: (sessionId: SessionId) => Effect.Effect<void>;
    readonly dispatches: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ReceivedDispatch>>;
    readonly responses: (
      sessionId: SessionId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly requestId: RequestId; readonly response: RequestResponse }>
    >;
    readonly secretAnswers: (
      sessionId: SessionId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>
    >;
  }
>()("@j3-bots/engine-t3/testing/TestEngine/TestEngineControl") {}

interface TurnRecord {
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  startedAt: DateTime.Utc | null;
  readonly steps: Map<WorkStepId, WorkStep>;
  backgroundWork: boolean;
  ended: { readonly outcome: TurnOutcome; readonly sequence: number } | null;
}

interface SessionRecord {
  readonly id: SessionId;
  readonly projectId: EngineProjectId;
  retired: boolean;
  model: ModelChoice;
  permissionMode: PermissionMode;
  readonly log: Array<{ readonly sequence: number; readonly event: SessionEvent }>;
  /** A resume from a cursor below this sequence cannot be replayed. */
  replayableFrom: number;
  readonly turns: Map<TurnId, TurnRecord>;
  running: TurnId | null;
  readonly waiting: Array<TurnId>;
  readonly requests: Map<RequestId, OpenRequest>;
  readonly dispatches: Map<IdempotencyKey, ReceivedDispatch>;
  readonly responses: Array<{ readonly requestId: RequestId; readonly response: RequestResponse }>;
  readonly secretAnswers: Array<{ readonly requestId: RequestId; readonly answer: SecretAnswer }>;
  readonly subscribers: Set<Queue.Enqueue<SessionEvent, SessionNotFound | Cause.Done>>;
}

type AppliedKey =
  | { readonly command: "openSession"; readonly sessionId: SessionId }
  | { readonly command: "dispatch"; readonly sessionId: SessionId }
  | { readonly command: "interrupt" | "stop" | "respond" };

const initialStatus: EngineStatus = {
  state: { _tag: "ready" },
  pinnedVersion: "test",
  providers: [],
};

const make = Effect.gen(function* () {
  const status = yield* SubscriptionRef.make(initialStatus);
  let reachable = true;
  // One counter for every session, as the real engine numbers its events.
  let sequence = 0;
  let nextId = 0;
  const projects = new Map<string, EngineProjectId>();
  const sessions = new Map<SessionId, SessionRecord>();
  const keys = new Map<IdempotencyKey, AppliedKey>();

  const newId = (prefix: string) => `${prefix}-${++nextId}`;
  const cursorOf = (value: number) => EventCursor.make(String(value));

  const reachableOrFail = Effect.suspend(() =>
    reachable ? Effect.void : Effect.fail(new EngineUnavailable()),
  );

  /** Fails the test: the caller broke the contract, which no engine would tolerate. */
  const misuse = (what: string) => Effect.die(new Error(`Engine contract misuse: ${what}`));

  const liveSession = (sessionId: SessionId) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      return session === undefined || session.retired
        ? Effect.fail(new SessionNotFound({ sessionId }))
        : Effect.succeed(session);
    });

  const existingSession = (sessionId: SessionId) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      return session === undefined ? misuse(`no session ${sessionId}`) : Effect.succeed(session);
    });

  /** What the key already did, if anything. A key reused for another command is a bug. */
  const priorUse = (key: IdempotencyKey, command: AppliedKey["command"]) =>
    Effect.suspend(() => {
      const previous = keys.get(key);
      return previous === undefined || previous.command === command
        ? Effect.succeed(previous)
        : misuse(`key ${key} reused for ${command}`);
    });

  const emit = (
    session: SessionRecord,
    at: DateTime.Utc,
    make: (stamp: { readonly cursor: EventCursor; readonly at: DateTime.Utc }) => SessionEvent,
  ) => {
    sequence += 1;
    const event = make({ cursor: cursorOf(sequence), at });
    session.log.push({ sequence, event });
    for (const subscriber of session.subscribers) Queue.offerUnsafe(subscriber, event);
  };

  const startTurn = (session: SessionRecord, turn: TurnRecord, at: DateTime.Utc) => {
    turn.startedAt = at;
    session.running = turn.turnId;
    emit(session, at, (stamp) => ({
      _tag: "turn-started",
      ...stamp,
      turnId: turn.turnId,
      cause: turn.cause,
    }));
  };

  const addTurn = (session: SessionRecord, cause: TurnCause, at: DateTime.Utc) => {
    const turn: TurnRecord = {
      turnId: TurnId.make(newId("turn")),
      cause,
      startedAt: null,
      steps: new Map(),
      backgroundWork: false,
      ended: null,
    };
    session.turns.set(turn.turnId, turn);
    if (session.running === null) startTurn(session, turn, at);
    else session.waiting.push(turn.turnId);
    return turn;
  };

  const endTurn = (
    session: SessionRecord,
    turn: TurnRecord,
    outcome: TurnOutcome,
    at: DateTime.Utc,
  ) => {
    for (const [requestId, open] of session.requests) {
      if (open.turnId !== turn.turnId) continue;
      session.requests.delete(requestId);
      emit(session, at, (stamp) => ({
        _tag: "request-closed",
        ...stamp,
        requestId,
        resolution: "expired",
      }));
    }
    const waitingIndex = session.waiting.indexOf(turn.turnId);
    if (waitingIndex >= 0) session.waiting.splice(waitingIndex, 1);
    emit(session, at, (stamp) => ({
      _tag: "turn-finished",
      ...stamp,
      turnId: turn.turnId,
      outcome,
      backgroundWork: turn.backgroundWork,
    }));
    turn.ended = { outcome, sequence };
    if (session.running === turn.turnId) {
      session.running = null;
      const nextId = session.waiting.shift();
      const next = nextId === undefined ? undefined : session.turns.get(nextId);
      if (next !== undefined) startTurn(session, next, at);
    }
  };

  const runningTurn = (session: SessionRecord, turnId: TurnId) => {
    const turn = session.turns.get(turnId);
    return turn !== undefined && session.running === turnId && turn.ended === null
      ? Effect.succeed(turn)
      : misuse(`turn ${turnId} is not running`);
  };

  /** Stops everything in the session: the running turn, its background work, and waiting turns. */
  const stopAll = (session: SessionRecord, at: DateTime.Utc) => {
    // Emptied first, so the running turn's end below starts none of them.
    for (const turnId of session.waiting.splice(0)) {
      const turn = session.turns.get(turnId);
      if (turn !== undefined) endTurn(session, turn, { _tag: "interrupted" }, at);
    }
    const running = session.running === null ? undefined : session.turns.get(session.running);
    if (running !== undefined) {
      running.backgroundWork = false;
      endTurn(session, running, { _tag: "interrupted" }, at);
    }
  };

  const replacement = (
    session: SessionRecord,
    after: number | null,
    at: DateTime.Utc,
  ): SessionEvent => {
    const openTurns: Array<OpenTurn> = [];
    const endedTurns: Array<EndedTurn> = [];
    for (const turn of session.turns.values()) {
      if (turn.ended === null) {
        openTurns.push({
          turnId: turn.turnId,
          cause: turn.cause,
          startedAt: turn.startedAt,
          steps: [...turn.steps.values()],
        });
      } else if (after !== null && turn.ended.sequence > after) {
        endedTurns.push({
          turnId: turn.turnId,
          cause: turn.cause,
          outcome: turn.ended.outcome,
          backgroundWork: turn.backgroundWork,
        });
      }
    }
    return {
      _tag: "replaced",
      // Cursors are numbered across every session, so the latest one covers this
      // session's history too.
      cursor: cursorOf(sequence),
      at,
      openTurns,
      openRequests: [...session.requests.values()],
      endedTurns,
    };
  };

  const parseCursor = (cursor: EventCursor) => {
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  const engine = Engine.of({
    status: SubscriptionRef.changes(status),

    consoleLink: reachableOrFail.pipe(Effect.as("http://127.0.0.1/test-engine")),

    ensureProject: ({ workspacePath }) =>
      reachableOrFail.pipe(
        Effect.andThen(
          Effect.sync(() => {
            const existing = projects.get(workspacePath);
            if (existing !== undefined) return existing;
            const projectId = EngineProjectId.make(newId("project"));
            projects.set(workspacePath, projectId);
            return projectId;
          }),
        ),
      ),

    removeProject: (projectId) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const at = yield* DateTime.now;
        for (const [path, id] of projects) if (id === projectId) projects.delete(path);
        for (const session of sessions.values()) {
          if (session.projectId !== projectId || session.retired) continue;
          stopAll(session, at);
          session.retired = true;
        }
      }),

    openSession: ({ key, projectId, model, permissionMode }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const previous = yield* priorUse(key, "openSession");
        if (previous?.command === "openSession") return previous.sessionId;
        if (![...projects.values()].includes(projectId)) {
          return yield* new ProjectNotFound({ projectId });
        }
        const sessionId = SessionId.make(newId("session"));
        keys.set(key, { command: "openSession", sessionId });
        sessions.set(sessionId, {
          id: sessionId,
          projectId,
          retired: false,
          model,
          permissionMode,
          log: [],
          replayableFrom: 0,
          turns: new Map(),
          running: null,
          waiting: [],
          requests: new Map(),
          dispatches: new Map(),
          responses: [],
          secretAnswers: [],
          subscribers: new Set(),
        });
        return sessionId;
      }),

    configureSession: ({ sessionId, model, permissionMode }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = yield* liveSession(sessionId);
        if (model !== undefined) session.model = model;
        if (permissionMode !== undefined) session.permissionMode = permissionMode;
      }),

    retireSession: (sessionId) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = sessions.get(sessionId);
        if (session === undefined || session.retired) return;
        stopAll(session, yield* DateTime.now);
        session.retired = true;
      }),

    dispatch: ({ key, sessionId, text, attachments, delivery }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const previous = yield* priorUse(key, "dispatch");
        if (previous?.command === "dispatch") {
          if (previous.sessionId !== sessionId) {
            return yield* misuse(`dispatch key ${key} sent to a second session`);
          }
          const first = sessions.get(sessionId)?.dispatches.get(key);
          if (first !== undefined) return first.disposition;
        }
        const session = yield* liveSession(sessionId);
        const at = yield* DateTime.now;
        const busyWith = session.running ?? session.waiting[0];
        let disposition: DispatchDisposition;
        if (delivery._tag === "start") {
          if (busyWith !== undefined) {
            return yield* new SessionBusy({ sessionId, turnId: busyWith });
          }
          disposition = {
            _tag: "started",
            turnId: addTurn(session, { _tag: "dispatch", key }, at).turnId,
          };
        } else if (session.running === delivery.turnId) {
          disposition = { _tag: "steered", turnId: delivery.turnId };
          emit(session, at, (stamp) => ({
            _tag: "steered",
            ...stamp,
            key,
            turnId: delivery.turnId,
          }));
        } else {
          // The target turn already ended: the engine keeps the message as a turn of its own.
          disposition = {
            _tag: "new-turn",
            turnId: addTurn(session, { _tag: "dispatch", key }, at).turnId,
          };
        }
        keys.set(key, { command: "dispatch", sessionId });
        session.dispatches.set(key, { key, text, attachments, delivery, disposition });
        return disposition;
      }),

    lookupDispatch: ({ sessionId, key }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = sessions.get(sessionId);
        if (session === undefined) return { _tag: "unknown" } as const;
        const received = session.dispatches.get(key);
        return received === undefined
          ? ({ _tag: "not-applied" } as const)
          : ({ _tag: "applied", disposition: received.disposition } as const);
      }),

    interrupt: ({ key, sessionId, turnId }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = yield* liveSession(sessionId);
        if ((yield* priorUse(key, "interrupt")) !== undefined) return;
        keys.set(key, { command: "interrupt" });
        const turn = session.turns.get(turnId);
        if (turn === undefined || turn.ended !== null) return;
        endTurn(session, turn, { _tag: "interrupted" }, yield* DateTime.now);
      }),

    stop: ({ key, sessionId }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = yield* liveSession(sessionId);
        if ((yield* priorUse(key, "stop")) !== undefined) return;
        keys.set(key, { command: "stop" });
        stopAll(session, yield* DateTime.now);
      }),

    respond: ({ key, sessionId, requestId, response }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = yield* liveSession(sessionId);
        if ((yield* priorUse(key, "respond")) !== undefined) return;
        const open = session.requests.get(requestId);
        if (open === undefined) return yield* new RequestClosed({ requestId });
        const fits =
          open.request._tag === "approval"
            ? response._tag === "approval"
            : open.request._tag === "question" && response._tag !== "approval";
        if (!fits) return yield* misuse(`${response._tag} answer to a ${open.request._tag}`);
        keys.set(key, { command: "respond" });
        session.requests.delete(requestId);
        session.responses.push({ requestId, response });
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "request-closed",
          ...stamp,
          requestId,
          resolution: "answered",
        }));
      }),

    respondSecret: ({ sessionId, requestId, answer }) =>
      Effect.gen(function* () {
        yield* reachableOrFail;
        const session = yield* liveSession(sessionId);
        const open = session.requests.get(requestId);
        if (open === undefined || open.request._tag !== "secret") {
          return yield* new RequestClosed({ requestId });
        }
        session.requests.delete(requestId);
        session.secretAnswers.push({ requestId, answer });
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "request-closed",
          ...stamp,
          requestId,
          resolution: "answered",
        }));
      }),

    events: ({ sessionId, after }) =>
      Stream.callback<SessionEvent, SessionNotFound>((queue) =>
        Effect.gen(function* () {
          const session = sessions.get(sessionId);
          if (session === undefined || session.retired) {
            return yield* new SessionNotFound({ sessionId });
          }
          // Read the history and join the live feed in one step, so no event
          // falls between them.
          const at = yield* DateTime.now;
          const from = after === null ? null : parseCursor(after);
          if (from === null || from < session.replayableFrom) {
            Queue.offerUnsafe(queue, replacement(session, from, at));
          } else {
            for (const entry of session.log) {
              if (entry.sequence > from) Queue.offerUnsafe(queue, entry.event);
            }
          }
          session.subscribers.add(queue);
          yield* Effect.addFinalizer(() => Effect.sync(() => session.subscribers.delete(queue)));
        }),
      ),
  });

  const control = TestEngineControl.of({
    setReachable: (value) =>
      Effect.gen(function* () {
        reachable = value;
        yield* SubscriptionRef.update(status, (current): EngineStatus => ({
          ...current,
          state: value ? { _tag: "ready" } : { _tag: "unavailable" },
        }));
      }),

    step: ({ sessionId, turnId, step }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        turn.steps.set(step.id, step);
        emit(session, yield* DateTime.now, (stamp) => ({ _tag: "step", ...stamp, turnId, step }));
      }),

    openRequest: ({ sessionId, turnId, request }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        yield* runningTurn(session, turnId);
        const at = yield* DateTime.now;
        const open: OpenRequest = {
          requestId: RequestId.make(newId("request")),
          turnId,
          openedAt: at,
          request,
        };
        session.requests.set(open.requestId, open);
        emit(session, at, (stamp) => ({ _tag: "request-opened", ...stamp, open }));
        return open.requestId;
      }),

    hostSpeech: ({ sessionId, turnId, text }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        yield* runningTurn(session, turnId);
        emit(session, yield* DateTime.now, (stamp) => ({
          _tag: "host-speech",
          ...stamp,
          turnId,
          text,
        }));
      }),

    startBackgroundWork: ({ sessionId, turnId }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        turn.backgroundWork = true;
      }),

    finishTurn: ({ sessionId, turnId, outcome }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        const turn = yield* runningTurn(session, turnId);
        endTurn(session, turn, outcome, yield* DateTime.now);
      }),

    startEngineTurn: ({ sessionId, cause }) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        return addTurn(session, cause, yield* DateTime.now).turnId;
      }),

    pruneHistory: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* existingSession(sessionId);
        session.replayableFrom = sequence;
        session.log.length = 0;
      }),

    dispatches: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.dispatches.values()])),

    responses: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.responses])),

    secretAnswers: (sessionId) =>
      existingSession(sessionId).pipe(Effect.map((session) => [...session.secretAnswers])),
  });

  return Context.make(Engine, engine).pipe(Context.add(TestEngineControl, control));
});

/** An in-memory `Engine` and the `TestEngineControl` that drives it. */
export const layer: Layer.Layer<Engine | TestEngineControl> = Layer.effectContext(make);
