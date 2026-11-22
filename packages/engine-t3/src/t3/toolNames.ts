// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkStep, WorkTool } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** A bare name compared as the engine compares Claude's: case, spaces, `_` and `-` aside. */
const normalized = (tool: string) => tool.toLowerCase().replaceAll(/[\s_-]/g, "");

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
  if (/pull_request|^ci_/.test(tool)) return "pull-request";
  if (/issue/.test(tool)) return "issue";
  if (/schedul/.test(tool)) return "schedule";
  if (/^device_/.test(tool)) return "device";
  return "built-in";
};

const Inputs = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
const decodeInputs = Schema.decodeUnknownOption(Inputs);

/** The first of `keys` the call's input gives as a non-empty string. */
const inputText = (
  input: unknown,
  keys: ReadonlyArray<keyof typeof Inputs.Type>,
): string | null => {
  const fields = decodeInputs(input);
  if (Option.isNone(fields)) return null;
  for (const key of keys) {
    const value = fields.value[key]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return null;
};

type Kind = Extract<WorkStep["kind"], "read" | "search" | "delegation" | "tool">;

/**
 * A harness's own tool: the kind of step it is, the tool when J3 Bots names
 * it, and the input fields that say what it worked on.
 */
interface Native {
  readonly kind: Kind;
  readonly tool: WorkTool | null;
  readonly about: ReadonlyArray<keyof typeof Inputs.Type>;
}

/**
 * The harnesses' own tools that reach the engine as plain tool calls, by
 * their bare names. Claude Code's are **Read** in T3 Code at `59651c17`
 * (`ClaudeAdapterV2.ts`, `CLAUDE_KNOWN_TOOL_CLASSIFICATIONS`): `Read`, `Grep`,
 * `Glob`, `LS`, `Task`, `Agent`, `TaskStop` and `TodoWrite` arrive as dynamic
 * tools, with the call's input. Codex's `update_plan` and `view_image`, and
 * `WebFetch` from an agent that reports it as a tool, are **Assumed**.
 */
const nativeTools: ReadonlyMap<string, Native> = new Map([
  ["read", { kind: "read", tool: null, about: ["file_path", "path"] }],
  ["grep", { kind: "search", tool: null, about: ["pattern", "path"] }],
  ["glob", { kind: "search", tool: null, about: ["pattern", "path"] }],
  ["ls", { kind: "search", tool: null, about: ["path"] }],
  ["task", { kind: "delegation", tool: null, about: ["description"] }],
  ["agent", { kind: "delegation", tool: null, about: ["description"] }],
  ["taskstop", { kind: "tool", tool: "task-stop", about: [] }],
  ["todowrite", { kind: "tool", tool: "plan", about: [] }],
  ["updateplan", { kind: "tool", tool: "plan", about: [] }],
  ["webfetch", { kind: "tool", tool: "web-page", about: [] }],
  ["viewimage", { kind: "tool", tool: "image", about: [] }],
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
  "web-page": "Read a web page",
  plan: "Updated its plan",
  image: "Looked at an image",
  "built-in": "Used one of its tools",
};

/** A tool's own name made readable: no server, words apart, the first one capitalised. */
const readable = (tool: string): string => {
  const words = tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What the engine titled a call, unless the title only repeats the tool's name. */
const meaningfulTitle = (title: string | null, tool: string | null): string | null => {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") return null;
  return tool !== null && normalized(split(trimmed).tool) === normalized(tool) ? null : trimmed;
};

/** A tool call as the engine reports it. */
export interface ToolCall {
  /** The tool's name; a harness may give only a title, which then carries it. */
  readonly name: string | null;
  /** What the engine made of the call, such as "Read src/app.ts". */
  readonly title: string | null;
  readonly input: unknown;
  /** The call showed the agent an image. */
  readonly viewsImage: boolean;
}

/**
 * How a tool call reads as a work step: its kind, the tool in J3 Bots' words
 * when J3 Bots names it, and a label. A harness's file and search tools read
 * as what they worked on; a tool J3 Bots does not name keeps the engine's
 * title, else its own name made readable. The engine's name for itself never
 * reaches a label.
 */
export const toolStep = (
  call: ToolCall,
): { readonly kind: Kind; readonly tool: WorkTool | null; readonly label: string | null } => {
  if (call.viewsImage) return { kind: "tool", tool: "image", label: englishLabel.image };
  if (call.name === null) return { kind: "tool", tool: null, label: call.title };
  const { server, tool } = split(call.name.trim());
  if (server === ENGINE_TOOL_SERVER) {
    const named = engineTool(tool);
    return { kind: "tool", tool: named, label: englishLabel[named] };
  }
  const native = server === null ? nativeTools.get(normalized(tool)) : undefined;
  if (native !== undefined) {
    return {
      kind: native.kind,
      tool: native.tool,
      label:
        native.tool !== null
          ? englishLabel[native.tool]
          : (inputText(call.input, native.about) ?? meaningfulTitle(call.title, tool)),
    };
  }
  const words = readable(tool);
  return {
    kind: "tool",
    tool: null,
    label: meaningfulTitle(call.title, tool) ?? (words === "" ? null : words),
  };
};
