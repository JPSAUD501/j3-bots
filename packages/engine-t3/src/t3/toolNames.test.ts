// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { toolStep } from "./toolNames.ts";

describe("toolStep", () => {
  it("names the engine's own tools in every form a harness gives them", () => {
    for (const name of [
      "t3-code.delegate_task",
      "t3-code/delegate_task",
      "mcp__t3-code__delegate_task",
    ]) {
      expect(toolStep(name, false).tool).toBe("background-task");
    }
    expect(toolStep("mcp__t3-code__preview_navigate", false).tool).toBe("browser");
    expect(toolStep("t3-code.pull_request_read", false).tool).toBe("pull-request");
  });

  it("never lets the engine's name reach a label, even for a tool it does not list", () => {
    const step = toolStep("t3-code.t3_thread_read", false);
    expect(step.tool).toBe("built-in");
    expect(step.label).not.toMatch(/t3/);
  });

  it("names a harness's own tools only without a server", () => {
    expect(toolStep("TodoWrite", false).tool).toBe("plan");
    expect(toolStep("mcp__notes__TodoWrite", false).tool).toBeNull();
  });

  it("reads another server's tool by its own name, without the server", () => {
    expect(toolStep("mcp__github__create_issue", false)).toEqual({
      tool: null,
      label: "create issue",
    });
    expect(toolStep("search.findFiles", false)).toEqual({ tool: null, label: "find files" });
  });

  it("names an image the step looks at, whatever the tool", () => {
    expect(toolStep(null, true).tool).toBe("image");
  });
});
