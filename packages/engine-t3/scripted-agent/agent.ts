#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off -- a standalone agent process, run by the engine with plain Node.
//
// A scripted Agent Client Protocol agent for the conformance suite. The engine
// runs it as a local-command provider, so the real engine, its orchestration
// and the adapter all run without a paid model and with exact, repeatable
// behaviour.
//
// The prompt chooses the script: `[[script:<name>]]` anywhere in the text, with
// optional `key=value` arguments, as in `[[script:speak text=Hello]]`. Without
// a directive the turn is `plain`. See `SCRIPTS` for what each one does.
//
// The structure follows T3 Code's own development replay agent
// (apps/server/scripts/dev-replay-agent.ts, MIT); the scripts are J3 Bots'.
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

const Message = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  method: Schema.optional(Schema.String),
  params: Schema.optional(JsonRecord),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
type Message = typeof Message.Type;
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

const McpHeader = Schema.Struct({ name: Schema.String, value: Schema.String });
const HttpMcpServer = Schema.Struct({
  type: Schema.Literal("http"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.Array(McpHeader),
});
type HttpMcpServer = typeof HttpMcpServer.Type;
const StdioMcpServer = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Array(McpHeader),
});
const decodeServers = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeHttpServer = Schema.decodeUnknownOption(HttpMcpServer);
const decodeStdioServer = Schema.decodeUnknownOption(StdioMcpServer);

const SessionParams = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  mcpServers: Schema.optional(Schema.Unknown),
});
const PromptParams = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.Array(Schema.Unknown),
});
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decodeSessionParams = Schema.decodeUnknownOption(SessionParams);
const decodePromptParams = Schema.decodeUnknownOption(PromptParams);
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock);

const PermissionAnswer = Schema.Struct({
  outcome: Schema.Struct({ outcome: Schema.String, optionId: Schema.optional(Schema.String) }),
});
const ElicitationAnswer = Schema.Struct({
  action: Schema.String,
  content: Schema.optional(JsonRecord),
});
const decodePermissionAnswer = Schema.decodeUnknownOption(PermissionAnswer);
const decodeElicitationAnswer = Schema.decodeUnknownOption(ElicitationAnswer);

const McpToolResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    isError: Schema.optional(Schema.Boolean),
  }),
});
const decodeMcpToolResult = Schema.decodeUnknownOption(Schema.fromJsonString(McpToolResult));

interface Session {
  readonly cwd: string;
  readonly hostTools: Option.Option<HttpMcpServer>;
  cancel: (() => void) | undefined;
  /** Tokens reported so far, so each turn's usage is distinct and countable. */
  turns: number;
}

type StopReason = "end_turn" | "cancelled";

interface Turn {
  readonly sessionId: string;
  readonly session: Session;
  readonly args: ReadonlyMap<string, string>;
  readonly signal: AbortSignal;
}

const sessions = new Map<string, Session>();
const pending = new Map<string, (result: unknown) => void>();
let nextRequestId = 1;

const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const update = (sessionId: string, value: Record<string, unknown>) =>
  send({ method: "session/update", params: { sessionId, update: value } });

/** Resolves after `ms`, or as soon as the turn is cancelled. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

/** Sends a request to the client and waits for its answer, or for the turn to be cancelled. */
const ask = (method: string, params: Record<string, unknown>, signal: AbortSignal) =>
  new Promise<Option.Option<unknown>>((resolve) => {
    const id = String(nextRequestId++);
    const onAbort = () => {
      pending.delete(id);
      resolve(Option.none());
    };
    pending.set(id, (result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(Option.some(result));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    send({ id, method, params });
  });

const say = async (turn: Turn, text: string) => {
  for (const word of text.split(/(?<=\s)/)) {
    if (turn.signal.aborted) return;
    update(turn.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: word },
    });
    await sleep(20, turn.signal);
  }
};

/** Usage the engine reads from the agent; distinct per turn so double counting shows. */
const reportUsage = (turn: Turn) => {
  turn.session.turns += 1;
  update(turn.sessionId, {
    sessionUpdate: "usage_update",
    used: 1000 * turn.session.turns,
    size: 200_000,
  });
};

/** What a host tool answered: its text, and whether the call failed. */
interface HostToolResult {
  readonly failed: boolean;
  readonly text: string;
}

/**
 * Calls one of the engine's own MCP tools over the HTTP server the engine gave
 * the session, and reports the call the way an agent reports an MCP tool call.
 */
const callHostTool = async (
  turn: Turn,
  tool: string,
  input: Record<string, unknown>,
): Promise<HostToolResult> => {
  const server = turn.session.hostTools;
  if (Option.isNone(server)) {
    await say(turn, `No host tools: cannot call ${tool}.`);
    return { failed: true, text: "" };
  }
  const toolCallId = `${tool}-${NodeCrypto.randomUUID()}`;
  const rawInput = { server: server.value.name, tool, arguments: input };
  update(turn.sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: `${server.value.name}/${tool}`,
    kind: "other",
    status: "in_progress",
    rawInput,
    _meta: { is_mcp_tool_call: true },
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const header of server.value.headers) headers[header.name] = header.value;
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(server.value.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader !== null) headers["mcp-session-id"] = sessionHeader;
    const text = await response.text();
    // A streamable HTTP server may answer with one server-sent event.
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return data.length > 0 ? data : text;
  };
  await post({
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "j3-scripted-agent", version: "1" },
    },
  });
  await post({ method: "notifications/initialized" });
  const answer = decodeMcpToolResult(
    await post({ id: "call", method: "tools/call", params: { name: tool, arguments: input } }),
  );
  const text = Option.match(answer, {
    onNone: () => "",
    onSome: (value) =>
      (value.result.content ?? [])
        .map((block) =>
          Option.match(decodeTextBlock(block), { onNone: () => "", onSome: (b) => b.text }),
        )
        .join(""),
  });
  const failed = Option.isNone(answer) || answer.value.result.isError === true;
  update(turn.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: failed ? "failed" : "completed",
    rawInput,
    rawOutput: { text },
    _meta: { is_mcp_tool_call: true },
    content: [{ type: "content", content: { type: "text", text } }],
  });
  return { failed, text };
};

/** The commands the `steps` script runs, in turn. */
const STEP_COMMANDS = ["git status", "pnpm test", "pnpm lint", "git diff --stat"];

/**
 * Every script the conformance suite uses.
 *
 * - `plain`: a short reply, and usage.
 * - `slow`: streams a word every `every` ms (default 200) until cancelled or
 *   `for` ms pass (default 60000). For stops and steers.
 * - `approval`: asks permission for a write, then says whether it was granted.
 * - `question`: asks one multiple-choice question and repeats the answer.
 * - `speak`: sends `text` to the user through the engine's `send_to_user` tool.
 * - `steps`: thinks for `think` ms (default 2000), runs `count` commands
 *   (default 3) of `each` ms (default 4000), then speaks `text` as `speak`
 *   does. For a turn's work as a client shows it while it runs.
 * - `secret`: asks for a secret through the engine's `request_secret` tool.
 * - `browse`: opens `url` in the engine's browser (`preview_open`), then acts
 *   on the tab every `every` ms (default 1000) for up to `for` ms (default
 *   60000). It speaks, as `speak` does, the first time an action is refused,
 *   with the engine's reason, and the first time one works again after, and
 *   ends then.
 * - `delegate`: hands a task to a child agent through the engine's
 *   `delegate_task` tool, then ends; the engine wakes the session when the
 *   child's task ends. The child runs `plain`, or with `child=slow`, `slow`
 *   for two minutes.
 *
 * No script starts work on its own after its turn: the engine offers a
 * continuation only to agents it recognizes by name (**Read**, `db51b67`,
 * `provider-acp-registry/src/server/adapter.ts`), and this agent claims no
 * other agent's name. Only the engine's own delegated task outlives a turn.
 */
const SCRIPTS: Record<string, (turn: Turn) => Promise<StopReason>> = {
  plain: async (turn) => {
    await say(turn, "Scripted reply.");
    reportUsage(turn);
    return "end_turn";
  },
  slow: async (turn) => {
    const every = Number(turn.args.get("every") ?? "200");
    const until = Date.now() + Number(turn.args.get("for") ?? "60000");
    let index = 0;
    while (!turn.signal.aborted && Date.now() < until) {
      update(turn.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `word${index++} ` },
      });
      await sleep(every, turn.signal);
    }
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  approval: async (turn) => {
    const toolCallId = `write-${NodeCrypto.randomUUID()}`;
    const toolCall = {
      toolCallId,
      title: "Write notes.txt",
      kind: "edit",
      status: "pending",
      content: [{ type: "content", content: { type: "text", text: "Write notes.txt" } }],
    };
    update(turn.sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const answer = await ask(
      "session/request_permission",
      {
        sessionId: turn.sessionId,
        toolCall,
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
      turn.signal,
    );
    if (turn.signal.aborted) return "cancelled";
    const decoded = Option.flatMap(answer, decodePermissionAnswer);
    const outcome = Option.map(decoded, (value) => value.outcome);
    if (Option.isSome(outcome) && outcome.value.outcome === "cancelled") return "cancelled";
    const granted = Option.isSome(outcome) && outcome.value.optionId === "allow-once";
    update(turn.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: granted ? "completed" : "failed",
    });
    await say(turn, granted ? "Permission granted." : "Permission refused.");
    reportUsage(turn);
    return "end_turn";
  },
  question: async (turn) => {
    const answer = await ask(
      "elicitation/create",
      {
        sessionId: turn.sessionId,
        mode: "form",
        message: "Pick a colour.",
        requestedSchema: {
          type: "object",
          title: "Colour",
          properties: {
            colour: {
              type: "string",
              title: "Colour",
              description: "Which colour?",
              enum: ["Red", "Blue"],
            },
          },
          required: ["colour"],
        },
      },
      turn.signal,
    );
    if (turn.signal.aborted) return "cancelled";
    const decoded = Option.flatMap(answer, decodeElicitationAnswer);
    const colour = Option.flatMap(decoded, (value) =>
      value.action === "accept" ? Option.fromNullishOr(value.content?.["colour"]) : Option.none(),
    );
    await say(turn, Option.isSome(colour) ? `You picked ${String(colour.value)}.` : "No answer.");
    reportUsage(turn);
    return "end_turn";
  },
  steps: async (turn) => {
    const count = Number(turn.args.get("count") ?? "3");
    const each = Number(turn.args.get("each") ?? "4000");
    await sleep(Number(turn.args.get("think") ?? "2000"), turn.signal);
    for (let index = 0; index < count && !turn.signal.aborted; index++) {
      const command = STEP_COMMANDS[index % STEP_COMMANDS.length] ?? "true";
      const toolCallId = `step-${NodeCrypto.randomUUID()}`;
      update(turn.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: command,
        kind: "execute",
        status: "in_progress",
        rawInput: { command },
      });
      await sleep(each, turn.signal);
      update(turn.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
      });
    }
    if (turn.signal.aborted) return "cancelled";
    await callHostTool(turn, "send_to_user", {
      message: turn.args.get("text") ?? "Done: every step passed.",
    });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  speak: async (turn) => {
    await callHostTool(turn, "send_to_user", {
      message: turn.args.get("text") ?? "A message from the scripted agent.",
    });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  delegate: async (turn) => {
    const child =
      turn.args.get("child") === "slow"
        ? "[[script:slow every=500 for=120000]]"
        : "[[script:plain]]";
    await callHostTool(turn, "delegate_task", {
      task: child,
      title: "Scripted delegate",
    });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  secret: async (turn) => {
    const result = await callHostTool(turn, "request_secret", {
      label: turn.args.get("label") ?? "Scripted token",
      reason: "The conformance suite asks for a secret.",
    });
    if (turn.signal.aborted) return "cancelled";
    await say(turn, result.failed ? "Secret request failed." : "Secret request finished.");
    reportUsage(turn);
    return "end_turn";
  },
  browse: async (turn) => {
    const every = Number(turn.args.get("every") ?? "1000");
    const until = Date.now() + Number(turn.args.get("for") ?? "60000");
    const speak = (message: string) => callHostTool(turn, "send_to_user", { message });
    const opened = await callHostTool(turn, "preview_open", {
      url: turn.args.get("url") ?? "about:blank",
    });
    if (opened.failed) {
      await speak(`Browser failed: ${opened.text}`);
      reportUsage(turn);
      return "end_turn";
    }
    let refused = false;
    while (!turn.signal.aborted && Date.now() < until) {
      await sleep(every, turn.signal);
      if (turn.signal.aborted) break;
      // A scroll the page does not notice: an action, which needs the tab.
      const acted = await callHostTool(turn, "preview_act", { action: "scroll", deltaY: 1 });
      if (acted.failed && !refused) {
        refused = true;
        await speak(`Browser refused: ${acted.text}`);
      } else if (!acted.failed && refused) {
        await speak("Browser acted again.");
        break;
      }
    }
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
};

const DIRECTIVE = /\[\[script:([a-z-]+)((?:\s+[a-z]+=[^\s\]]+)*)\s*\]\]/;

const parseDirective = (text: string) => {
  const match = DIRECTIVE.exec(text);
  const args = new Map<string, string>();
  for (const pair of (match?.[2] ?? "").trim().split(/\s+/)) {
    const [key, ...rest] = pair.split("=");
    if (key !== undefined && key.length > 0 && rest.length > 0) args.set(key, rest.join("="));
  }
  return { name: match?.[1] ?? "plain", args };
};

/**
 * The engine's own MCP server for this session. The engine offers it over HTTP
 * to agents that take HTTP servers it trusts, and to the rest as a stdio bridge
 * (its own binary) whose environment names the same HTTP endpoint. The bridge
 * only relays to that endpoint, so this agent calls the endpoint directly
 * instead of starting a second engine binary.
 */
const hostServerOf = (server: unknown): Option.Option<HttpMcpServer> =>
  Option.orElse(decodeHttpServer(server), () =>
    Option.flatMap(decodeStdioServer(server), (stdio) => {
      const env = new Map(stdio.env.map((entry) => [entry.name, entry.value]));
      const url = env.get("T3_ACP_MCP_ENDPOINT");
      const authorization = env.get("T3_ACP_MCP_AUTHORIZATION");
      return url === undefined || authorization === undefined
        ? Option.none()
        : Option.some({
            type: "http" as const,
            name: stdio.name,
            url,
            headers: [{ name: "Authorization", value: authorization }],
          });
    }),
  );

const hostToolsFrom = (servers: unknown) =>
  Option.flatMap(decodeServers(servers), (list) => Option.firstSomeOf(list.map(hostServerOf)));

const handleRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
        agentInfo: { name: "j3-scripted-agent", version: "1" },
      };
    case "session/new":
    case "session/load": {
      const decoded = Option.getOrUndefined(decodeSessionParams(params));
      // The engine runs one agent process per thread; ids must be unique across processes.
      const sessionId =
        method === "session/load" && decoded?.sessionId !== undefined
          ? decoded.sessionId
          : NodeCrypto.randomUUID();
      sessions.set(sessionId, {
        cwd: decoded?.cwd ?? process.cwd(),
        hostTools: hostToolsFrom(decoded?.mcpServers),
        cancel: undefined,
        turns: 0,
      });
      return {
        ...(method === "session/new" ? { sessionId } : {}),
        models: {
          currentModelId: "scripted",
          availableModels: [{ modelId: "scripted", name: "Scripted" }],
        },
      };
    }
    case "session/prompt": {
      const prompt = Option.getOrUndefined(decodePromptParams(params));
      const session = prompt === undefined ? undefined : sessions.get(prompt.sessionId);
      if (prompt === undefined || session === undefined) {
        throw Object.assign(new Error("Unknown session"), { code: -32602 });
      }
      const text = prompt.prompt
        .map((block) =>
          Option.match(decodeTextBlock(block), { onNone: () => "", onSome: (b) => b.text }),
        )
        .join("\n");
      const directive = parseDirective(text);
      const script = SCRIPTS[directive.name] ?? SCRIPTS["plain"];
      const controller = new AbortController();
      session.cancel = () => controller.abort();
      try {
        const stopReason =
          script === undefined
            ? "end_turn"
            : await script({
                sessionId: prompt.sessionId,
                session,
                args: directive.args,
                signal: controller.signal,
              });
        return { stopReason: controller.signal.aborted ? "cancelled" : stopReason };
      } finally {
        session.cancel = undefined;
      }
    }
    case "session/close": {
      const sessionId = String(params["sessionId"]);
      sessions.get(sessionId)?.cancel?.();
      sessions.delete(sessionId);
      return {};
    }
    case "authenticate":
    case "session/set_mode":
    case "session/set_model":
      return {};
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
};

const onMessage = (message: Message) => {
  if (message.method === undefined) {
    const resolve = pending.get(String(message.id));
    pending.delete(String(message.id));
    resolve?.(message.result);
    return;
  }
  if (message.id === undefined || message.id === null) {
    if (message.method === "session/cancel") {
      sessions.get(String(message.params?.["sessionId"]))?.cancel?.();
    }
    return;
  }
  const id = message.id;
  handleRequest(message.method, message.params ?? {}).then(
    (result) => send({ id, result }),
    (error: unknown) =>
      send({
        id,
        error: {
          code:
            typeof error === "object" && error !== null && "code" in error ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      }),
  );
};

NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim().length === 0) return;
  const message = decodeMessage(line);
  if (Option.isSome(message)) onMessage(message.value);
  else process.stderr.write("The scripted agent ignored a line that is not a JSON-RPC message.\n");
});
