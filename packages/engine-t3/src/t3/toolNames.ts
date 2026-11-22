// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkTool } from "@j3-bots/contracts";

/**
 * The engine's own tool server, as the harnesses name its tools:
 * `mcp__t3-code__delegate_task` on Claude Code, `t3-code.delegate_task` on
 * Codex and on ACP agents. **Verified** on `0.1.11`: a step of the scripted
 * agent's `delegate_task` call carried `t3-code.delegate_task`.
 */
const ENGINE_TOOL_SERVER = "t3-code";

/** A tool's server and bare name, from the forms the harnesses give it. */
const split = (name: string): { readonly server: string | null; readonly tool: string } => {
  const mcp = /^mcp__(.+?)__(.+)$/s.exec(name);
  if (mcp?.[1] !== undefined && mcp[2] !== undefined) return { server: mcp[1], tool: mcp[2] };
  const dotted = /^([^./\s]+)[./](.+)$/s.exec(name);
  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    return { server: dotted[1], tool: dotted[2] };
  }
  return { server: null, tool: name };
};

/**
 * The engine's own tools, by their bare names as the engine offers them to
 * an agent (**Verified** on a running engine, 2026-11: its tool list).
 */
const engineTool = (tool: string): WorkTool => {
  if (tool === "delegate_task") return "background-task";
  if (tool === "task_status") return "task-status";
  if (tool === "task_cancel") return "task-stop";
  if (tool === "request_secret") return "secret";
  if (/^(?:t3_)?preview_/.test(tool)) return "browser";
  if (/^html_(?:render|preview)$/.test(tool)) return "page";
  if (/pull_request|^ci_/.test(tool)) return "pull-request";
  if (/issue/.test(tool)) return "issue";
  if (/schedul/.test(tool)) return "schedule";
  if (/^device_/.test(tool)) return "device";
  return "built-in";
};

/**
 * The harnesses' own tools that reach the engine as plain tool calls, by
 * their names in Claude Code and Codex (**Assumed**: which of a harness's
 * tools the engine passes on this way).
 */
const harnessTools: ReadonlyMap<string, WorkTool> = new Map([
  ["TodoWrite", "plan"],
  ["update_plan", "plan"],
  ["WebFetch", "web-page"],
  ["web_fetch", "web-page"],
  ["view_image", "image"],
]);

/** English for a client that predates `tool`. */
const englishLabel: Record<WorkTool, string> = {
  "background-task": "Started a background task",
  "task-status": "Checked on a background task",
  "task-stop": "Stopped a background task",
  secret: "Asked for a credential",
  browser: "Used the browser",
  "pull-request": "Worked on a pull request",
  issue: "Worked on an issue",
  schedule: "Managed a scheduled task",
  device: "Used a phone simulator",
  page: "Drew a page",
  "web-page": "Read a web page",
  plan: "Updated its plan",
  image: "Looked at an image",
  "built-in": "Used a built-in tool",
};

/** A tool's own name made readable: no server, words apart. */
const readable = (tool: string): string =>
  tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();

/**
 * How a tool call reads in a work step: the tool in J3 Bots' words when it is
 * one J3 Bots names, else none, with the tool's own name made readable. The
 * engine's name for itself never reaches a label.
 */
export const toolStep = (
  name: string | null,
  viewsImage: boolean,
): { readonly tool: WorkTool | null; readonly label: string | null } => {
  if (viewsImage) return { tool: "image", label: englishLabel.image };
  if (name === null) return { tool: null, label: null };
  const { server, tool } = split(name.trim());
  const named =
    server === ENGINE_TOOL_SERVER
      ? engineTool(tool)
      : server === null
        ? harnessTools.get(tool)
        : undefined;
  if (named !== undefined) return { tool: named, label: englishLabel[named] };
  const words = readable(tool);
  return { tool: null, label: words === "" ? null : words };
};
