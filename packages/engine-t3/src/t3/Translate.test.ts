// SPDX-License-Identifier: AGPL-3.0-or-later
import { ModelId, ProviderId, QuestionAnswers } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { TurnCause } from "../events.ts";
import { DelegatedResultId, EventCursor, IdempotencyKey, SessionId, TurnId } from "../ids.ts";
import { toolInputDigest } from "../toolCaller.ts";
import { makeBatches } from "./Batches.ts";
import { messageIdFor } from "./Keys.ts";
import {
  applyEvent,
  backgroundWorkOf,
  diff,
  digestToolCalls,
  dispositionOf,
  emptyMirror,
  engineAnswersOf,
  type EventBody,
  type Providers,
  isDeleted,
  isOver,
  mirrorOf,
  nothingToStop,
  replacement,
  reportedWorkOf,
  runnableTurns,
  toolsToResolve,
  workInShell,
} from "./Translate.ts";

/** These turns run on no provider of J3 Bots's: their model is not what is tested. */
const noProviders: Providers = {
  modelOf: () => null,
  echoesSteers: () => false,
  redact: (text) => text,
};

const answers = Schema.decodeUnknownSync(QuestionAnswers);

const colour: OrchestrationV2UserInputQuestion = {
  id: "colour choice",
  header: "Colour",
  question: "Which colour?",
  options: [
    { label: " Red ", description: "Warm" },
    { label: "Blue", description: "Cold", value: "#00f" },
  ],
};
const tags: OrchestrationV2UserInputQuestion = {
  id: "tags",
  header: "Tags",
  question: "Which tags?",
  options: [
    { label: "Urgent", description: "Now" },
    { label: "Later", description: "Someday" },
  ],
  multiSelect: true,
  allowCustomAnswer: false,
};

describe("engineAnswersOf", () => {
  it("answers in the engine's own question keys and option values", () => {
    assert.deepStrictEqual(
      engineAnswersOf(
        [colour, tags],
        answers({
          "question-1": { optionIds: ["option-2"], text: null },
          "question-2": { optionIds: ["option-1", "option-2"], text: null },
        }),
      ),
      { "colour choice": "#00f", tags: ["Urgent", "Later"] },
    );
    // An option without a value is answered with its trimmed label, as the engine's client does.
    assert.deepStrictEqual(
      engineAnswersOf([colour], answers({ "question-1": { optionIds: ["option-1"], text: null } })),
      { "colour choice": "Red" },
    );
  });

  it("sends a typed answer alone, and only where the question takes one", () => {
    assert.deepStrictEqual(
      engineAnswersOf(
        [colour],
        answers({ "question-1": { optionIds: ["option-1"], text: "  Green " } }),
      ),
      { "colour choice": "Green" },
    );
    assert.isUndefined(
      engineAnswersOf([colour, tags], answers({ "question-2": { optionIds: [], text: "Soon" } })),
    );
  });

  it("keeps an answer to a question whose id is `__proto__`", () => {
    // An ACP form's field names are its question ids, and any name is one.
    const proto = { ...colour, id: "__proto__" };
    const answered = engineAnswersOf(
      [proto],
      answers({ "question-1": { optionIds: [], text: "Green" } }),
    );
    assert.deepStrictEqual(answered && Object.entries(answered), [["__proto__", "Green"]]);
  });

  it("refuses answers that do not fit the questions", () => {
    assert.isUndefined(
      engineAnswersOf(
        [colour],
        answers({ "question-1": { optionIds: ["option-1", "option-2"], text: null } }),
      ),
    );
    assert.isUndefined(
      engineAnswersOf([colour], answers({ "question-1": { optionIds: ["option-3"], text: null } })),
    );
    assert.isUndefined(
      engineAnswersOf([colour], answers({ "question-2": { optionIds: ["option-1"], text: null } })),
    );
  });
});

describe("a start the engine queues behind another turn", () => {
  const at = DateTime.makeUnsafe("2026-11-20T12:00:00Z");
  const key = IdempotencyKey.make("dispatch-2");
  const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
  const event = (type: string, payload: unknown) =>
    decodeEvent({ id: `event-${type}`, threadId: "thread-1", occurredAt: at, type, payload });
  const run = (fields: Record<string, unknown>) =>
    Schema.decodeUnknownSync(OrchestrationV2Run)({
      threadId: "thread-1",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      providerThreadId: null,
      rootNodeId: null,
      activeAttemptId: null,
      requestedAt: at,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      ...fields,
    });
  const running = run({
    id: "run-1",
    ordinal: 1,
    userMessageId: "message-1",
    status: "running",
    startedAt: at,
  });
  const queued = run({
    id: "run-2",
    ordinal: 2,
    userMessageId: messageIdFor("start", key),
    status: "queued",
    queuePosition: 1,
  });

  const turnId = TurnId.make(queued.id);

  // The pinned engine creates the queued run, with no item for its message,
  // and records the message as `queued_turn` only when the run leaves the queue
  // (**Read** at `bc0f04d`, `Orchestrator.ts`, L8285-8337 and L3133-3195).
  it("is queued from its run, before the engine records its message", () => {
    const mirror = emptyMirror();
    mirror.runs.set(running.id, running);
    const { view } = replacement(mirror, false, at, new Map(), noProviders);

    applyEvent(mirror, event("run.created", queued));
    assert.deepStrictEqual(diff(mirror, view, at, noProviders), [
      { _tag: "turn-queued", turnId, cause: { _tag: "dispatch", key } },
    ]);
    assert.deepStrictEqual(dispositionOf(mirror, key), Option.some({ _tag: "queued", turnId }));

    // Leaving the queue: the run is starting, and its message is recorded.
    applyEvent(
      mirror,
      event("run.updated", { ...queued, status: "starting", queuePosition: null }),
    );
    applyEvent(
      mirror,
      event("turn-item.updated", {
        id: "item-message-2",
        threadId: "thread-1",
        runId: queued.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 200,
        status: "completed",
        title: null,
        type: "user_message",
        messageId: queued.userMessageId,
        createdBy: "user",
        creationSource: "server",
        inputIntent: "queued_turn",
        text: "<j3-wake>dispatch-2</j3-wake>",
        attachments: [],
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      }),
    );
    assert.deepStrictEqual(diff(mirror, view, at, noProviders), []);
    assert.deepStrictEqual(dispositionOf(mirror, key), Option.some({ _tag: "queued", turnId }));
  });

  // Stop cancels the queued start between the engine's reply and the read
  // that follows it: the run is cancelled, with no queue position and no item.
  it("stays queued when the start was cancelled before it left the queue", () => {
    const mirror = emptyMirror();
    mirror.runs.set(running.id, running);
    mirror.runs.set(
      queued.id,
      run({ ...queued, status: "cancelled", queuePosition: null, completedAt: at }),
    );
    assert.deepStrictEqual(dispositionOf(mirror, key), Option.some({ _tag: "queued", turnId }));
  });
});

const at = DateTime.makeUnsafe("2026-11-20T12:00:00Z");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const event = (type: string, payload: unknown) =>
  decodeEvent({ id: `event-${type}`, threadId: "thread-1", occurredAt: at, type, payload });
const LIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const run = (status: string, ordinal: number, fields: Record<string, unknown> = {}) =>
  event("run.updated", {
    id: `run-${ordinal}`,
    ordinal,
    userMessageId: `message-${ordinal}`,
    status,
    threadId: "thread-1",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    providerThreadId: "provider-thread-1",
    rootNodeId: null,
    activeAttemptId: null,
    requestedAt: at,
    startedAt: status === "queued" || status === "starting" ? null : at,
    completedAt: LIVE_RUN.has(status) ? null : at,
    checkpointId: null,
    contextHandoffId: null,
    ...fields,
  });
const item = (fields: Record<string, unknown>) =>
  event("turn-item.updated", {
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 10,
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    ...fields,
  });
const command = (status: string) =>
  item({ id: "item-command", type: "command_execution", input: "npm run dev", status });
/** A provider thread of the session, reporting these background tasks, in an event of `runId`. */
const providerThread = (
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<Record<string, unknown>> = taskIds.map((taskId) => ({
    taskId,
    kind: "command",
  })),
  runId?: string,
  fields: Record<string, unknown> = {},
) =>
  decodeEvent({
    id: "event-provider-thread",
    threadId: "thread-1",
    ...(runId === undefined ? {} : { runId }),
    occurredAt: at,
    type: "provider-thread.updated",
    payload: {
      id: "provider-thread-1",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: tasks,
      createdAt: at,
      updatedAt: at,
      ...fields,
    },
  });
/** Every capability of `keys` off. */
const off = (...keys: ReadonlyArray<string>) => Object.fromEntries(keys.map((key) => [key, false]));
/** What a provider session says it can do; nothing here reads it. */
const capabilities = {
  sessions: off(
    "supportsMultipleProviderThreadsPerSession",
    "supportsModelSwitchInSession",
    "supportsProviderSwitchingViaHandoff",
    "supportsRuntimeModeSwitchInSession",
    "pendingRequestsSurviveRestart",
  ),
  threads: off(
    "canCreateEmptyThread",
    "canReadThreadSnapshot",
    "canRollbackThread",
    "canForkThread",
    "canForkFromTurn",
    "canForkFromSubagentThread",
    "exposesNativeThreadId",
  ),
  turns: {
    ...off(
      "exposesNativeTurnId",
      "emitsTurnStarted",
      "emitsTurnCompleted",
      "supportsInterrupt",
      "supportsActiveSteering",
      "supportsSteeringByInterruptRestart",
      "supportsQueuedMessages",
    ),
    terminalStatusQuality: "strong",
  },
  streaming: off(
    "streamsAssistantText",
    "streamsReasoning",
    "streamsToolOutput",
    "streamsPlanText",
    "emitsMessageCompleted",
  ),
  tools: off(
    "exposesToolItemIds",
    "emitsToolStarted",
    "emitsToolCompleted",
    "emitsToolOutput",
    "supportsMcpTools",
    "supportsDynamicToolCallbacks",
  ),
  approvals: off(
    "supportsCommandApproval",
    "supportsFileReadApproval",
    "supportsFileChangeApproval",
    "supportsApplyPatchApproval",
    "approvalsHaveNativeRequestIds",
    "approvalCallbacksAreLiveOnly",
    "approvalsCanOriginateFromSubagents",
  ),
  planning: off(
    "emitsPlanUpdated",
    "emitsTodoList",
    "emitsProposedPlan",
    "supportsStructuredQuestions",
    "planDeltasHaveItemIds",
  ),
  subagents: off(
    "supportsSubagents",
    "exposesSubagentThreadIds",
    "emitsSubagentLifecycle",
    "canWaitForSubagents",
    "canCloseSubagents",
    "canForkSubagentThread",
  ),
  context: {
    ...off(
      "acceptsSystemContext",
      "acceptsDeveloperContext",
      "acceptsSyntheticUserContext",
      "canGenerateSummaries",
      "canConsumeHandoffSummaries",
      "supportsDeltaHandoff",
      "supportsFullThreadHandoff",
    ),
    maxRecommendedHandoffChars: null,
  },
  checkpointing: off(
    "appCanCheckpointFilesystem",
    "supportsNestedCheckpointScopes",
    "providerCanRollbackConversation",
    "providerRollbackReturnsSnapshot",
    "providerCanReadConversationSnapshot",
  ),
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
};
/** A provider session event (`provider-session.attached` or `.updated`) with this status. */
const providerSession = (type: string, id: string, status: string) =>
  event(type, {
    id,
    driver: "claudeAgent",
    providerInstanceId: "claude",
    status,
    cwd: "/work",
    model: null,
    capabilities,
    createdAt: at,
    updatedAt: at,
    lastError: null,
  });
/** The session's engine thread, as a thread event carries it. */
const appThread = {
  id: "thread-1",
  createdBy: "system",
  creationSource: "server",
  projectId: "project-1",
  title: "Ana",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
};
/** What each `turn-finished` among the events `diff` made says of background work. */
const backgroundAtEnd = (events: ReadonlyArray<{ readonly _tag: string }>) =>
  events.flatMap((event) =>
    event._tag === "turn-finished" && "backgroundWork" in event ? [event.backgroundWork] : [],
  );
/**
 * Background work pending in these turns, and work attributed to none if
 * `unattributed`; by default all of it is what the engine's stop ends.
 */
const pendingIn = (
  ids: ReadonlyArray<string>,
  unattributed = false,
  stoppable = ids.length > 0 || unattributed,
) => ({
  turns: ids.map((id) => TurnId.make(id)),
  unattributed,
  stoppable,
});
const NONE = pendingIn([]);
describe("backgroundWorkOf", () => {
  // The engine's rule (**Read** at `bc0f04d`, `derivePendingBackgroundWork`).
  it("counts live work left by an ended run, as the engine's stop does", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, command("running"));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"]));

    // A running run is the stop's target instead, and its turn is open.
    applyEvent(mirror, run("running", 2));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, NONE);
    applyEvent(mirror, run("interrupted", 2));
    applyEvent(mirror, command("interrupted"));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, NONE);

    // A tool the agent keeps running on purpose is never pending.
    applyEvent(
      mirror,
      item({
        id: "item-tool",
        type: "dynamic_tool",
        toolName: "dev_server",
        input: { persistent: true },
        status: "running",
      }),
    );
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, NONE);

    // A task only the provider thread reports, in an event of no run.
    applyEvent(mirror, providerThread(["task-1"]));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn([], true));
  });

  // Each piece goes to the run the engine gives it: a task's stamped run, an
  // item's own (**Read** at `bc0f04d`, `ProjectionStore.ts`, L955-972).
  it("attributes each piece of work to the turn that started it, in the order they ran", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, providerThread([], [{ taskId: "task-1", kind: "subagent" }], "run-1"));
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("running", 2));
    // The adapter resends its whole roster: the first task keeps its run.
    const roster = [
      { taskId: "task-1", kind: "subagent" },
      { taskId: "task-2", kind: "background_task" },
    ];
    applyEvent(mirror, providerThread([], roster, "run-2"));
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1", "run-2"]));

    // The first turn's work ends; the second's still runs.
    applyEvent(
      mirror,
      providerThread([], [{ taskId: "task-2", kind: "background_task" }], "run-3"),
    );
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-2"]));
  });

  // Claude Code reports a monitor the agent awaits as a task of its provider
  // thread, with no run: the engine's projection stamps the run that reported
  // it (**Read** at `bc0f04d`, `ProjectionStore.ts`, L955-972; the
  // `claude_background_monitor_wake` fixture).
  it("counts a task that holds the agent's completion as the turn's hand-off", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    const monitor = { taskId: "task-1", kind: "monitor", awaited: true };
    applyEvent(mirror, providerThread([], [monitor], "run-1"));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(backgroundAtEnd(diff(mirror, view, at, noProviders)), [true]);

    // Still running when the next turn ends: it is the first turn's, not this one's.
    applyEvent(mirror, providerThread([], [monitor], "run-2"));
    applyEvent(mirror, run("running", 2));
    diff(mirror, view, at, noProviders);
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(backgroundAtEnd(diff(mirror, view, at, noProviders)), [false]);
  });

  // A replacement comes once the stream lost replay coverage: by then the
  // task may have woken the session and left the roster.
  it("keeps a turn's hand-off as its end told it, after the work has left the roster", () => {
    const session = SessionId.make("thread-1");
    const batches = makeBatches(32);
    batches.open(session);
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(
      mirror,
      providerThread([], [{ taskId: "task-1", kind: "background_task" }], "run-1"),
    );
    applyEvent(mirror, run("completed", 1));
    const told = diff(mirror, view, at, noProviders);
    assert.deepStrictEqual(backgroundAtEnd(told), [true]);
    batches.keep(
      session,
      "stream-1",
      { sequence: 3, part: 0 },
      {
        mirror,
        view,
        events: told.map((body, index) => ({
          ...body,
          cursor: EventCursor.make(`3.0.${index}.${told.length}.stream-1`),
          at,
        })),
      },
    );

    // The task ends after the turn did, and wakes the session.
    applyEvent(mirror, providerThread([], [], "run-2"));
    applyEvent(mirror, run("running", 2));
    applyEvent(mirror, run("completed", 2));
    const { event } = replacement(mirror, true, at, batches.toldHandoffs(session), noProviders);
    assert.deepStrictEqual(
      event.endedTurns.map((turn) => [turn.turnId, turn.backgroundWork]),
      [
        [TurnId.make("run-1"), true],
        [TurnId.make("run-2"), false],
      ],
    );
  });

  // A stream that missed the turn's end, by a reconnect the engine answered
  // with a snapshot, first hears of it in a replacement.
  it("keeps a hand-off a replacement told first, and never over a live end's", () => {
    const session = SessionId.make("thread-1");
    const batches = makeBatches(32);
    batches.open(session);
    const keep = (place: number, bodies: ReadonlyArray<EventBody>) =>
      batches.keep(
        session,
        "stream-1",
        { sequence: place, part: 0 },
        {
          mirror: emptyMirror(),
          view: replacement(emptyMirror(), false, at, new Map(), noProviders).view,
          events: bodies.map((body, index) => ({
            ...body,
            cursor: EventCursor.make(`${place}.0.${index}.${bodies.length}.stream-1`),
            at,
          })),
        },
      );
    const mirror = emptyMirror();
    applyEvent(
      mirror,
      providerThread([], [{ taskId: "task-1", kind: "background_task" }], "run-1"),
    );
    applyEvent(mirror, run("completed", 1));
    keep(3, [replacement(mirror, true, at, batches.toldHandoffs(session), noProviders).event]);

    // The task ends and wakes the session; the next replacement repeats the
    // hand-off as the first one told it.
    applyEvent(mirror, providerThread([], [], "run-2"));
    applyEvent(mirror, run("completed", 2));
    const handoffs = () =>
      replacement(
        mirror,
        true,
        at,
        batches.toldHandoffs(session),
        noProviders,
      ).event.endedTurns.map((turn) => [turn.turnId, turn.backgroundWork]);
    assert.deepStrictEqual(handoffs(), [
      [TurnId.make("run-1"), true],
      [TurnId.make("run-2"), false],
    ]);

    // A replacement that tells a turn otherwise than its live end did leaves
    // the live end's word.
    keep(4, [
      {
        _tag: "turn-finished",
        turnId: TurnId.make("run-2"),
        finishedAt: at,
        cause: { _tag: "background", origin: null },
        outcome: { _tag: "completed" },
        backgroundWork: true,
        continuation: null,
        contextRecovered: false,
      },
    ]);
    keep(5, [replacement(mirror, true, at, new Map(), noProviders).event]);
    assert.deepStrictEqual(handoffs(), [
      [TurnId.make("run-1"), true],
      [TurnId.make("run-2"), true],
    ]);
  });

  // The engine's stop fires when its rule counts work, which reads the active
  // provider thread's tasks, and interrupts the latest run's provider thread
  // (**Read** at `bc0f04d`, `Orchestrator.ts`, L14692-14731, L14111-14132). A
  // fresh-context start reports its new provider thread with no thread event,
  // and the projection makes any reported one active unless it only reserves
  // a seat (`ProjectionStore.ts`, L1172-1180).
  it("counts as stoppable the latest run's provider thread's tasks, when the stop fires", () => {
    const mirror = emptyMirror();
    applyEvent(
      mirror,
      event("thread.created", { ...appThread, activeProviderThreadId: "provider-thread-1" }),
    );
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, providerThread([]));
    applyEvent(mirror, run("completed", 2, { providerThreadId: "provider-thread-2" }));
    const fresh = { id: "provider-thread-2", firstRunOrdinal: 2 };
    applyEvent(mirror, providerThread(["task-fresh"], undefined, "run-2", fresh));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-2"]));

    // A thread that only reserves a seat for a queued run does not take over.
    applyEvent(
      mirror,
      providerThread(["task-seat"], undefined, undefined, {
        id: "provider-thread-3",
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
      }),
    );
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-2"]));

    // A late report from the old provider thread makes it active: with no task
    // there and no live item, the engine's rule counts nothing and the stop
    // does not fire.
    applyEvent(mirror, providerThread([]));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-2"], false, false));
  });

  // A fresh-context start queued behind a turn leaves the old provider session
  // running while it has background work; its provider thread reports the task
  // until it ends, and the engine's stop does not reach it (**Read** at
  // `bc0f04d`, `Orchestrator.ts`, L2851-2894, L14193-14243; the testkit's
  // "Fresh context with an old session's background task").
  it("reports a task an old provider session still runs after a fresh context, out of the stop's reach", () => {
    const mirror = emptyMirror();
    applyEvent(
      mirror,
      event("thread.created", { ...appThread, activeProviderThreadId: "provider-thread-1" }),
    );
    applyEvent(mirror, providerSession("provider-session.attached", "session-1", "starting"));
    applyEvent(mirror, providerSession("provider-session.updated", "session-1", "ready"));
    applyEvent(mirror, run("running", 1));
    const old = { providerSessionId: "session-1" };
    applyEvent(mirror, providerThread(["task-old"], undefined, "run-1", old));
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, providerSession("provider-session.attached", "session-2", "ready"));
    const onFresh = { providerThreadId: "provider-thread-2" };
    const fresh = { id: "provider-thread-2", providerSessionId: "session-2", firstRunOrdinal: 2 };
    const freshCommand = (status: string) =>
      item({
        id: "item-fresh-command",
        runId: "run-2",
        type: "command_execution",
        input: "npm run dev",
        status,
      });
    applyEvent(mirror, run("running", 2, onFresh));
    applyEvent(mirror, providerThread([], undefined, "run-2", fresh));
    applyEvent(mirror, freshCommand("running"));
    applyEvent(mirror, run("completed", 2, onFresh));
    // The fresh run left work the stop ends, beside the old session's.
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1", "run-2"]));
    assert.isFalse(nothingToStop(mirror, at));

    applyEvent(mirror, freshCommand("interrupted"));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"], false, false));
    assert.isTrue(nothingToStop(mirror, at));

    // A late report from the old provider thread makes it the active one, so
    // the stop fires, but it interrupts the latest run's provider thread.
    applyEvent(mirror, providerThread(["task-old"], undefined, undefined, old));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"], false, false));
    assert.isTrue(nothingToStop(mirror, at));

    // A session the engine judges stopped holds no work.
    applyEvent(mirror, providerSession("provider-session.updated", "session-1", "stopped"));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, NONE);
  });

  // The engine binds a session to the thread only when it is attached
  // (**Read** at `bc0f04d`, `ProjectionStore.ts`, L2879-2932).
  it("drops an old provider session's work once it is detached, also after a late update", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, event("thread.created", appThread));
    applyEvent(mirror, providerSession("provider-session.attached", "session-1", "ready"));
    applyEvent(mirror, run("running", 1));
    applyEvent(
      mirror,
      providerThread(["task-old"], undefined, "run-1", { providerSessionId: "session-1" }),
    );
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("completed", 2, { providerThreadId: "provider-thread-2" }));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"], false, false));

    // Archiving detaches the session, which ends its work.
    applyEvent(
      mirror,
      event("provider-session.detached", { providerSessionId: "session-1", detachedAt: at }),
    );
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, NONE);
    applyEvent(mirror, providerSession("provider-session.updated", "session-1", "ready"));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, NONE);
  });

  // Follow-ups can share a child thread, and the engine's rule counts agents,
  // one per child thread (**Read** at `bc0f04d`,
  // `orchestrationV2PendingBackgroundWork.ts`, L318-326). Each follow-up is
  // still the work of the turn that sent it.
  it("keeps every turn that sent a follow-up to a shared child thread", () => {
    const mirror = emptyMirror();
    const first = { taskId: "task-1", kind: "subagent", childThreadId: "thread-child" };
    const followUp = { taskId: "task-2", kind: "subagent", childThreadId: "thread-child" };
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, providerThread([], [first], "run-1"));
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("running", 2));
    applyEvent(mirror, providerThread([], [first, followUp], "run-2"));
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1", "run-2"]));
  });

  // The engine's stop fires on its rule's list, which reads the active
  // provider thread's tasks and the live items before it keeps one subagent
  // per child thread (**Read** at `bc0f04d`,
  // `orchestrationV2PendingBackgroundWork.ts`, L289-326; `Orchestrator.ts`,
  // L14718-14731).
  it("counts a live subagent item as firing the stop, though another provider thread lists its child thread first", () => {
    const mirror = emptyMirror();
    applyEvent(
      mirror,
      event("thread.created", { ...appThread, activeProviderThreadId: "provider-thread-1" }),
    );
    applyEvent(mirror, run("completed", 1));
    const onFresh = { providerThreadId: "provider-thread-2" };
    applyEvent(mirror, run("running", 2, onFresh));
    const fresh = { id: "provider-thread-2", firstRunOrdinal: 2 };
    const task = { taskId: "task-child", kind: "subagent", childThreadId: "thread-child" };
    applyEvent(mirror, providerThread([], [task], "run-2", fresh));
    applyEvent(
      mirror,
      item({
        id: "item-child",
        runId: "run-2",
        type: "subagent",
        subagentId: "node-child",
        origin: "provider_native",
        driver: "claudeAgent",
        providerInstanceId: "claude",
        childThreadId: "thread-child",
        prompt: "Review the change",
        result: null,
        status: "running",
      }),
    );
    applyEvent(mirror, run("completed", 2, onFresh));
    // A late report from the old provider thread makes it active, with no
    // task of its own: the live item alone fires the stop.
    applyEvent(mirror, providerThread([]));
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-2"]));
  });

  it("leaves a monitor the agent does not await to wake the session on its own", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, providerThread([], [{ taskId: "task-1", kind: "monitor" }], "run-1"));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(backgroundAtEnd(diff(mirror, view, at, noProviders)), [false]);
    // The engine's stop still counts it, as the first turn's.
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"]));
  });

  // The stream sends a dynamic tool input above 16 KiB as `{summary, truncated}`
  // (**Read** at `bc0f04d`, `WireProjection.ts`, `summarizeDynamicValue`).
  it("asks the item fetched whole whether a tool the stream summarized is persistent", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(
      mirror,
      item({
        id: "item-tool",
        type: "dynamic_tool",
        toolName: "dev_server",
        input: { summary: '{"persistent":true,"script":"…', truncated: true },
        nativeItemRef: { driver: "codex", nativeId: "call-7", strength: "strong" },
        status: "running",
      }),
    );
    // Pending until the fetch tells: the Stop waits that long.
    assert.deepStrictEqual(toolsToResolve(mirror), ["item-tool"]);
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"]));

    mirror.toolPersistence.set("item-tool", "persistent");
    assert.deepStrictEqual(toolsToResolve(mirror), []);
    assert.deepStrictEqual(backgroundWorkOf(mirror), { pending: NONE, undecided: [] });

    mirror.toolPersistence.set("item-tool", "transient");
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"]));

    // No read of the item could tell: the engine's projection decides it, by
    // the provider's id of the item, which is the engine's task id.
    mirror.toolPersistence.set("item-tool", "undecidable");
    const tool = { taskId: "call-7", turnId: TurnId.make("run-1") };
    const work = backgroundWorkOf(mirror);
    assert.deepStrictEqual(work, { pending: NONE, undecided: [tool] });
    // Once decided, it is its turn's.
    assert.deepStrictEqual(reportedWorkOf(mirror, work, [tool]), pendingIn(["run-1"]));
    assert.deepStrictEqual(reportedWorkOf(mirror, work, []), NONE);
  });
});

// A wake's run opens with a message the engine records in the same command
// (**Read** at `bc0f04d`, `Orchestrator.ts`, L8387 with L8461).
describe("the cause of a turn the engine started on its own", () => {
  const wakeMessage = (delegatedBy?: string) =>
    event("message.updated", {
      id: "message-2",
      threadId: "thread-1",
      runId: "run-2",
      nodeId: null,
      role: "user",
      text: "Background activity updated",
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      createdBy: "agent",
      creationSource: "server",
      ...(delegatedBy === undefined
        ? {}
        : { delegatedCompletion: { parentRunId: delegatedBy, generation: 1, taskIds: [] } }),
    });
  /** The item a delegated completion's run opens with, in place of a message item. */
  const notice = item({
    id: "item-notice",
    runId: "run-2",
    type: "notification",
    status: "completed",
    source: { kind: "delegated_task", taskIds: [] },
    outcome: "completed",
    summary: "Delegated task finished",
  });
  const steer = messageIdFor("steer", IdempotencyKey.make("steer-1"));
  const steerItem = item({
    id: "item-steer",
    runId: "run-2",
    ordinal: 20,
    type: "user_message",
    messageId: steer,
    createdBy: "user",
    creationSource: "server",
    inputIntent: "steer",
    text: "Also check the logs.",
    attachments: [],
    status: "completed",
  });
  const DELEGATED: TurnCause = { _tag: "background", origin: TurnId.make("run-1") };
  /** The cause each event of the wake's turn tells. */
  const causes = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((body) =>
      (body._tag === "turn-queued" ||
        body._tag === "turn-started" ||
        body._tag === "turn-finished") &&
      body.turnId === TurnId.make("run-2")
        ? [{ _tag: body._tag, cause: body.cause }]
        : [],
    );
  /**
   * A wake the engine starts at once, in the order it sends it: the run, its
   * message and its opening item in one command, then the run running.
   */
  const startedWake = (delegatedBy?: string) => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("starting", 2));
    applyEvent(mirror, wakeMessage(delegatedBy));
    applyEvent(mirror, notice);
    applyEvent(mirror, run("running", 2));
    return { mirror, view, started: diff(mirror, view, at, noProviders) };
  };

  it("names the turn that delegated the task whose completion woke the session", () => {
    assert.deepStrictEqual(causes(startedWake("run-1").started), [
      { _tag: "turn-started", cause: DELEGATED },
    ]);
  });

  // A harness's wake names no run or task (**Read**, `ProviderContinuationService.ts`, L247-264).
  it("names no origin for a wake that does not say", () => {
    assert.deepStrictEqual(causes(startedWake().started), [
      { _tag: "turn-started", cause: { _tag: "background", origin: null } },
    ]);
  });

  // The engine creates the queued run before it records the run's message
  // (**Read** at `bc0f04d`, `Orchestrator.ts`, L8401 and L8461).
  it("tells a wake queued behind another turn by its origin from the queue on", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("queued", 2));
    assert.deepStrictEqual(diff(mirror, view, at, noProviders), []);
    applyEvent(mirror, wakeMessage("run-1"));
    assert.deepStrictEqual(causes(diff(mirror, view, at, noProviders)), [
      { _tag: "turn-queued", cause: DELEGATED },
    ]);

    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("running", 2));
    applyEvent(mirror, notice);
    assert.deepStrictEqual(causes(diff(mirror, view, at, noProviders)), [
      { _tag: "turn-started", cause: DELEGATED },
    ]);
  });

  it("keeps its origin when a steer joins the turn", () => {
    const { mirror, view } = startedWake("run-1");
    applyEvent(mirror, steerItem);
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(causes(diff(mirror, view, at, noProviders)), [
      { _tag: "turn-finished", cause: DELEGATED },
    ]);
  });

  // A steering restart moves the run's `userMessageId` to the steer, on the
  // same run (**Read** at `bc0f04d`, `Orchestrator.ts`, L7028-7038).
  it("keeps its origin when a steer restarts the turn", () => {
    const { mirror, view } = startedWake("run-1");
    applyEvent(mirror, steerItem);
    applyEvent(mirror, run("running", 2, { userMessageId: steer }));
    applyEvent(mirror, run("completed", 2, { userMessageId: steer }));
    assert.deepStrictEqual(causes(diff(mirror, view, at, noProviders)), [
      { _tag: "turn-finished", cause: DELEGATED },
    ]);
    const { event: replaced } = replacement(mirror, true, at, new Map(), noProviders);
    assert.deepStrictEqual(
      replaced.endedTurns.flatMap((turn) =>
        turn.turnId === TurnId.make("run-2") ? [turn.cause] : [],
      ),
      [DELEGATED],
    );
  });

  // A snapshot has no run's first record: the opening is the user message
  // under the run that no message item carries, the one the notification
  // item stands for (**Read** at `bc0f04d`, `notification.ts`, L229-253).
  it("keeps its origin in a snapshot taken after a steer restarted the turn", () => {
    const steerMessage = {
      ...wakeMessage().payload,
      id: steer,
      text: "Also check the logs.",
      createdBy: "user",
    };
    const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
      thread: appThread,
      runs: [run("completed", 1).payload, run("running", 2, { userMessageId: steer }).payload],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [wakeMessage("run-1").payload, steerMessage],
      plans: [],
      turnItems: [notice.payload, steerItem.payload],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: at,
    });
    const { event: replaced } = replacement(
      mirrorOf(projection),
      false,
      at,
      new Map(),
      noProviders,
    );
    assert.deepStrictEqual(
      replaced.openTurns.map((turn) => [turn.turnId, turn.cause]),
      [[TurnId.make("run-2"), DELEGATED]],
    );
  });
});

// The engine's stop is acknowledged once queued; its interrupt can still fail
// and leave the tool running (**Read** at `bc0f04d`, `Orchestrator.ts`,
// L14736-14765). The engine's shell row lists it, from the stored input, for
// as long as it runs and is not persistent.
describe("workInShell", () => {
  const settled = { activeRunId: null, status: "completed" } as const;
  const listing = (taskIds: ReadonlyArray<string>) => ({
    ...settled,
    pendingBackgroundTasks: taskIds.map((taskId) => ({ taskId, kind: "background_task" as const })),
  });

  const tool = { taskId: "call-7", turnId: TurnId.make("run-1") };

  it("counts an undecided tool pending while the engine lists it", () => {
    assert.deepStrictEqual(workInShell(listing(["call-7"]), [tool]), [tool]);
  });

  it("settles an undecided tool the engine no longer lists, whatever else it lists", () => {
    assert.deepStrictEqual(workInShell(listing([]), [tool]), []);
    assert.deepStrictEqual(workInShell(listing(["pr-watch"]), [tool]), []);
  });

  // The shell lists nothing while its own run gate holds.
  it("counts it pending when the shell cannot say", () => {
    assert.deepStrictEqual(workInShell(undefined, [tool]), [tool]);
    assert.deepStrictEqual(
      workInShell({ ...listing([]), activeRunId: RunId.make("run-2") }, [tool]),
      [tool],
    );
    assert.deepStrictEqual(workInShell({ ...listing([]), status: "queued" }, [tool]), [tool]);
    assert.deepStrictEqual(workInShell({ ...listing([]), status: "idle" }, [tool]), [tool]);
  });
});

describe("what a Stop leaves to run", () => {
  it("counts only what a Stop targets: no turn but the queue's, no background work", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("queued", 2));
    assert.isTrue(nothingToStop(mirror, at));
    // The engine can still run it: the Stop's cancels end it.
    assert.deepStrictEqual(runnableTurns(mirror), [TurnId.make("run-2")]);

    // Work the ended turn left running keeps a refused stop from being moot.
    applyEvent(mirror, command("running"));
    assert.isFalse(nothingToStop(mirror, at));
    applyEvent(mirror, command("interrupted"));
    assert.isTrue(nothingToStop(mirror, at));

    // A turn the engine is starting, which no event has told of yet.
    applyEvent(mirror, run("starting", 3));
    assert.isFalse(nothingToStop(mirror, at));
    assert.deepStrictEqual(runnableTurns(mirror), [TurnId.make("run-2"), TurnId.make("run-3")]);
    applyEvent(mirror, run("cancelled", 2));
    applyEvent(mirror, run("interrupted", 3));
    assert.deepStrictEqual(runnableTurns(mirror), []);
  });

  // The engine refused the stop: it interrupted nothing, so a tool that may
  // be transient may still be running.
  it("keeps a refused stop from being moot while a tool no read could decide is live", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(
      mirror,
      item({
        id: "item-tool",
        type: "dynamic_tool",
        toolName: "dev_server",
        input: { summary: '{"script":"…', truncated: true },
        status: "running",
      }),
    );
    mirror.toolPersistence.set("item-tool", "undecidable");
    assert.isFalse(nothingToStop(mirror, at));
    mirror.toolPersistence.set("item-tool", "persistent");
    assert.isTrue(nothingToStop(mirror, at));
  });

  it("counts a thread its stream says the engine deleted as gone", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, event("thread.created", appThread));
    assert.isFalse(isDeleted(mirror));
    applyEvent(mirror, event("thread.deleted", { ...appThread, deletedAt: at }));
    assert.isTrue(isDeleted(mirror));
  });

  // The archive's dispatch writes `thread.archived` before the cancels of the
  // turns still queued (**Read** at `bc0f04d`, `Orchestrator.ts`, L5680-5688,
  // L5762-5790).
  it("ends an archived session's stream after its queued turns' cancels, with a run still starting", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, event("thread.created", appThread));
    applyEvent(mirror, run("starting", 1));
    applyEvent(mirror, run("queued", 2));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, event("thread.archived", { ...appThread, archivedAt: at }));
    assert.isFalse(isOver(mirror));
    applyEvent(mirror, run("cancelled", 2, { startedAt: null, queuePosition: null }));
    assert.isTrue(isOver(mirror));
    assert.deepStrictEqual(
      diff(mirror, view, at, noProviders).flatMap((body) =>
        body._tag === "turn-finished" ? [[body.turnId, body.outcome._tag]] : [],
      ),
      [[TurnId.make("run-2"), "cancelled"]],
    );
  });
});

// The pinned ACP adapter records a call the agent reported without
// arguments as `{}`, then records it again with them once it runs (**Read**
// at `bc0f04d`, `provider-acp/src/server/adapter.ts`, L5699-5700, L5852).
describe("a `j3` call recorded before its arguments", () => {
  const say = (input: unknown, status: string) =>
    item({ id: "item-say", type: "dynamic_tool", toolName: "j3.say", input, status });
  const told = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((event) =>
      event._tag === "tool-call" ? [{ state: event.state, digest: event.call.inputDigest }] : [],
    );

  it.effect("is told again with its arguments while it is open, and not once it returned", () =>
    Effect.gen(function* () {
      const args = { text: "The build is green.", done: true };
      const mirror = emptyMirror();
      applyEvent(mirror, run("running", 1));
      const { view } = replacement(mirror, false, at, new Map(), noProviders);

      applyEvent(mirror, say({}, "running"));
      yield* digestToolCalls(mirror);
      assert.deepStrictEqual(told(diff(mirror, view, at, noProviders)), [
        { state: "open", digest: yield* toolInputDigest({}) },
      ]);

      applyEvent(mirror, say(args, "running"));
      yield* digestToolCalls(mirror);
      assert.deepStrictEqual(told(diff(mirror, view, at, noProviders)), [
        { state: "open", digest: yield* toolInputDigest(args) },
      ]);
      // A subscriber that starts now is told the arguments at once.
      assert.deepStrictEqual(
        replacement(mirror, false, at, new Map(), noProviders).event.openTurns.flatMap((turn) =>
          turn.toolCalls.map((call) => call.inputDigest),
        ),
        [yield* toolInputDigest(args)],
      );

      applyEvent(mirror, say({ text: "Another." }, "completed"));
      yield* digestToolCalls(mirror);
      assert.deepStrictEqual(told(diff(mirror, view, at, noProviders)), [
        { state: "closed", digest: yield* toolInputDigest({ text: "Another." }) },
      ]);
    }),
  );
});

describe("a connector's `j3` call", () => {
  it.effect(
    "is a call the server matches and a step of the bot's work, named without its input",
    () =>
      Effect.gen(function* () {
        const args = { query: "the operator's private roadmap" };
        const mirror = emptyMirror();
        applyEvent(mirror, run("running", 1));
        const { view } = replacement(mirror, false, at, new Map(), noProviders);
        for (const [id, toolName, input] of [
          ["item-say", "j3.say", { text: "Looking." }],
          ["item-search", "j3.notion__search", args],
        ] as const) {
          applyEvent(
            mirror,
            item({ id, type: "dynamic_tool", toolName, input, status: "running" }),
          );
        }
        yield* digestToolCalls(mirror);
        const events = diff(mirror, view, at, noProviders);

        assert.deepStrictEqual(
          events.flatMap((event) => (event._tag === "tool-call" ? [event.call.tool] : [])),
          ["say", "notion__search"],
        );
        const steps = events.flatMap((event) => (event._tag === "step" ? [event.step] : []));
        assert.deepStrictEqual(
          steps.map(({ kind, tool, label }) => ({ kind, tool, label })),
          [{ kind: "tool", tool: "connector", label: "Notion: search" }],
        );
        assert.notInclude(JSON.stringify(steps), "roadmap");
      }),
  );

  it.effect("closed before anyone was told of it, is still listed with its running turn", () =>
    Effect.gen(function* () {
      // Codex's record of a call closes while the call waits on its approval.
      const args = { query: "roadmap" };
      const mirror = emptyMirror();
      applyEvent(mirror, run("running", 1));
      applyEvent(
        mirror,
        item({
          id: "item-search",
          type: "dynamic_tool",
          toolName: "j3.notion__search",
          input: args,
          status: "completed",
        }),
      );
      yield* digestToolCalls(mirror);

      const [turn] = replacement(mirror, false, at, new Map(), noProviders).event.openTurns;
      assert.deepStrictEqual(turn?.toolCalls, []);
      assert.deepStrictEqual(
        turn?.closedToolCalls.map(({ tool, inputDigest }) => ({ tool, inputDigest })),
        [{ tool: "notion__search", inputDigest: yield* toolInputDigest(args) }],
      );
    }),
  );

  it.effect("held back by an approval, is the call the approval's request names", () =>
    Effect.gen(function* () {
      // Claude Code's approval and the call it holds share the tool use's id.
      const ref = { driver: "claudeAgent", nativeId: "toolu-1", strength: "strong" };
      const mirror = emptyMirror();
      applyEvent(mirror, run("running", 1));
      const { view } = replacement(mirror, false, at, new Map(), noProviders);
      applyEvent(
        mirror,
        item({
          id: "item-search",
          type: "dynamic_tool",
          toolName: "mcp__j3__notion__search",
          input: { query: "roadmap" },
          status: "running",
          nativeItemRef: ref,
        }),
      );
      applyEvent(
        mirror,
        item({
          id: "item-approval",
          type: "approval_request",
          requestId: "request-1",
          requestKind: "command",
          prompt: "Search Notion",
          status: "waiting",
          nativeItemRef: ref,
        }),
      );
      applyEvent(
        mirror,
        event("runtime-request.updated", {
          id: "request-1",
          nodeId: "node-1",
          providerTurnId: null,
          nativeRequestRef: ref,
          kind: "command",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: at,
          resolvedAt: null,
        }),
      );
      yield* digestToolCalls(mirror);
      const events = diff(mirror, view, at, noProviders);

      const calls = events.flatMap((event) => (event._tag === "tool-call" ? [event.call] : []));
      const held = events.flatMap((event) =>
        event._tag === "request-opened" ? [event.open.heldCall] : [],
      );
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(
        held,
        calls.map((call) => call.callId),
      );
    }),
  );

  it.effect("named `send_to_user` is a connector's step, never the bot speaking", () =>
    Effect.gen(function* () {
      const mirror = emptyMirror();
      applyEvent(mirror, run("running", 1));
      const { view } = replacement(mirror, false, at, new Map(), noProviders);
      for (const [id, toolName, message] of [
        ["item-host", "send_to_user", "Shown to the operator."],
        ["item-claude", "mcp__j3__example__send_to_user", "Sent through a connector."],
        ["item-codex", "j3.example__send_to_user", "Sent through a connector."],
      ] as const) {
        applyEvent(
          mirror,
          item({ id, type: "dynamic_tool", toolName, input: { message }, status: "running" }),
        );
      }
      yield* digestToolCalls(mirror);
      const events = diff(mirror, view, at, noProviders);

      assert.deepStrictEqual(
        events.flatMap((event) => (event._tag === "host-speech" ? [event.text] : [])),
        ["Shown to the operator."],
      );
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event._tag === "step" ? [{ tool: event.step.tool, label: event.step.label }] : [],
        ),
        [
          { tool: "connector", label: "Example: send to user" },
          { tool: "connector", label: "Example: send to user" },
        ],
      );
    }),
  );
});

describe("a `j3` call that manages MCP servers or skills", () => {
  it.effect(
    "is a step of the bot's work, named without its input, and a call the server matches",
    () =>
      Effect.gen(function* () {
        const input = {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "${secret:example}" },
        };
        const mirror = emptyMirror();
        applyEvent(mirror, run("running", 1));
        const { view } = replacement(mirror, false, at, new Map(), noProviders);
        for (const [id, toolName] of [
          ["item-add", "mcp__j3__add_mcp_server"],
          ["item-skill", "j3.save_skill"],
          ["item-say", "j3.say"],
        ] as const) {
          applyEvent(
            mirror,
            item({ id, type: "dynamic_tool", toolName, input, status: "running" }),
          );
        }
        yield* digestToolCalls(mirror);
        const events = diff(mirror, view, at, noProviders);

        assert.deepStrictEqual(
          events.flatMap((event) => (event._tag === "tool-call" ? [event.call.tool] : [])),
          ["add_mcp_server", "save_skill", "say"],
        );
        const steps = events.flatMap((event) => (event._tag === "step" ? [event.step] : []));
        assert.deepStrictEqual(
          steps.map(({ tool, label }) => ({ tool, label })),
          [
            { tool: "mcp-server-added", label: "Added an MCP server" },
            { tool: "skill-saved", label: "Saved a skill" },
          ],
        );
        assert.notInclude(JSON.stringify(steps), "secret:example");
      }),
  );
});

describe("a turn the engine ran on recovered context", () => {
  // The engine records a `handoff` item in the run when the provider could not
  // resume its own conversation (**Read** at `bc0f04d`,
  // `ProviderTurnStartService.ts`, L2008, "Recovered context").
  const handoff = item({
    id: "item-handoff",
    type: "handoff",
    status: "completed",
    contextHandoffId: "handoff-1",
    fromProviderThreadIds: ["provider-thread-1"],
    toProviderThreadId: "provider-thread-2",
    fromProviderInstanceIds: ["codex"],
    toProviderInstanceId: "codex",
    strategy: "full_thread_summary",
  });
  const recovered = (events: ReturnType<typeof diff>) =>
    events.flatMap((event) => (event._tag === "turn-finished" ? [event.contextRecovered] : []));

  it("tells so when the turn ends, live and on resume", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, handoff);
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(recovered(diff(mirror, view, at, noProviders)), [true]);

    const { event: resumed } = replacement(mirror, true, at, new Map(), noProviders);
    assert.isTrue(resumed.endedTurns[0]?.contextRecovered);
  });

  it("does not for a turn that kept its conversation", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(recovered(diff(mirror, view, at, noProviders)), [false]);
  });
});

describe("a turn told after it ran", () => {
  it("carries the times the engine recorded, not the time it is told", () => {
    const startedAt = DateTime.makeUnsafe("2026-11-20T09:00:00Z");
    const finishedAt = DateTime.makeUnsafe("2026-11-20T09:05:00Z");
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    // Started and ended while the stream was down: the replay tells both at once, later.
    applyEvent(
      mirror,
      event("run.updated", {
        id: "run-1",
        ordinal: 1,
        userMessageId: "message-1",
        status: "completed",
        threadId: "thread-1",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        providerThreadId: null,
        rootNodeId: null,
        activeAttemptId: null,
        requestedAt: startedAt,
        startedAt,
        completedAt: finishedAt,
        checkpointId: null,
        contextHandoffId: null,
      }),
    );
    const times = diff(mirror, view, at, noProviders).flatMap((told) =>
      told._tag === "turn-started"
        ? [told.startedAt]
        : told._tag === "turn-finished"
          ? [told.finishedAt]
          : [],
    );
    assert.deepStrictEqual(times, [startedAt, finishedAt]);
  });
});

// Claude Code's own tools reach the engine as dynamic tools, titled by the
// adapter (**Read** in T3 Code at `bc0f04d`, `ClaudeAdapterV2.ts`,
// `CLAUDE_KNOWN_TOOL_CLASSIFICATIONS` and `formatReadToolLabel`).
describe("a Claude Code tool's step", () => {
  const steps = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((event) =>
      event._tag === "step"
        ? [{ kind: event.step.kind, tool: event.step.tool, label: event.step.label }]
        : [],
    );
  const stepOfCall = (id: string, toolName: string, title: string, input: unknown) => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1, { providerInstanceId: "claudeAgent" }));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(
      mirror,
      item({
        id,
        type: "dynamic_tool",
        toolName,
        title,
        input,
        status: "completed",
        completedAt: at,
      }),
    );
    return steps(diff(mirror, view, at, noProviders));
  };

  it("reads a file it read as the file, and a search as what it looked for", () => {
    assert.deepStrictEqual(
      stepOfCall("item-read", "Read", "Read src/app.ts", { file_path: "src/app.ts" }),
      [{ kind: "read", tool: null, label: "src/app.ts" }],
    );
    assert.deepStrictEqual(
      stepOfCall("item-grep", "Grep", "Searched for TODO in src", { pattern: "TODO", path: "src" }),
      [{ kind: "search", tool: null, label: "TODO" }],
    );
  });

  it("keeps the title the engine gave a tool J3 Bots does not name", () => {
    assert.deepStrictEqual(
      stepOfCall("item-skill", "Skill", "Skill: release-notes", { skill: "release-notes" }),
      [{ kind: "tool", tool: null, label: "Skill: release-notes" }],
    );
  });
  // The engine names the image a `Read` looked at (**Read** at `bc0f04d`,
  // `ClaudeAdapterV2.ts` L7928); the server reads it, so it travels with the step.
  it("carries the path of an image it looked at, with the step", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1, { providerInstanceId: "claudeAgent" }));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    const read = (status: "running" | "completed") =>
      item({
        id: "item-look",
        type: "dynamic_tool",
        toolName: "Read",
        title: "Read files/chart.png",
        viewedImagePath: "/work/files/chart.png",
        input: { file_path: "/work/files/chart.png" },
        status,
        ...(status === "completed" ? { completedAt: at } : {}),
      });
    const looked = (events: ReadonlyArray<EventBody>) =>
      events.flatMap((event) =>
        event._tag === "step" ? [{ tool: event.step.tool, image: event.step.viewedImage }] : [],
      );
    applyEvent(mirror, read("running"));
    assert.deepStrictEqual(looked(diff(mirror, view, at, noProviders)), [
      { tool: "image", image: "/work/files/chart.png" },
    ]);
    applyEvent(mirror, read("completed"));
    assert.deepStrictEqual(looked(diff(mirror, view, at, noProviders)), [
      { tool: "image", image: "/work/files/chart.png" },
    ]);
    // Told once per change.
    assert.deepStrictEqual(looked(diff(mirror, view, at, noProviders)), []);
  });
});

describe("what a running turn takes from outside it", () => {
  const message = (fields: Record<string, unknown>) =>
    event("message.updated", {
      threadId: "thread-1",
      nodeId: null,
      role: "user",
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      createdBy: "agent",
      creationSource: "server",
      ...fields,
    });
  /** A completion of a task `run-1` delegated, as the engine records it in `runId`. */
  const completion = (runId: string) =>
    message({
      id: "message-result",
      runId,
      text: "Delegated task node-1 [completed]:\nThe report is ready.",
      delegatedCompletion: { parentRunId: "run-1", generation: 1, taskIds: ["node-1"] },
    });
  const results = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((body) => (body._tag === "delegated-result" ? [body.result] : []));
  const RESULT = {
    resultId: DelegatedResultId.make("message-result"),
    turnId: TurnId.make("run-2"),
    origin: TurnId.make("run-1"),
    text: "Delegated task node-1 [completed]:\nThe report is ready.",
  };

  /**
   * The engine's record of a report it steered into `run-2`, at `status`: a
   * notice, not a user message (**Read** at `bc0f04d`, `notificationTurnItem`).
   */
  const steeredIn = (messageId: string, status: string) =>
    item({
      id: `item-${messageId}`,
      runId: "run-2",
      ordinal: 20,
      type: "notification",
      source: { kind: "delegated_task", taskIds: ["node-1"], childThreadId: "thread-child" },
      outcome: "completed",
      summary: "Delegated task completed",
      status,
    });

  // **Read** at `bc0f04d`, `Orchestrator.ts`, L7890-7936: the engine steers a
  // completion into whatever run is running.
  it("tells a delegated task's result steered into another turn once that turn ends with it", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("running", 2));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);

    applyEvent(mirror, completion("run-2"));
    applyEvent(mirror, steeredIn("message-result", "completed"));
    assert.deepStrictEqual(results(diff(mirror, view, at, noProviders)), []);
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(results(diff(mirror, view, at, noProviders)), [RESULT]);
    applyEvent(mirror, completion("run-2"));
    assert.deepStrictEqual(results(diff(mirror, view, at, noProviders)), []);
    // A subscriber that resumes after a gap is told it again, by the same id.
    assert.deepStrictEqual(
      replacement(mirror, true, at, new Map(), noProviders).event.delegatedResults,
      [RESULT],
    );
  });

  // The engine runs a report whose hand-over failed as a run of its own
  // (**Read** at `bc0f04d`, `EffectWorker.ts`, L366-423), and that run is
  // where the report is answered.
  it("tells no result the engine runs as a turn of its own after the turn it landed in", () => {
    // The engine sends it again as the turn ends, and its message moves there.
    const moved = emptyMirror();
    applyEvent(moved, run("completed", 1));
    applyEvent(moved, run("running", 2));
    const { view: movedView } = replacement(moved, false, at, new Map(), noProviders);
    applyEvent(moved, completion("run-2"));
    applyEvent(moved, steeredIn("message-result", "completed"));
    applyEvent(moved, run("queued", 3, { userMessageId: "message-result" }));
    applyEvent(moved, completion("run-3"));
    applyEvent(moved, run("completed", 2));
    assert.deepStrictEqual(results(diff(moved, movedView, at, noProviders)), []);

    // The new run shows before the message moves.
    const late = emptyMirror();
    applyEvent(late, run("completed", 1));
    applyEvent(late, run("running", 2));
    const { view: lateView } = replacement(late, false, at, new Map(), noProviders);
    applyEvent(late, completion("run-2"));
    applyEvent(late, steeredIn("message-result", "completed"));
    applyEvent(late, run("completed", 2));
    applyEvent(late, run("queued", 3, { userMessageId: "message-result" }));
    assert.deepStrictEqual(results(diff(late, lateView, at, noProviders)), []);
    assert.deepStrictEqual(
      replacement(late, true, at, new Map(), noProviders).event.delegatedResults,
      [],
    );
  });

  it("tells no result that opens a turn of its own, or reaches the turn that delegated it", () => {
    const own = emptyMirror();
    applyEvent(own, run("completed", 1));
    const { view: ownView } = replacement(own, false, at, new Map(), noProviders);
    applyEvent(own, run("starting", 2, { userMessageId: "message-result" }));
    applyEvent(own, completion("run-2"));
    applyEvent(own, run("running", 2, { userMessageId: "message-result" }));
    assert.deepStrictEqual(results(diff(own, ownView, at, noProviders)), []);

    const parent = emptyMirror();
    applyEvent(parent, run("running", 1));
    const { view: parentView } = replacement(parent, false, at, new Map(), noProviders);
    applyEvent(parent, completion("run-1"));
    assert.deepStrictEqual(results(diff(parent, parentView, at, noProviders)), []);
  });

  /** The task `run-1` delegated, as its item there records it. */
  const delegated = item({
    id: "item-task",
    type: "subagent",
    subagentId: "node-1",
    origin: "app_owned",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: "thread-child",
    prompt: "Find a venue.",
    result: null,
    status: "running",
  });
  const QUESTION = "Delegated task node-1 asked a question and is still working.";
  /** The task's question, as the engine tells the session of it, in `runId`. */
  const question = (runId: string) =>
    message({
      id: "message-question",
      runId,
      text: QUESTION,
      notification: {
        source: { kind: "delegated_task", taskIds: ["node-1"], childThreadId: "thread-child" },
        outcome: "updated",
        summary: "Delegated task has a question",
      },
    });

  // The engine steers a delegated task's notice as it does its completion
  // (**Read** at `bc0f04d`, `Orchestrator.ts`, L7890-7936).
  it("tells a delegated task's question steered into another turn, by the turn that delegated it", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, delegated);
    applyEvent(mirror, run("running", 2));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);

    applyEvent(mirror, question("run-2"));
    applyEvent(mirror, steeredIn("message-question", "completed"));
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(results(diff(mirror, view, at, noProviders)), [
      {
        resultId: DelegatedResultId.make("message-question"),
        turnId: TurnId.make("run-2"),
        origin: TurnId.make("run-1"),
        text: QUESTION,
      },
    ]);
  });

  it("names the turn that delegated a task whose question opens a turn", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, delegated);
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("starting", 2, { userMessageId: "message-question" }));
    applyEvent(mirror, question("run-2"));
    applyEvent(mirror, run("running", 2, { userMessageId: "message-question" }));

    const events = diff(mirror, view, at, noProviders);
    assert.deepStrictEqual(results(events), []);
    assert.deepStrictEqual(
      events.flatMap((body) => (body._tag === "turn-started" ? [body.cause] : [])),
      [{ _tag: "background", origin: TurnId.make("run-1") }],
    );
  });

  /** A J3 Bots steer of `run-1`, its record in the run at `status`. */
  const steerKey = IdempotencyKey.make("steer-1");
  const steerItem = (status: string) =>
    item({
      id: "item-steer",
      runId: "run-1",
      ordinal: 20,
      type: "user_message",
      messageId: messageIdFor("steer", steerKey),
      createdBy: "user",
      creationSource: "server",
      inputIntent: "steer",
      text: "Also check the logs.",
      attachments: [],
      status,
    });
  const taken = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((body) => (body._tag === "steer-taken" ? [[body.key, body.turnId]] : []));

  // The engine requeues only a steer whose record still waits (**Read** at
  // `bc0f04d`, `Orchestrator.ts`, `requeueUnreadSteers`).
  it("tells a steer taken once its record no longer waits, while the turn runs, on Codex", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);

    applyEvent(mirror, steerItem("pending"));
    assert.deepStrictEqual(taken(diff(mirror, view, at, noProviders)), []);
    applyEvent(mirror, steerItem("completed"));
    assert.deepStrictEqual(taken(diff(mirror, view, at, noProviders)), [
      [steerKey, TurnId.make("run-1")],
    ]);
    assert.deepStrictEqual(
      replacement(mirror, false, at, new Map(), noProviders).event.openTurns.map(
        (turn) => turn.takenSteers,
      ),
      [[steerKey]],
    );
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(taken(diff(mirror, view, at, noProviders)), []);
  });

  // The engine records a steer as handed over before Claude has it, and
  // Claude's driver then holds it waiting until Claude echoes it (**Read** at
  // `bc0f04d`, `Orchestrator.ts` L6660-6688, `ClaudeAdapterV2.ts` L15191,
  // L10171).
  it("tells a steer taken on Claude Code only once Claude echoed it", () => {
    const claude: Providers = {
      modelOf: () => null,
      echoesSteers: () => true,
      redact: (text) => text,
    };
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), claude);

    applyEvent(mirror, steerItem("completed"));
    assert.deepStrictEqual(taken(diff(mirror, view, at, claude)), []);
    assert.deepStrictEqual(
      replacement(mirror, false, at, new Map(), claude).event.openTurns.map(
        (turn) => turn.takenSteers,
      ),
      [[]],
    );
    applyEvent(mirror, steerItem("pending"));
    assert.deepStrictEqual(taken(diff(mirror, view, at, claude)), []);
    applyEvent(mirror, steerItem("completed"));
    assert.deepStrictEqual(taken(diff(mirror, view, at, claude)), [
      [steerKey, TurnId.make("run-1")],
    ]);
  });

  it("tells no steer taken on Claude Code from a snapshot that shows it handed over", () => {
    const claude: Providers = {
      modelOf: () => null,
      echoesSteers: () => true,
      redact: (text) => text,
    };
    // The snapshot falls between the engine's hand-over and Claude's hold.
    const mirror = mirrorOf(
      Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
        thread: appThread,
        runs: [run("running", 1).payload],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [steerItem("completed").payload],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: at,
      }),
    );
    const { event, view } = replacement(mirror, false, at, new Map(), claude);
    assert.deepStrictEqual(
      event.openTurns.map((turn) => turn.takenSteers),
      [[]],
    );
    applyEvent(mirror, steerItem("pending"));
    applyEvent(mirror, steerItem("completed"));
    assert.deepStrictEqual(taken(diff(mirror, view, at, claude)), [
      [steerKey, TurnId.make("run-1")],
    ]);
  });

  it("tells no steer taken that is still waiting when its turn ends", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, steerItem("pending"));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(taken(diff(mirror, view, at, noProviders)), []);
  });

  it("tells the model a turn starts on, and the session's now, by J3 Bots' provider", () => {
    const providerId = ProviderId.make("claude");
    const providers: Providers = {
      modelOf: (selection) =>
        selection.instanceId === "codex"
          ? { providerId, modelId: ModelId.make(selection.model) }
          : null,
      echoesSteers: () => false,
      redact: (text) => text,
    };
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), providers);
    applyEvent(mirror, run("running", 1));
    assert.deepStrictEqual(
      diff(mirror, view, at, providers).flatMap((body) =>
        body._tag === "turn-started" ? [body.model] : [],
      ),
      [{ providerId, modelId: ModelId.make("gpt-5") }],
    );
    // The engine moves the session's selection to each turn's as it starts it.
    applyEvent(
      mirror,
      event("thread.model-selection-updated", {
        ...appThread,
        modelSelection: { instanceId: "codex", model: "gpt-5-mini" },
      }),
    );
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(replacement(mirror, true, at, new Map(), providers).event.model, {
      providerId,
      modelId: ModelId.make("gpt-5-mini"),
    });
  });
});

describe("a turn's plan and little ones", () => {
  const works = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((event) => (event._tag === "turn-work" ? [event.work] : []));
  const todoList = (id: string, ordinal: number, steps: ReadonlyArray<[string, string]>) =>
    item({
      id,
      ordinal,
      type: "todo_list",
      planId: `plan-${id}`,
      steps: steps.map(([text, status], index) => ({ id: `step-${index + 1}`, text, status })),
      status: "completed",
      completedAt: at,
    });
  const subagent = (id: string, ordinal: number, fields: Record<string, unknown>) =>
    item({
      id,
      ordinal,
      type: "subagent",
      subagentId: `node-${id}`,
      origin: "provider_native",
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      childThreadId: null,
      prompt: "",
      result: null,
      status: "running",
      ...fields,
    });
  const started = () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    return { mirror, view };
  };

  it("tells the latest list of what is left to do as the turn's plan, each update replacing it", () => {
    const { mirror, view } = started();
    applyEvent(
      mirror,
      todoList("item-plan-1", 10, [
        ["Read the brief", "completed"],
        ["Draft the  reply\nin two parts", "running"],
        ["Send it", "pending"],
      ]),
    );
    assert.deepStrictEqual(
      works(diff(mirror, view, at, noProviders)).map((work) => work.plan),
      [
        {
          steps: [
            { text: "Read the brief", status: "done" },
            { text: "Draft the reply in two parts", status: "running" },
            { text: "Send it", status: "pending" },
          ],
        },
      ],
    );
    // Told again only when it changes.
    assert.deepStrictEqual(works(diff(mirror, view, at, noProviders)), []);

    applyEvent(mirror, todoList("item-plan-2", 14, [["Send it", "completed"]]));
    assert.deepStrictEqual(
      works(diff(mirror, view, at, noProviders)).map((work) => work.plan),
      [{ steps: [{ text: "Send it", status: "done" }] }],
    );
  });

  it("names a little one by its short description, or by a few words of its instructions, never with its result", () => {
    const { mirror, view } = started();
    applyEvent(mirror, subagent("item-a", 10, { title: "Review the diff" }));
    applyEvent(
      mirror,
      subagent("item-b", 11, {
        prompt:
          "## Task\nFind every venue in the old town that seats forty people and is open on Sundays. Then rank them by price.",
        progress: "Reading\nthe venue list",
      }),
    );
    applyEvent(mirror, subagent("item-c", 12, { prompt: "" }));
    // A Codex subagent's title is its agent path: a name, never its label.
    applyEvent(
      mirror,
      subagent("item-d", 13, {
        driver: "codex",
        providerInstanceId: "codex",
        title: "/root/explorer",
        prompt: "Check the build logs.",
      }),
    );
    const [told] = works(diff(mirror, view, at, noProviders));
    assert.deepStrictEqual(
      told?.littleOnes.map(({ label, status, finishedAt, progress }) => ({
        label,
        status,
        finishedAt,
        progress,
      })),
      [
        { label: "Review the diff", status: "working", finishedAt: null, progress: undefined },
        {
          label: "Find every venue in the old town that…",
          status: "working",
          finishedAt: null,
          progress: "Reading the venue list",
        },
        { label: null, status: "working", finishedAt: null, progress: undefined },
        {
          label: "Check the build logs",
          status: "working",
          finishedAt: null,
          progress: undefined,
        },
      ],
    );

    const done = DateTime.makeUnsafe("2026-11-20T12:05:00Z");
    applyEvent(
      mirror,
      subagent("item-a", 10, {
        title: "Review the diff",
        status: "completed",
        result: "Three issues, all in the parser.",
        completedAt: done,
      }),
    );
    applyEvent(mirror, subagent("item-c", 12, { status: "cancelled", completedAt: done }));
    const [after] = works(diff(mirror, view, at, noProviders));
    assert.deepStrictEqual(
      after?.littleOnes.map(({ status, finishedAt }) => ({ status, finishedAt })),
      [
        { status: "done", finishedAt: done },
        { status: "working", finishedAt: null },
        { status: "failed", finishedAt: done },
        { status: "working", finishedAt: null },
      ],
    );
    assert.notInclude(JSON.stringify(after), "parser");
  });

  it("goes on telling a little one the turn handed off after the turn's end, until it ends", () => {
    const { mirror, view } = started();
    applyEvent(mirror, subagent("item-task", 10, { origin: "app_owned", title: "Find a venue" }));
    applyEvent(mirror, run("completed", 1));
    const atEnd = diff(mirror, view, at, noProviders);
    const tags = atEnd.map((event) => event._tag);
    assert.isBelow(tags.indexOf("turn-work"), tags.indexOf("turn-finished"));

    applyEvent(
      mirror,
      subagent("item-task", 10, {
        origin: "app_owned",
        title: "Find a venue",
        status: "completed",
      }),
    );
    assert.deepStrictEqual(
      works(diff(mirror, view, at, noProviders)).map((work) => work.littleOnes[0]?.status),
      ["done"],
    );
    assert.deepStrictEqual(works(diff(mirror, view, at, noProviders)), []);
  });

  it("lists a turn's plan and little ones in a replacement", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, todoList("item-plan", 10, [["Read the brief", "running"]]));
    applyEvent(mirror, subagent("item-a", 11, { title: "Review the diff" }));
    const { event: replaced, view } = replacement(mirror, false, at, new Map(), noProviders);
    const [open] = replaced.openTurns;
    assert.deepStrictEqual(open?.work.plan, {
      steps: [{ text: "Read the brief", status: "running" }],
    });
    assert.deepStrictEqual(
      open?.work.littleOnes.map((one) => one.label),
      ["Review the diff"],
    );
    assert.deepStrictEqual(works(diff(mirror, view, at, noProviders)), []);
  });
});

describe("a provider the engine retries", () => {
  // The engine records a failure it retries as an error item with the attempt
  // it is on, running while it retries, completed once an attempt succeeds,
  // failed once it gives up (**Read** at `bc0f04d`, T3 Code's `session-logic.ts`,
  // `providerErrorPresentation`).
  const retryItem = (status: string) =>
    item({
      id: "item-retry",
      type: "error",
      status,
      failure: {
        class: "transport_error",
        message: "socket hang up",
        code: null,
        retryable: true,
      },
      retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 4000 },
    });
  const retrying = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((told) => (told._tag === "turn-retrying" ? [told.retrying] : []));

  it("tells the turn retrying while the engine retries, and not once an attempt succeeds", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, retryItem("running"));
    assert.deepStrictEqual(retrying(diff(mirror, view, at, noProviders)), [true]);
    assert.isTrue(
      replacement(mirror, false, at, new Map(), noProviders).event.openTurns[0]?.retrying,
    );

    applyEvent(mirror, retryItem("completed"));
    assert.deepStrictEqual(retrying(diff(mirror, view, at, noProviders)), [false]);
    // A recovered failure leaves no trace in how the turn ends.
    applyEvent(mirror, run("completed", 1));
    const ended = diff(mirror, view, at, noProviders).find((told) => told._tag === "turn-finished");
    assert.deepStrictEqual(ended?._tag === "turn-finished" && ended.outcome, {
      _tag: "completed",
    });
  });

  it("ends the turn as unreachable, with the engine's words scrubbed, once it gives up", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, retryItem("running"));
    diff(mirror, view, at, noProviders);
    applyEvent(
      mirror,
      item({
        id: "item-retry",
        type: "error",
        status: "failed",
        failure: {
          class: "transport_error",
          message: "connect failed: Authorization: Bearer abcdefghijklmnop1234",
          code: "ECONNRESET",
          retryable: false,
        },
        retry: { attempt: 5, maxAttempts: 5, retryDelayMs: null },
      }),
    );
    applyEvent(mirror, run("failed", 1));
    const told = diff(mirror, view, at, noProviders);
    // The turn's end ends its retrying: no `turn-retrying` is told after it.
    assert.deepStrictEqual(retrying(told), []);
    const ended = told.find((each) => each._tag === "turn-finished");
    assert.deepStrictEqual(ended?._tag === "turn-finished" && ended.outcome, {
      _tag: "failed",
      failure: "unreachable",
      retryAt: null,
      details: "transport_error (ECONNRESET): connect failed: Authorization: Bearer [redacted]",
    });
  });

  it("ends a turn Claude's API refused for its sign-in as signed out, without the key it was given", () => {
    const key = "gw_live_7Qm2ZxPa9LrT4kVb8NcY1sWd3Hj";
    const given: Providers = {
      ...noProviders,
      redact: (text) => text.split(key).join("[redacted]"),
    };
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), given);
    applyEvent(mirror, run("running", 1));
    diff(mirror, view, at, given);
    applyEvent(
      mirror,
      item({
        id: "item-401",
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: `API Error: 401 Incorrect API key provided: ${key}`,
          code: "api_error_401",
          retryable: null,
        },
      }),
    );
    applyEvent(mirror, run("failed", 1));
    const ended = diff(mirror, view, at, given).find((told) => told._tag === "turn-finished");
    assert.deepStrictEqual(ended?._tag === "turn-finished" && ended.outcome, {
      _tag: "failed",
      failure: "permission-error",
      retryAt: null,
      details:
        "provider_error (api_error_401): API Error: 401 Incorrect API key provided: [redacted]",
    });
  });
});

describe("a stop the provider ignores", () => {
  const interrupt = (fields: Record<string, unknown>) =>
    item({
      id: "item-interrupt",
      type: "run_interrupt_request",
      status: "completed",
      message: "Stop requested",
      ...fields,
    });
  const ignored = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((told) => (told._tag === "stop-ignored" ? [told.turnId] : []));

  it("is told once the engine marks the stop unresponsive, and cleared once it is answered", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, interrupt({}));
    // Asked, and not yet late: nothing to force.
    assert.deepStrictEqual(ignored(diff(mirror, view, at, noProviders)), []);

    applyEvent(mirror, interrupt({ unresponsiveAt: at }));
    assert.deepStrictEqual(ignored(diff(mirror, view, at, noProviders)), [TurnId.make("run-1")]);
    assert.strictEqual(
      replacement(mirror, false, at, new Map(), noProviders).event.stopIgnored,
      TurnId.make("run-1"),
    );

    applyEvent(
      mirror,
      item({
        id: "item-interrupt-result",
        type: "run_interrupt_result",
        status: "completed",
        message: "Stopped",
      }),
    );
    assert.deepStrictEqual(ignored(diff(mirror, view, at, noProviders)), [null]);
  });

  it("stays told on a turn that ended while the work it left ignores the stop", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, interrupt({ unresponsiveAt: at }));
    assert.deepStrictEqual(ignored(diff(mirror, view, at, noProviders)), [TurnId.make("run-1")]);
    // A newer turn is the one a stop acts on: the old one's ignored stop no longer counts.
    applyEvent(mirror, run("running", 2));
    assert.deepStrictEqual(ignored(diff(mirror, view, at, noProviders)), [null]);
  });
});

describe("a question past what a card used to hold", () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index}`,
    header: `Part ${index + 1}`,
    question: `Question ${index + 1}?`,
    options: Array.from({ length: 8 }, (_, option) => ({
      label: `Option ${option + 1}`,
      description: "A choice",
      ...(option === 0 ? { preview: "+-----+\n| box |\n+-----+" } : {}),
    })),
  }));

  it("opens whole, with each question's header and each option's preview", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at, new Map(), noProviders);
    applyEvent(mirror, run("running", 1));
    applyEvent(
      mirror,
      item({
        id: "item-ask",
        type: "user_input_request",
        status: "waiting",
        requestId: "request-1",
        questions: many,
      }),
    );
    const opened = diff(mirror, view, at, noProviders).find(
      (told) => told._tag === "request-opened",
    );
    assert(opened?._tag === "request-opened" && opened.open.request._tag === "question");
    const { questions } = opened.open.request;
    assert.strictEqual(questions.length, 6);
    assert.strictEqual(questions[5]?.options.length, 8);
    assert.strictEqual(questions[0].header, "Part 1");
    assert.strictEqual(questions[0].options[0]?.preview, "+-----+\n| box |\n+-----+");
    assert.notProperty(questions[0].options[1], "preview");
    // Answers map back to the engine's own keys, past the old limits too.
    assert.deepStrictEqual(
      engineAnswersOf(many, answers({ "question-6": { optionIds: ["option-8"], text: null } })),
      { q5: "Option 8" },
    );
  });
});
