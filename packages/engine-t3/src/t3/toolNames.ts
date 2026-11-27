// SPDX-License-Identifier: AGPL-3.0-or-later
import { Label, SkillName, type StepSkill, type WorkStep, type WorkTool } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TOOL_SERVER } from "./Provision.ts";

/**
 * The tools a step names now. `background-task` and `plan` name only steps
 * recorded before the turn's work told them (decision 0070).
 */
type NamedTool = Exclude<WorkTool, "background-task" | "plan">;

/**
 * The engine's own tool server, as the harnesses name its tools:
 * `mcp__t3-code__delegate_task` on Claude Code, `t3-code.delegate_task` on
 * Codex and on ACP agents. **Verified** on `0.1.11`: a step of the scripted
 * agent's `delegate_task` call carried `t3-code.delegate_task`; the code it
 * rests on is unchanged at `bc0f04d`.
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
 * Whether a bare `j3` tool name is a connector's. The bridge lists a
 * connector's tool as `<connector>__<tool>`, and none of J3 Bots' own tool
 * names holds `__`, so a call to one is a step of the bot's work, shown as
 * the connector's, as well as a call the server matches to its turn.
 */
const isConnectorTool = (tool: string): boolean => tool.indexOf("__") > 0;

/**
 * J3 Bots' own tools that are steps of a bot's work, unlike the rest of them,
 * which are events of their own: those that change or read its MCP servers
 * and skills (decision 0049), by their bare names in the `j3` namespace.
 */
const OWN_STEP_TOOLS: ReadonlyMap<string, NamedTool> = new Map([
  ["add_mcp_server", "mcp-server-added"],
  ["update_mcp_server", "mcp-server-changed"],
  ["set_mcp_server_bots", "mcp-server-changed"],
  ["remove_mcp_server", "mcp-server-removed"],
  ["search_mcp_servers", "mcp-servers-read"],
  ["list_mcp_servers", "mcp-servers-read"],
  ["save_skill", "skill-saved"],
  ["install_skill", "skill-saved"],
  ["remove_skill", "skill-removed"],
  ["list_skills", "skills-read"],
  ["use_connector_skill", "connector-skill"],
]);

/**
 * Whether a bare `j3` tool name is a step of the bot's work: a connector's
 * tool, or one of J3 Bots' own that manages its MCP servers and skills.
 */
export const isStepTool = (tool: string): boolean =>
  isConnectorTool(tool) || OWN_STEP_TOOLS.has(tool);

/**
 * What an approval card names a held `j3` call by: a connector's tool as its
 * step is labelled, or one of J3 Bots' own that is a step by its bare name,
 * as the bot called it; undefined for any other tool.
 */
export const heldCallLabel = (name: string): string | undefined => {
  const { server, tool } = split(name);
  if (server !== TOOL_SERVER) return undefined;
  if (isConnectorTool(tool)) return connectorLabel(tool);
  return OWN_STEP_TOOLS.has(tool) ? tool : undefined;
};

/** A connector tool's step label: the connector, then its tool, from the names the bridge gave them. */
const connectorLabel = (tool: string): string => {
  const at = tool.indexOf("__");
  return `${readable(tool.slice(0, at))}: ${readable(tool.slice(at + 2)).toLowerCase()}`;
};

/** A bare name compared as the engine compares Claude's: case, spaces, `_` and `-` aside. */
const normalized = (tool: string) => tool.toLowerCase().replaceAll(/[\s_-]/g, "");

/**
 * The engine's own tools, by their bare names as the engine offers them to
 * an agent (**Verified** on a running engine, 2026-11: its tool list).
 * `delegate_task` is not among them: the task it starts is a little one of
 * the turn (`TOLD_BY_TURN_WORK`).
 */
const engineTool = (tool: string): NamedTool => {
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

type Kind = Extract<WorkStep["kind"], "read" | "search" | "tool">;

/**
 * A harness's own tool: the kind of step it is, the tool when J3 Bots names
 * it, and the input fields that say what it worked on.
 */
interface Native {
  readonly kind: Kind;
  readonly tool: NamedTool | null;
  readonly about: ReadonlyArray<keyof typeof Inputs.Type>;
}

/**
 * The harnesses' own tools that reach the engine as plain tool calls, by
 * their bare names. Claude Code's are **Read** in T3 Code at `bc0f04d`
 * (`ClaudeAdapterV2.ts`, `CLAUDE_KNOWN_TOOL_CLASSIFICATIONS`): `Read`, `Grep`,
 * `Glob`, `LS` and `TaskStop` arrive as dynamic tools, with the call's input.
 * Codex's `view_image`, and `WebFetch` from an agent that reports it as a
 * tool, are **Assumed**.
 */
const nativeTools: ReadonlyMap<string, Native> = new Map([
  ["read", { kind: "read", tool: null, about: ["file_path", "path"] }],
  ["grep", { kind: "search", tool: null, about: ["pattern", "path"] }],
  ["glob", { kind: "search", tool: null, about: ["pattern", "path"] }],
  ["ls", { kind: "search", tool: null, about: ["path"] }],
  ["taskstop", { kind: "tool", tool: "task-stop", about: [] }],
  ["webfetch", { kind: "tool", tool: "web-page", about: [] }],
  ["viewimage", { kind: "tool", tool: "image", about: [] }],
]);

/**
 * The calls a turn's work tells rather than its steps: a harness's list of
 * what is left to do, which is the turn's plan, and the launch of a subagent
 * or of a task the engine delegates, each a little one of the turn (decision
 * 0070). The engine records the plan as a `todo_list` item and each subagent
 * and delegated task as a `subagent` item of the same run, which the adapter
 * reads instead (**Read** at `bc0f04d`: `ClaudeAdapterV2.ts`, a `TodoWrite`
 * call L12595 and `task_started` L12337-12382; `CodexAdapterV2.ts`,
 * `turn/plan/updated` L5317; `Orchestrator.ts`, a delegated task's item
 * L10210-10233). Claude Code's `Agent` call reaches the engine as no item of
 * its own, and `Task` is its older name; Codex's `update_plan` is
 * **Assumed** to reach it as a tool call, if at all.
 */
const TOLD_BY_TURN_WORK: ReadonlySet<string> = new Set([
  "todowrite",
  "updateplan",
  "task",
  "agent",
]);

/** English for a client that predates `tool`. */
const englishLabel: Record<NamedTool, string> = {
  "task-status": "Checked on a background task",
  "task-stop": "Stopped a background task",
  secret: "Asked for a credential",
  login: "Filled a saved login",
  connector: "Used a connector",
  "connector-skill": "Used a connector's skill",
  browser: "Used the browser",
  "pull-request": "Worked on a pull request",
  issue: "Worked on an issue",
  schedule: "Managed a scheduled task",
  device: "Used a phone simulator",
  "web-page": "Read a web page",
  image: "Looked at an image",
  "built-in": "Used one of its tools",
  "mcp-server-added": "Added an MCP server",
  "mcp-server-changed": "Changed an MCP server",
  "mcp-server-removed": "Removed an MCP server",
  "mcp-servers-read": "Looked up MCP servers",
  "skill-saved": "Saved a skill",
  "skill-removed": "Removed a skill",
  "skills-read": "Looked up skills",
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

const SkillCall = Schema.Struct({ connector: Schema.String, skill: Schema.String });
const decodeSkillCall = Schema.decodeUnknownOption(SkillCall);
const isSkillName = Schema.is(SkillName);
const isLabel = Schema.is(Label);

/**
 * The skill a `use_connector_skill` call loads, as its step names it: by the
 * name the bot gave, or the folder its address ends in, and the connector by
 * its name in the bridge, made readable; none when the call names neither so.
 * The server names the connector as the operator knows it once it claims the
 * call.
 */
const skillOf = (input: unknown): StepSkill | undefined => {
  const call = decodeSkillCall(input);
  if (Option.isNone(call)) return undefined;
  const given = call.value.skill.trim();
  const name = given.includes("/") ? given.split("/").at(-2) : given;
  const connector = readable(call.value.connector);
  return name !== undefined && isSkillName(name) && isLabel(connector)
    ? { name, connector }
    : undefined;
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
 * reaches a label. A call the turn's plan or a little one tells is no step
 * (`undefined`).
 */
export const toolStep = (
  call: ToolCall,
):
  | {
      readonly kind: Kind;
      readonly tool: NamedTool | null;
      readonly label: string | null;
      readonly skill?: StepSkill;
    }
  | undefined => {
  if (call.viewsImage) return { kind: "tool", tool: "image", label: englishLabel.image };
  if (call.name === null) return { kind: "tool", tool: null, label: call.title };
  const { server, tool } = split(call.name.trim());
  if (server === ENGINE_TOOL_SERVER && tool === "delegate_task") return undefined;
  if (server === null && TOLD_BY_TURN_WORK.has(normalized(tool))) return undefined;
  if (server === TOOL_SERVER && isConnectorTool(tool)) {
    // From its name only: a connector call's input is the operator's data.
    return { kind: "tool", tool: "connector", label: connectorLabel(tool) };
  }
  const own = server === TOOL_SERVER ? OWN_STEP_TOOLS.get(tool) : undefined;
  if (own === "connector-skill") {
    const skill = skillOf(call.input);
    return {
      kind: "tool",
      tool: own,
      label: englishLabel[own],
      ...(skill === undefined ? {} : { skill }),
    };
  }
  if (own !== undefined) return { kind: "tool", tool: own, label: englishLabel[own] };
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
