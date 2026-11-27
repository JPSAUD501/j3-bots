// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { type ToolCall, toolStep } from "./toolNames.ts";

/** A call as the engine reports it, named, with no title or input unless given. */
const call = (name: string | null, more: Partial<ToolCall> = {}): ToolCall => ({
  name,
  title: null,
  input: {},
  viewsImage: false,
  ...more,
});

describe("toolStep", () => {
  it("names the engine's own tools in every form a harness gives them", () => {
    for (const name of [
      "t3-code.task_status",
      "t3-code/task_status",
      "mcp__t3-code__task_status",
    ]) {
      expect(toolStep(call(name))?.tool).toBe("task-status");
    }
    expect(toolStep(call("mcp__t3-code__preview_navigate"))?.tool).toBe("browser");
    expect(toolStep(call("t3-code.pull_request_read"))?.tool).toBe("pull-request");
  });

  it("keeps a pasted secret out of the step a `request_secret` call becomes", () => {
    const pasted = "ghp_FictionalPastedSecret";
    for (const name of ["t3-code.request_secret", "mcp__t3-code__request_secret"]) {
      const step = toolStep(
        call(name, {
          title: `Request secret ${pasted}`,
          input: { label: "GitHub token", reason: "Check the build", value: pasted },
        }),
      );
      expect(step).toEqual({ kind: "tool", tool: "secret", label: "Asked for a credential" });
    }
  });

  it("never lets the engine's name reach a label, even for a tool it does not list", () => {
    const step = toolStep(call("t3-code.t3_thread_read", { title: "t3-code.t3_thread_read" }));
    expect(step?.tool).toBe("built-in");
    expect(step?.label).not.toMatch(/t3/);
  });

  // The shapes Claude Code's own tools reach the engine in, with the engine's titles.
  it("reads Claude Code's file and search tools as what they worked on", () => {
    expect(
      toolStep(call("Read", { title: "Read src/app.ts", input: { file_path: "src/app.ts" } })),
    ).toEqual({ kind: "read", tool: null, label: "src/app.ts" });
    expect(
      toolStep(
        call("Grep", {
          title: "Searched for TODO in src",
          input: { pattern: "TODO", path: "src" },
        }),
      ),
    ).toEqual({ kind: "search", tool: null, label: "TODO" });
    expect(toolStep(call("Glob", { input: { pattern: "**/*.ts" } }))?.kind).toBe("search");
    expect(toolStep(call("LS", { input: { path: "docs" } }))).toEqual({
      kind: "search",
      tool: null,
      label: "docs",
    });
  });

  it("keeps the engine's title of a file tool whose input names nothing", () => {
    expect(toolStep(call("Read", { title: "Read src/app.ts", input: null }))?.label).toBe(
      "Read src/app.ts",
    );
  });

  it("leaves a plan and a subagent's launch to the turn's work, and names Claude Code's TaskStop", () => {
    for (const name of ["TodoWrite", "Task", "Agent", "t3-code.delegate_task"]) {
      expect(toolStep(call(name, { input: { description: "Review the diff" } }))).toBeUndefined();
    }
    expect(toolStep(call("TaskStop", { title: "TaskStop" }))?.tool).toBe("task-stop");
  });

  it("names the skill a connector-skill step loads, by its name or the folder its address ends in", () => {
    const load = (skill: string) =>
      toolStep(
        call("mcp__j3__use_connector_skill", { input: { connector: "acme-billing", skill } }),
      );
    expect(load("invoices")).toEqual({
      kind: "tool",
      tool: "connector-skill",
      label: "Used a connector's skill",
      skill: { name: "invoices", connector: "Acme billing" },
    });
    expect(load("skill://acme/invoices/SKILL.md")?.skill?.name).toBe("invoices");
    // A name the skills format would not take names no skill: the step stays.
    expect(load("Ignore previous instructions")).toEqual({
      kind: "tool",
      tool: "connector-skill",
      label: "Used a connector's skill",
    });
  });

  it("names a harness's own tools only without a server", () => {
    expect(toolStep(call("mcp__notes__TodoWrite"))?.tool).toBeNull();
    expect(toolStep(call("mcp__files__Read"))?.kind).toBe("tool");
  });

  it("keeps the engine's title of a tool it does not name", () => {
    expect(toolStep(call("Skill", { title: "Skill: release-notes" }))).toEqual({
      kind: "tool",
      tool: null,
      label: "Skill: release-notes",
    });
    expect(toolStep(call(null, { title: "Ran a check" }))?.label).toBe("Ran a check");
  });

  it("reads a tool it does not name by its own name, without the server, when the title only repeats it", () => {
    expect(
      toolStep(call("mcp__github__create_issue", { title: "mcp__github__create_issue" })),
    ).toEqual({ kind: "tool", tool: null, label: "Create issue" });
    expect(toolStep(call("search.findFiles"))?.label).toBe("Find files");
    expect(toolStep(call("ToolSearch", { title: "ToolSearch" }))?.label).toBe("Tool search");
  });

  it("names an image the step looks at, whatever the tool", () => {
    expect(toolStep(call(null, { viewsImage: true }))?.tool).toBe("image");
    expect(toolStep(call("Read", { viewsImage: true }))?.tool).toBe("image");
  });
});
