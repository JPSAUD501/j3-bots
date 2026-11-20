// SPDX-License-Identifier: AGPL-3.0-or-later
import { QuestionAnswers } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { IdempotencyKey, TurnId } from "../ids.ts";
import { messageIdFor } from "./Keys.ts";
import {
  applyEvent,
  backgroundWorkPending,
  diff,
  dispositionOf,
  emptyMirror,
  engineAnswersOf,
  isDeleted,
  nothingToStop,
  replacement,
  startingTurns,
  toolPersistenceOf,
  toolsToResolve,
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
const run = (status: string, ordinal: number) =>
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

describe("backgroundWorkPending", () => {
  // The engine's rule (**Read** at `db51b67`, `derivePendingBackgroundWork`).
  it("counts live work left by an ended run, as the engine's stop does", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, command("running"));
    assert.isTrue(backgroundWorkPending(mirror));

    // A running run is the stop's target instead, and its turn is open.
    applyEvent(mirror, run("running", 2));
    assert.isFalse(backgroundWorkPending(mirror));
    applyEvent(mirror, run("interrupted", 2));
    applyEvent(mirror, command("interrupted"));
    assert.isFalse(backgroundWorkPending(mirror));

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
    assert.isFalse(backgroundWorkPending(mirror));

    // A task only the provider thread reports.
    applyEvent(
      mirror,
      event("provider-thread.updated", {
        id: "provider-thread-1",
        driver: "codex",
        providerInstanceId: "codex",
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
        pendingBackgroundTasks: [{ taskId: "task-1", kind: "monitor" }],
        createdAt: at,
        updatedAt: at,
      }),
    );
    assert.isTrue(backgroundWorkPending(mirror));
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
        status: "running",
      }),
    );
    // Pending until the fetch tells: the Stop waits that long.
    assert.deepStrictEqual(toolsToResolve(mirror), ["item-tool"]);
    assert.isTrue(backgroundWorkPending(mirror));

    mirror.toolPersistence.set(
      "item-tool",
      toolPersistenceOf({ persistent: true, script: "x".repeat(20_000) }),
    );
    assert.deepStrictEqual(toolsToResolve(mirror), []);
    assert.isFalse(backgroundWorkPending(mirror));

    mirror.toolPersistence.set("item-tool", toolPersistenceOf({ script: "x".repeat(20_000) }));
    assert.isTrue(backgroundWorkPending(mirror));

    // The engine's read cut it short too: unknown, which never holds a Stop.
    mirror.toolPersistence.set(
      "item-tool",
      toolPersistenceOf('{"script":"xxxx\n… output truncated for transport'),
    );
    assert.isFalse(backgroundWorkPending(mirror));
  });
});

describe("what a Stop leaves to run", () => {
  it("counts only what a Stop targets: no turn but the queue's, no background work", () => {
    const mirror = emptyMirror();
    applyEvent(mirror, run("completed", 1));
    applyEvent(mirror, run("queued", 2));
    assert.isTrue(nothingToStop(mirror, at));

    // Work the ended turn left running keeps a refused stop from being moot.
    applyEvent(mirror, command("running"));
    assert.isFalse(nothingToStop(mirror, at));
    applyEvent(mirror, command("interrupted"));
    assert.isTrue(nothingToStop(mirror, at));

    // A turn the engine is starting, which no event has told of yet.
    applyEvent(mirror, run("starting", 3));
    assert.isFalse(nothingToStop(mirror, at));
    assert.deepStrictEqual(startingTurns(mirror), [TurnId.make("run-3")]);
    applyEvent(mirror, run("running", 3));
    assert.deepStrictEqual(startingTurns(mirror), []);
  });

  it("counts a thread the engine deleted as gone, though its record stays", () => {
    const thread = {
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
    const mirror = emptyMirror();
    applyEvent(mirror, event("thread.created", thread));
    assert.isFalse(isDeleted(mirror));
    applyEvent(mirror, event("thread.deleted", { ...thread, deletedAt: at }));
    assert.isTrue(isDeleted(mirror));
  });
});
