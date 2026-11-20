// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { approvalOf } from "./approvalDetail.ts";

// Items shaped as the engine records them at the pin: the approval carries the
// provider's prompt and reason under the native id of the command or file
// change it holds back, which the provider records as an item of its own. Its
// runtime request names what it asks about: the whole item, or, for one of
// several approvals under one item, a native id of its own.

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest);
const at = DateTime.makeUnsafe("2026-11-20T12:00:00Z");

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
    assert.deepStrictEqual(approvalOf(asked, asks, [asked, held]), {
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
    const shown = approvalOf(asked, asks, [held, asked]);
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
    const shown = approvalOf(asked, asks, [asked]);
    assert.strictEqual(shown.kind, "file-change");
    assert.strictEqual(shown.action, "update src/a.ts\nadd src/b.ts");
    assert.strictEqual(shown.detail, null);
    assert.strictEqual(shown.exact, false);

    const held = item("patch-1", {
      type: "file_change",
      fileName: "src/a.ts",
      changes: [{ operation: "update", path: "src/a.ts" }],
    });
    assert.strictEqual(approvalOf(asked, asks, [asked, held]).exact, false);
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
    const shown = approvalOf(asked, asks, [held, asked]);
    assert.strictEqual(shown.action, "../shared/config.json");
    assert.strictEqual(shown.detail, "@@ -1,2 +1,2 @@\n context\n-old line\n+    new line");
    assert.strictEqual(shown.reason, "Writes outside the workspace");
    assert.strictEqual(shown.exact, true);
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
    const shown = approvalOf(asked, request("approval-uuid-1"), [asked, held]);
    assert.strictEqual(shown.action, "git push origin main");
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(approvalOf(asked, undefined, [asked, held]).exact, false);
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
    const shown = approvalOf(asked, asks, [asked, elsewhere, otherRun]);
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
    const shown = approvalOf(asked, asks, [asked, held]);
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
    const shown = approvalOf(asked, asks, [asked, held]);
    assert.strictEqual(shown.action, "echo a\\ ");
    assert.strictEqual(shown.exact, true);
    assert.strictEqual(shown.reason, null);

    const explained = approval(
      "toolu-3",
      { requestKind: "command", prompt, reason: "Writes outside the project" },
      "claudeAgent",
    );
    assert.strictEqual(
      approvalOf(explained, asks, [explained, held]).reason,
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
    const shown = approvalOf(asked, asks, [asked, held]);
    assert.strictEqual(shown.action, "Run the migration");
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(shown.sessionGrant, null);
  });

  it("calls a command a summary when its last line break continues the line", () => {
    const asks = request("cmd-5");
    const asked = approval("cmd-5", { requestKind: "command", prompt: "Print a" });
    const held = item("cmd-5", { type: "command_execution", input: "echo a\\\n" });
    assert.strictEqual(approvalOf(asked, asks, [asked, held]).exact, false);
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
      const shown = approvalOf(asked, request(nativeId, driver), [asked, held]);
      assert.strictEqual(shown.exact, true);
      return shown.sessionGrant;
    };
    // Codex grants every later request of the kind.
    assert.deepStrictEqual(grantOf("codex", "command"), { covers: "every-command" });
    assert.deepStrictEqual(grantOf("codex", "file-change"), { covers: "every-file-change" });
    // Claude Code applies its own rule, which can be as wide as the whole tool.
    assert.deepStrictEqual(grantOf("claudeAgent", "command"), { covers: "similar-commands" });
    assert.deepStrictEqual(grantOf("claudeAgent", "file-change"), {
      covers: "similar-file-changes",
    });
    // A provider whose grant is not established is offered none.
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
    const shown = approvalOf(asked, request("cmd-7"), [asked]);
    assert.strictEqual(shown.exact, false);
    assert.strictEqual(shown.sessionGrant, null);
  });
});
