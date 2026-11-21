// SPDX-License-Identifier: AGPL-3.0-or-later
import { QuestionAnswers } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  type OrchestrationV2UserInputQuestion,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { TurnCause } from "../events.ts";
import { EventCursor, IdempotencyKey, SessionId, TurnId } from "../ids.ts";
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
  isDeleted,
  nothingToStop,
  replacement,
  reportedWorkOf,
  runnableTurns,
  toolsToResolve,
  workInShell,
} from "./Translate.ts";

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
  // (**Read** at `db51b67`, `Orchestrator.ts`, L8012-8060 and L3035-3097).
  it("is queued from its run, before the engine records its message", () => {
    const mirror = emptyMirror();
    mirror.runs.set(running.id, running);
    const { view } = replacement(mirror, false, at);

    applyEvent(mirror, event("run.created", queued));
    assert.deepStrictEqual(diff(mirror, view, at), [
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
    assert.deepStrictEqual(diff(mirror, view, at), []);
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
    providerThreadId: null,
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
/** Background work pending in these turns, and work attributed to none if `unattributed`. */
const pendingIn = (ids: ReadonlyArray<string>, unattributed = false) => ({
  turns: ids.map((id) => TurnId.make(id)),
  unattributed,
});
const NONE = pendingIn([]);
describe("backgroundWorkOf", () => {
  // The engine's rule (**Read** at `db51b67`, `derivePendingBackgroundWork`).
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
  // item's own (**Read** at `db51b67`, `ProjectionStore.ts`, L936-954).
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
  // it (**Read** at `db51b67`, `ProjectionStore.ts`, L936-954; the
  // `claude_background_monitor_wake` fixture).
  it("counts a task that holds the agent's completion as the turn's hand-off", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at);
    const monitor = { taskId: "task-1", kind: "monitor", awaited: true };
    applyEvent(mirror, providerThread([], [monitor], "run-1"));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(backgroundAtEnd(diff(mirror, view, at)), [true]);

    // Still running when the next turn ends: it is the first turn's, not this one's.
    applyEvent(mirror, providerThread([], [monitor], "run-2"));
    applyEvent(mirror, run("running", 2));
    diff(mirror, view, at);
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(backgroundAtEnd(diff(mirror, view, at)), [false]);
  });

  // A replacement comes once the stream lost replay coverage: by then the
  // task may have woken the session and left the roster.
  it("keeps a turn's hand-off as its end told it, after the work has left the roster", () => {
    const session = SessionId.make("thread-1");
    const batches = makeBatches(32);
    batches.open(session);
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at);
    applyEvent(
      mirror,
      providerThread([], [{ taskId: "task-1", kind: "background_task" }], "run-1"),
    );
    applyEvent(mirror, run("completed", 1));
    const told = diff(mirror, view, at);
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
    const { event } = replacement(mirror, true, at, batches.toldHandoffs(session));
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
          view: replacement(emptyMirror(), false, at).view,
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
    keep(3, [replacement(mirror, true, at, batches.toldHandoffs(session)).event]);

    // The task ends and wakes the session; the next replacement repeats the
    // hand-off as the first one told it.
    applyEvent(mirror, providerThread([], [], "run-2"));
    applyEvent(mirror, run("completed", 2));
    const handoffs = () =>
      replacement(mirror, true, at, batches.toldHandoffs(session)).event.endedTurns.map((turn) => [
        turn.turnId,
        turn.backgroundWork,
      ]);
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
    keep(5, [replacement(mirror, true, at, new Map()).event]);
    assert.deepStrictEqual(handoffs(), [
      [TurnId.make("run-1"), true],
      [TurnId.make("run-2"), true],
    ]);
  });

  // A fresh-context start reports its new provider thread with no thread
  // event; the engine's projection makes it the active one unless it only
  // reserves a seat (**Read** at `db51b67`, `ProjectionStore.ts`, L1142-1150).
  it("follows the active provider thread as the engine switches it", () => {
    const mirror = emptyMirror();
    applyEvent(
      mirror,
      event("thread.created", { ...appThread, activeProviderThreadId: "provider-thread-1" }),
    );
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, providerThread([]));
    applyEvent(mirror, run("completed", 2));
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
  });

  it("leaves a monitor the agent does not await to wake the session on its own", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at);
    applyEvent(mirror, providerThread([], [{ taskId: "task-1", kind: "monitor" }], "run-1"));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(backgroundAtEnd(diff(mirror, view, at)), [false]);
    // The engine's stop still counts it, as the first turn's.
    assert.deepStrictEqual(backgroundWorkOf(mirror).pending, pendingIn(["run-1"]));
  });

  // The stream sends a dynamic tool input above 16 KiB as `{summary, truncated}`
  // (**Read** at `db51b67`, `WireProjection.ts`, `summarizeDynamicValue`).
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
// (**Read** at `db51b67`, `Orchestrator.ts`, L8114 with L8184).
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
    const { view } = replacement(mirror, false, at);
    applyEvent(mirror, run("starting", 2));
    applyEvent(mirror, wakeMessage(delegatedBy));
    applyEvent(mirror, notice);
    applyEvent(mirror, run("running", 2));
    return { mirror, view, started: diff(mirror, view, at) };
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
  // (**Read** at `db51b67`, `Orchestrator.ts`, L8128 and L8184).
  it("tells a wake queued behind another turn by its origin from the queue on", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("running", 1));
    const { view } = replacement(mirror, false, at);
    applyEvent(mirror, run("queued", 2));
    assert.deepStrictEqual(diff(mirror, view, at), []);
    applyEvent(mirror, wakeMessage("run-1"));
    assert.deepStrictEqual(causes(diff(mirror, view, at)), [
      { _tag: "turn-queued", cause: DELEGATED },
    ]);

    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("running", 2));
    applyEvent(mirror, notice);
    assert.deepStrictEqual(causes(diff(mirror, view, at)), [
      { _tag: "turn-started", cause: DELEGATED },
    ]);
  });

  it("keeps its origin when a steer joins the turn", () => {
    const { mirror, view } = startedWake("run-1");
    applyEvent(mirror, steerItem);
    applyEvent(mirror, run("completed", 2));
    assert.deepStrictEqual(causes(diff(mirror, view, at)), [
      { _tag: "turn-finished", cause: DELEGATED },
    ]);
  });

  // A steering restart moves the run's `userMessageId` to the steer, on the
  // same run (**Read** at `db51b67`, `Orchestrator.ts`, L6805-6815).
  it("keeps its origin when a steer restarts the turn", () => {
    const { mirror, view } = startedWake("run-1");
    applyEvent(mirror, steerItem);
    applyEvent(mirror, run("running", 2, { userMessageId: steer }));
    applyEvent(mirror, run("completed", 2, { userMessageId: steer }));
    assert.deepStrictEqual(causes(diff(mirror, view, at)), [
      { _tag: "turn-finished", cause: DELEGATED },
    ]);
    const { event: replaced } = replacement(mirror, true, at);
    assert.deepStrictEqual(
      replaced.endedTurns.flatMap((turn) =>
        turn.turnId === TurnId.make("run-2") ? [turn.cause] : [],
      ),
      [DELEGATED],
    );
  });
});

// The engine's stop is acknowledged once queued; its interrupt can still fail
// and leave the tool running (**Read** at `db51b67`, `Orchestrator.ts`,
// L14183-14212). The engine's shell row lists it, from the stored input, for
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

  it("counts a thread the engine deleted as gone, though its record stays", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, event("thread.created", appThread));
    assert.isFalse(isDeleted(mirror));
    applyEvent(mirror, event("thread.deleted", { ...appThread, deletedAt: at }));
    assert.isTrue(isDeleted(mirror));
  });
});

// The pinned ACP adapter records a call the agent reported without
// arguments as `{}`, then records it again with them once it runs (**Read**
// at `db51b67`, `provider-acp/src/server/adapter.ts`, L4657-4658, L4711).
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
      const { view } = replacement(mirror, false, at);

      applyEvent(mirror, say({}, "running"));
      yield* digestToolCalls(mirror);
      assert.deepStrictEqual(told(diff(mirror, view, at)), [
        { state: "open", digest: yield* toolInputDigest({}) },
      ]);

      applyEvent(mirror, say(args, "running"));
      yield* digestToolCalls(mirror);
      assert.deepStrictEqual(told(diff(mirror, view, at)), [
        { state: "open", digest: yield* toolInputDigest(args) },
      ]);
      // A subscriber that starts now is told the arguments at once.
      assert.deepStrictEqual(
        replacement(mirror, false, at).event.openTurns.flatMap((turn) =>
          turn.toolCalls.map((call) => call.inputDigest),
        ),
        [yield* toolInputDigest(args)],
      );

      applyEvent(mirror, say({ text: "Another." }, "completed"));
      yield* digestToolCalls(mirror);
      assert.deepStrictEqual(told(diff(mirror, view, at)), [
        { state: "closed", digest: yield* toolInputDigest({ text: "Another." }) },
      ]);
    }),
  );
});

describe("a turn the engine ran on recovered context", () => {
  // The engine records a `handoff` item in the run when the provider could not
  // resume its own conversation (**Read** at `db51b67`,
  // `ProviderTurnStartService.ts`, "Recovered context").
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
    const { view } = replacement(mirror, false, at);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, handoff);
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(recovered(diff(mirror, view, at)), [true]);

    const { event: resumed } = replacement(mirror, true, at);
    assert.isTrue(resumed.endedTurns[0]?.contextRecovered);
  });

  it("does not for a turn that kept its conversation", () => {
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at);
    applyEvent(mirror, run("running", 1));
    applyEvent(mirror, run("completed", 1));
    assert.deepStrictEqual(recovered(diff(mirror, view, at)), [false]);
  });
});

describe("a turn told after it ran", () => {
  it("carries the times the engine recorded, not the time it is told", () => {
    const startedAt = DateTime.makeUnsafe("2026-11-20T09:00:00Z");
    const finishedAt = DateTime.makeUnsafe("2026-11-20T09:05:00Z");
    const mirror = emptyMirror();
    const { view } = replacement(mirror, false, at);
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
    const times = diff(mirror, view, at).flatMap((told) =>
      told._tag === "turn-started"
        ? [told.startedAt]
        : told._tag === "turn-finished"
          ? [told.finishedAt]
          : [],
    );
    assert.deepStrictEqual(times, [startedAt, finishedAt]);
  });
});
