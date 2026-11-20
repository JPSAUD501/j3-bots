// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { SessionEvent } from "../events.ts";
import { SessionId } from "../ids.ts";
import { approvalOf, type FetchedChanges, type FileChangeItem } from "./approvalDetail.ts";
import { type BatchPlace, cursorFor, makeBatches } from "./Batches.ts";
import {
  applyEvent,
  changesToFetch,
  copyMirror,
  copyView,
  diff,
  emptyMirror,
  keepFetched,
  replacement,
  type EventBody,
  type Mirror,
  type View,
} from "./Translate.ts";

// Items shaped as the engine records them at the pin: the approval carries the
// provider's prompt and reason under the native id of the command or file
// change it holds back, which the provider records as an item of its own. Its
// runtime request names what it asks about: the whole item, or, for one of
// several approvals under one item, a native id of its own.

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest);
const at = DateTime.makeUnsafe("2026-11-20T12:00:00Z");
const none: FetchedChanges = new Map();

const item = (nativeId: string, fields: Record<string, unknown>, driver = "codex") =>
  decodeItem({
    id: `item-${nativeId}-${String(fields["type"])}`,
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: { driver, nativeId, strength: "strong" },
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    ...fields,
  });

/** The runtime request of an approval, asking under `nativeId`. */
const request = (nativeId: string, driver = "codex") =>
  decodeRequest({
    id: `request-${nativeId}`,
    nodeId: `node-${nativeId}`,
    providerTurnId: null,
    nativeRequestRef: { driver, nativeId, strength: "strong" },
    kind: "command",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: at,
    resolvedAt: null,
  });

/** An approval item; `options: null` leaves the options out, as some providers do. */
const approval = (nativeId: string, fields: Record<string, unknown>, driver = "codex") => {
  const {
    options = [
      { decision: "accept", label: "Allow" },
      { decision: "acceptForSession", label: "Allow for session" },
    ],
    ...rest
  } = fields;
  const decoded = item(
    nativeId,
    {
      type: "approval_request",
      requestId: `request-${nativeId}`,
      status: "waiting",
      ...(options === null ? {} : { options }),
      ...rest,
    },
    driver,
  );
  if (decoded.type !== "approval_request") throw new Error("not an approval");
  return decoded;
};

describe("approvalOf", () => {
  it("shows the held command exactly and keeps the escalation's reason apart", () => {
    const command = "pnpm db:migrate --env staging --to 0042";
    const asks = request("cmd-1");
    const asked = approval("cmd-1", {
      requestKind: "command",
      prompt: "Needs network access to reach the staging database",
    });
    const held = item("cmd-1", { type: "command_execution", input: command });
    assert.deepStrictEqual(approvalOf(asked, asks, [asked, held], none), {
      _tag: "approval",
      kind: "command",
      action: command,
      detail: null,
      reason: "Needs network access to reach the staging database",
      exact: true,
      sessionGrant: { covers: "every-command" },
    });
  });

  it("keeps every line of a multi-line command, indentation included", () => {
    const command = "cat > notes.txt <<'EOF'\n  indented first line\n\tthen a tab\nEOF\n";
    const asks = request("cmd-2");
    const asked = approval("cmd-2", { requestKind: "command", prompt: command });
    const held = item("cmd-2", { type: "command_execution", input: command });
    const shown = approvalOf(asked, asks, [held, asked], none);
    assert.strictEqual(
      shown.action,
      "cat > notes.txt <<'EOF'\n  indented first line\n\tthen a tab\nEOF",
    );
    assert.strictEqual(shown.exact, true);
    // The prompt was the command itself, so it is no reason.
    assert.strictEqual(shown.reason, null);
  });

  it("calls a file change known only by its paths a summary", () => {
    const asks = request("patch-1");
    const asked = approval("patch-1", {
      requestKind: "file-change",
      prompt: "update src/a.ts\nadd src/b.ts",
    });
    const shown = approvalOf(asked, asks, [asked], none);
    assert.strictEqual(shown.kind, "file-change");
    assert.strictEqual(shown.action, "update src/a.ts\nadd src/b.ts");
    assert.strictEqual(shown.detail, null);
    assert.strictEqual(shown.exact, false);

    const held = item("patch-1", {
      type: "file_change",
      fileName: "src/a.ts",
      changes: [{ operation: "update", path: "src/a.ts" }],
    });
    assert.strictEqual(approvalOf(asked, asks, [asked, held], none).exact, false);
  });

  it("shows a held file change by its path and diff, exactly", () => {
    const diff = "@@ -1,2 +1,2 @@\n context\n-old line\n+    new line\n";
    const asks = request("patch-2");
    const asked = approval("patch-2", {
      requestKind: "file-change",
      prompt: "Writes outside the workspace",
    });
    const held = item("patch-2", {
      type: "file_change",
      fileName: "../shared/config.json",
      diffStr: diff,
      changes: [{ operation: "update", path: "../shared/config.json" }],
    });
    const shown = approvalOf(asked, asks, [held, asked], none);
    assert.strictEqual(shown.action, "../shared/config.json");
    assert.deepStrictEqual(shown.detail, {
      operation: "update",
      text: "@@ -1,2 +1,2 @@\n context\n-old line\n+    new line",
    });
    assert.strictEqual(shown.reason, "Writes outside the workspace");
    assert.strictEqual(shown.exact, true);

    // A file with CRLF line endings has them in its diff too, and they only end its lines.
    const crlf = item("patch-2", {
      type: "file_change",
      fileName: "../shared/config.json",
      diffStr: diff.replaceAll("\n", "\r\n"),
      changes: [{ operation: "update", path: "../shared/config.json" }],
    });
    assert.strictEqual(approvalOf(asked, asks, [crlf, asked], none).exact, true);
  });

  it("shows a new file's contents exactly only when the card leaves none of them out", () => {
    // Codex records an added file's contents, not a unified diff, as `diffStr`.
    const shownFor = (contents: string) => {
      const asks = request("add-1");
      const asked = approval("add-1", { requestKind: "file-change", prompt: "Adds a file" });
      const held = item("add-1", {
        type: "file_change",
        fileName: "probe.txt",
        diffStr: contents,
        changes: [{ operation: "add", path: "probe.txt" }],
      });
      return approvalOf(asked, asks, [asked, held], none);
    };
    // CRLF line endings inside it show as the line breaks they are.
    for (const contents of [
      "codex app-server approval fixture.",
      "codex app-server approval fixture.\r\nsecond line",
    ]) {
      const shown = shownFor(contents);
      assert.deepStrictEqual(shown.detail, { operation: "add", text: contents });
      assert.strictEqual(shown.exact, true);
      assert.deepStrictEqual(shown.sessionGrant, { covers: "every-file-change" });
    }
    // Each of these endings would show as the first one does.
    for (const ending of ["\n", "\n\n", "\r\n"]) {
      const shown = shownFor(`codex app-server approval fixture.${ending}`);
      assert.strictEqual(shown.exact, false);
      assert.strictEqual(shown.action, "Adds a file");
      assert.strictEqual(shown.sessionGrant, null);
    }
  });

  it("calls a summary what asks about only part of a held command", () => {
    // Codex asks for each subcommand of a script under the script's item.
    const asked = approval("script-1", {
      requestKind: "command",
      prompt: "git push origin main",
    });
    const held = item("script-1", {
      type: "command_execution",
      input: "git commit -am wip && git push origin main",
    });
    const shown = approvalOf(asked, request("approval-uuid-1"), [asked, held], none);
    assert.strictEqual(shown.action, "git push origin main");
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(approvalOf(asked, undefined, [asked, held], none).exact, false);
  });

  it("takes nothing from an item of another run or native id", () => {
    const asks = request("cmd-3");
    const asked = approval("cmd-3", { requestKind: "command", prompt: "Run the tests" });
    const elsewhere = item("cmd-4", { type: "command_execution", input: "rm -rf /" });
    const otherRun = item("cmd-3", {
      type: "command_execution",
      input: "rm -rf /",
      runId: "run-2",
    });
    const shown = approvalOf(asked, asks, [asked, elsewhere, otherRun], none);
    assert.strictEqual(shown.action, "Run the tests");
    assert.strictEqual(shown.exact, false);
  });

  it("shows a Claude Code command as its prompt gives it, which the item trims", () => {
    // `echo a\ ` prints "a ", but the engine records `echo a\`, which prints "a".
    const command = "echo a\\ ";
    const asks = request("toolu-1", "claudeAgent");
    const asked = approval("toolu-1", { requestKind: "command", prompt: command }, "claudeAgent");
    const held = item(
      "toolu-1",
      { type: "command_execution", input: command.trim() },
      "claudeAgent",
    );
    const shown = approvalOf(asked, asks, [asked, held], none);
    assert.strictEqual(shown.action, command);
    assert.strictEqual(shown.exact, true);
    assert.strictEqual(shown.reason, null);
  });

  it("never gives a Claude Code command back as the reason, and keeps the reason it gave", () => {
    // The card drops the prompt's trailing line break; the item has the command trimmed.
    const prompt = "echo a\\ \n";
    const asks = request("toolu-3", "claudeAgent");
    const held = item("toolu-3", { type: "command_execution", input: "echo a\\" }, "claudeAgent");
    const asked = approval("toolu-3", { requestKind: "command", prompt }, "claudeAgent");
    const shown = approvalOf(asked, asks, [asked, held], none);
    assert.strictEqual(shown.action, "echo a\\ ");
    assert.strictEqual(shown.exact, true);
    assert.strictEqual(shown.reason, null);

    const explained = approval(
      "toolu-3",
      { requestKind: "command", prompt, reason: "Writes outside the project" },
      "claudeAgent",
    );
    assert.strictEqual(
      approvalOf(explained, asks, [explained, held], none).reason,
      "Writes outside the project",
    );
  });

  it("calls a Claude Code command a summary when its prompt is not the command", () => {
    const asks = request("toolu-2", "claudeAgent");
    const asked = approval(
      "toolu-2",
      { requestKind: "command", prompt: "Run the migration" },
      "claudeAgent",
    );
    const held = item(
      "toolu-2",
      { type: "command_execution", input: "pnpm db:migrate" },
      "claudeAgent",
    );
    const shown = approvalOf(asked, asks, [asked, held], none);
    assert.strictEqual(shown.action, "Run the migration");
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(shown.sessionGrant, null);
  });

  it("calls a command a summary when its last line break continues the line", () => {
    const asks = request("cmd-5");
    const asked = approval("cmd-5", { requestKind: "command", prompt: "Print a" });
    const held = item("cmd-5", { type: "command_execution", input: "echo a\\\n" });
    assert.strictEqual(approvalOf(asked, asks, [asked, held], none).exact, false);
  });

  it("calls a command a summary when it holds text the card cannot draw as it runs", () => {
    const shownFor = (input: string) => {
      const asks = request("cmd-6");
      const asked = approval("cmd-6", { requestKind: "command", prompt: "Print a" });
      const held = item("cmd-6", { type: "command_execution", input });
      return approvalOf(asked, asks, [asked, held], none);
    };
    // A carriage return is a character of the command wherever it is, and a bidi override
    // reorders the text after it on screen.
    for (const input of [
      "printf a\r",
      "printf a\r\n",
      "cd build\r\nmake",
      "echo \u202Etxt.exe",
      // A left-to-right mark draws as nothing.
      "rm -rf \u200E/tmp/build",
    ]) {
      const shown = shownFor(input);
      assert.strictEqual(shown.exact, false);
      assert.strictEqual(shown.action, "Print a");
      assert.strictEqual(shown.sessionGrant, null);
    }
    // A line feed alone ends the line and shows nothing, so the command is still exact.
    assert.strictEqual(shownFor("printf a\n").exact, true);
  });

  it("says what a session grant covers, as each provider applies it", () => {
    const diff = "@@ -1 +1 @@\n-a\n+b\n";
    const grantOf = (
      driver: string,
      requestKind: "command" | "file-change",
      options?: ReadonlyArray<unknown>,
    ) => {
      const nativeId = `${driver}-${requestKind}`;
      const held =
        requestKind === "command"
          ? item(nativeId, { type: "command_execution", input: "pnpm test" }, driver)
          : item(
              nativeId,
              {
                type: "file_change",
                fileName: "a.txt",
                diffStr: diff,
                changes: [{ operation: "update", path: "a.txt" }],
              },
              driver,
            );
      const asked = approval(
        nativeId,
        { requestKind, prompt: "pnpm test", options: options ?? null },
        driver,
      );
      const shown = approvalOf(asked, request(nativeId, driver), [asked, held], none);
      assert.strictEqual(shown.exact, true);
      return shown.sessionGrant;
    };
    // Codex grants every later request of the kind.
    assert.deepStrictEqual(grantOf("codex", "command"), { covers: "every-command" });
    assert.deepStrictEqual(grantOf("codex", "file-change"), { covers: "every-file-change" });
    // A provider whose grant is not established is offered none: Claude Code applies permission
    // suggestions the engine never records, which can switch its mode.
    assert.strictEqual(grantOf("claudeAgent", "command"), null);
    assert.strictEqual(grantOf("claudeAgent", "file-change"), null);
    assert.strictEqual(grantOf("opencode", "command"), null);
    // Options the provider lists decide whether it takes a grant at all.
    assert.strictEqual(grantOf("codex", "command", [{ decision: "accept", label: "Allow" }]), null);
    assert.deepStrictEqual(
      grantOf("codex", "command", [
        { decision: "accept", label: "Allow" },
        { decision: "acceptForSession", label: "Allow for session" },
      ]),
      { covers: "every-command" },
    );
  });

  it("offers no session grant for a summary, whatever the provider offers", () => {
    const asked = approval("cmd-7", { requestKind: "command", prompt: "Run the tests" });
    const shown = approvalOf(asked, request("cmd-7"), [asked], none);
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(shown.sessionGrant, null);
  });

  it("shows a held file change exactly once it is fetched whole, for the same version only", () => {
    const patch = "@@ -1 +1 @@\n-a\n+b\n";
    const asks = request("patch-9");
    const asked = approval("patch-9", { requestKind: "file-change", prompt: "update a.txt" });
    // As the stream sends it: the engine strips the diff from a file change that has not failed.
    const stripped = fileChange("patch-9", { changes: [{ operation: "update", path: "a.txt" }] });
    const summary = approvalOf(asked, asks, [asked, stripped], none);
    assert.strictEqual(summary.exact, false);
    assert.strictEqual(summary.action, "update a.txt");
    assert.strictEqual(summary.sessionGrant, null);

    const whole = fileChange("patch-9", {
      changes: [{ operation: "update", path: "a.txt" }],
      diffStr: patch,
    });
    const shown = approvalOf(asked, asks, [asked, stripped], new Map([[whole.id, whole]]));
    assert.strictEqual(shown.action, "a.txt");
    assert.deepStrictEqual(shown.detail, { operation: "update", text: "@@ -1 +1 @@\n-a\n+b" });
    assert.strictEqual(shown.exact, true);
    assert.deepStrictEqual(shown.sessionGrant, { covers: "every-file-change" });

    // The item moved on since it was fetched: what was fetched no longer describes it.
    const moved = fileChange("patch-9", {
      changes: [{ operation: "update", path: "a.txt" }],
      updatedAt: DateTime.makeUnsafe("2026-11-20T12:00:01Z"),
    });
    assert.strictEqual(
      approvalOf(asked, asks, [asked, moved], new Map([[whole.id, whole]])).exact,
      false,
    );
  });

  it("calls a file change a summary when the engine cut its diff", () => {
    const asks = request("patch-10");
    const asked = approval("patch-10", { requestKind: "file-change", prompt: "add big.txt" });
    const held = fileChange("patch-10", {
      changes: [{ operation: "add", path: "big.txt" }],
      diffStr: "first line\nsecond line\n… output truncated for transport",
    });
    const shown = approvalOf(asked, asks, [asked, held], none);
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(shown.action, "add big.txt");
    assert.strictEqual(shown.sessionGrant, null);
  });
});

/** A file change held back under `nativeId`, with no diff unless `fields` gives one. */
const fileChange = (nativeId: string, fields: Record<string, unknown>): FileChangeItem => {
  const decoded = item(nativeId, { type: "file_change", fileName: "a.txt", ...fields });
  if (decoded.type !== "file_change") throw new Error("not a file change");
  return decoded;
};

describe("an approval's card while it waits", () => {
  const run = Schema.decodeSync(OrchestrationV2Run)({
    id: "run-1",
    threadId: "thread-1",
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    providerThreadId: null,
    userMessageId: "message-1",
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });

  const setUp = () => {
    const mirror = emptyMirror();
    const asked = approval("patch-11", { requestKind: "file-change", prompt: "add notes.md" });
    const held = fileChange("patch-11", { changes: [{ operation: "add", path: "notes.md" }] });
    const asks = request("patch-11");
    mirror.runs.set(run.id, run);
    for (const entity of [asked, held]) mirror.items.set(entity.id, entity);
    mirror.requests.set(asks.id, asks);
    // The stream has told what the mirror holds: the approval, open, as a summary.
    const { event, view } = replacement(mirror, false, at);
    assert.deepStrictEqual(
      event.openRequests.map((open) => open.request._tag === "approval" && open.request.exact),
      [false],
    );
    const whole = fileChange("patch-11", {
      changes: [{ operation: "add", path: "notes.md" }],
      diffStr: "- Keep this list item",
    });
    return { mirror, view, told: event, asks, held, whole };
  };

  const updates = (events: ReadonlyArray<EventBody>) =>
    events.flatMap((event) => (event._tag === "request-updated" ? [event.request] : []));

  it("opens as a summary, then shows the change the adapter fetched", () => {
    const { mirror, view, held, whole } = setUp();
    assert.deepStrictEqual(
      changesToFetch(mirror).map((change) => change.id),
      [held.id],
    );
    keepFetched(mirror, whole);
    assert.deepStrictEqual(changesToFetch(mirror), []);
    const [updated, ...more] = updates(diff(mirror, view, at));
    assert.strictEqual(more.length, 0);
    assert.deepStrictEqual(updated, {
      _tag: "approval",
      kind: "file-change",
      action: "notes.md",
      detail: { operation: "add", text: "- Keep this list item" },
      reason: "add notes.md",
      exact: true,
      sessionGrant: { covers: "every-file-change" },
    });
    // Told once: the same state changes nothing.
    assert.deepStrictEqual(diff(mirror, view, at), []);
  });

  it("stays a summary when the fetch brings nothing back", () => {
    // A fetch that failed or timed out never reaches the mirror.
    const { mirror, view } = setUp();
    assert.deepStrictEqual(diff(mirror, view, at), []);
  });

  /** A stream's batches as it emits them, all at one engine sequence. */
  const emitted = () => {
    const batches = makeBatches(32);
    const sessionId = SessionId.make("thread-1");
    let part = 0;
    const emit = (mirror: Mirror, view: View, bodies: ReadonlyArray<EventBody>) => {
      const place: BatchPlace = { sequence: 7, part: part++ };
      const events = bodies.map((body, index): SessionEvent => ({
        ...body,
        cursor: cursorFor(place, index, bodies.length, "s1"),
        at,
      }));
      batches.keep(sessionId, "s1", place, {
        mirror: copyMirror(mirror),
        view: copyView(view),
        events,
      });
      return events;
    };
    return { emit, resume: (after: SessionEvent) => batches.resume(sessionId, after.cursor) };
  };

  it("fetches again on a resume from the batch that told the approval as a summary", () => {
    const { mirror, view, told, held, whole } = setUp();
    const stream = emitted();
    const [summary] = stream.emit(mirror, view, [told]);
    // The stream ended before its fetch landed; the engine has nothing new to send for the turn.
    if (summary === undefined) throw new Error("nothing emitted");
    const resumed = stream.resume(summary);
    if (resumed === undefined) throw new Error("not resumed");
    assert.deepStrictEqual(resumed.replay, []);
    assert.strictEqual(resumed.sequence, 7);
    assert.deepStrictEqual(changesToFetch(resumed.mirror), [held]);
    assert.isTrue(keepFetched(resumed.mirror, whole));
    assert.deepStrictEqual(
      updates(diff(resumed.mirror, resumed.view, at)).map(
        (request) => request._tag === "approval" && request.exact,
      ),
      [true],
    );
  });

  it("replays, on a resume, what a fetch told after the cursor at the same sequence", () => {
    const { mirror, view, told, asks, whole } = setUp();
    const stream = emitted();
    const [summary] = stream.emit(mirror, view, [told]);
    keepFetched(mirror, whole);
    const [upgrade, ...more] = stream.emit(mirror, view, diff(mirror, view, at));
    assert.strictEqual(more.length, 0);
    if (summary === undefined || upgrade === undefined) throw new Error("nothing emitted");
    const resumed = stream.resume(summary);
    if (resumed === undefined) throw new Error("not resumed");
    assert.deepStrictEqual(resumed.replay, [upgrade]);
    assert.strictEqual(resumed.lastCursor, upgrade.cursor);
    // The resumed stream goes on from the exact card: nothing to fetch, and a closure is all it tells.
    assert.deepStrictEqual(changesToFetch(resumed.mirror), []);
    resumed.mirror.requests.set(asks.id, { ...asks, status: "resolved", resolvedAt: at });
    assert.deepStrictEqual(
      diff(resumed.mirror, resumed.view, at).map((event) => event._tag),
      ["request-closed"],
    );
  });

  it("keeps only the fetch for the version held, whatever order fetches land in", () => {
    const { mirror, view, held, whole } = setUp();
    const later = DateTime.makeUnsafe("2026-11-20T12:00:05Z");
    const heldLater = { ...held, updatedAt: later };
    const wholeLater = fileChange("patch-11", {
      changes: [{ operation: "add", path: "notes.md" }],
      diffStr: "- Keep this list item\n- And this one",
      updatedAt: later,
    });
    // The item moved on while its first version was being fetched, and was asked for again.
    mirror.items.set(heldLater.id, heldLater);
    assert.deepStrictEqual(changesToFetch(mirror), [heldLater]);
    // The second fetch lands first; the first, for a version no longer held, changes nothing.
    assert.isTrue(keepFetched(mirror, wholeLater));
    assert.isFalse(keepFetched(mirror, whole));
    assert.deepStrictEqual(changesToFetch(mirror), []);
    assert.deepStrictEqual(
      updates(diff(mirror, view, at)).map(
        (request) => request._tag === "approval" && request.detail?.text,
      ),
      ["- Keep this list item\n- And this one"],
    );
  });

  it("never changes once the approval has closed, and lets go of what was fetched for it", () => {
    const { mirror, view, asks, whole } = setUp();
    assert.isTrue(keepFetched(mirror, whole));
    assert.strictEqual(updates(diff(mirror, view, at)).length, 1);
    const closed = { ...asks, status: "resolved" as const, resolvedAt: at };
    applyEvent(
      mirror,
      Schema.decodeSync(OrchestrationV2DomainEvent)({
        id: "event-1",
        threadId: "thread-1",
        occurredAt: at,
        type: "runtime-request.updated",
        payload: closed,
      }),
    );
    assert.strictEqual(mirror.fetched.size, 0);
    assert.deepStrictEqual(
      diff(mirror, view, at).map((event) => event._tag),
      ["request-closed"],
    );
    assert.deepStrictEqual(changesToFetch(mirror), []);
    // A fetch that lands after the approval closed is not kept.
    assert.isFalse(keepFetched(mirror, whole));
    assert.deepStrictEqual(diff(mirror, view, at), []);
  });
});
