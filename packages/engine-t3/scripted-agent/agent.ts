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
import * as NodeChildProcess from "node:child_process";
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
const decodeToolResult = Schema.decodeUnknownOption(McpToolResult);

/**
 * The bot tools' bridge, as the engine gives an ACP agent its command line
 * (`TOOL_BRIDGE_VARIABLE` in `src/t3/Provision.ts`), when it does.
 */
const toolBridge = Option.flatMap(
  Option.fromNullishOr(process.env["J3_TOOL_BRIDGE"]),
  Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String))),
);
const decodeCreated = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);
const decodeToolList = Schema.decodeUnknownOption(
  Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);

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
  /** The prompt's text, as the engine sent it. */
  readonly text: string;
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

/** Streams `text` as the agent's message, a word at a time: it reaches no J3 Bots conversation. */
const stream = async (turn: Turn, text: string) => {
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
    await stream(turn, `No host tools: cannot call ${tool}.`);
    return { failed: true, text: "" };
  }
  const { toolCallId, rawInput } = reportToolCall(turn, server.value.name, tool, input);
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
  return reportToolResult(turn, toolCallId, rawInput, answer);
};

/** Reports an MCP tool call's start, the way an agent does. */
const reportToolCall = (
  turn: Turn,
  server: string,
  tool: string,
  input: Record<string, unknown>,
) => {
  const toolCallId = `${tool}-${NodeCrypto.randomUUID()}`;
  const rawInput = { server, tool, arguments: input };
  update(turn.sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: `${server}/${tool}`,
    kind: "other",
    status: "in_progress",
    rawInput,
    _meta: { is_mcp_tool_call: true },
  });
  return { toolCallId, rawInput };
};

/** Reports how an MCP tool call ended, and returns what it answered. */
const reportToolResult = (
  turn: Turn,
  toolCallId: string,
  rawInput: Record<string, unknown>,
  answer: Option.Option<typeof McpToolResult.Type>,
): HostToolResult => {
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

/** The `j3` bridge, started for one exchange of MCP. */
interface Bridge {
  /** Sends a request and waits for its result: none once the bridge has ended. */
  readonly request: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Option.Option<unknown>>;
  /** Ends its input, which ends the bridge. */
  readonly close: () => void;
}

/**
 * Starts the `j3` bridge the engine named (`toolBridge`), which inherits this
 * agent's environment and with it the session's thread id, and opens MCP
 * with it over standard input and output. None when the engine named no
 * bridge, or the bridge ended before it answered. Every request still
 * waiting when the bridge ends, or written after, gets none; `signal`, when
 * given, kills it.
 */
const openBridge = async (signal?: AbortSignal): Promise<Option.Option<Bridge>> => {
  const [command, ...args] = Option.getOrElse(toolBridge, () => []);
  if (command === undefined) return Option.none();
  const child = NodeChildProcess.spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const answers = new Map<string, (result: Option.Option<unknown>) => void>();
  let ended = false;
  const end = () => {
    ended = true;
    for (const answer of answers.values()) answer(Option.none());
    answers.clear();
  };
  // `close` comes once its output has been read to the end, so an answer
  // written just before it exits still counts.
  child.once("close", end);
  child.once("error", end);
  // Writing to a bridge that has already exited.
  child.stdin.on("error", end);
  const kill = () => child.kill();
  signal?.addEventListener("abort", kill, { once: true });
  NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const message = decodeMessage(line);
    if (Option.isNone(message)) return;
    const id = String(message.value.id);
    answers.get(id)?.(Option.some(message.value.result));
    answers.delete(id);
  });
  const write = (message: Record<string, unknown>) => {
    if (!ended) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Option.Option<unknown>>((resolve) => {
      if (ended) return resolve(Option.none());
      const id = String(nextId++);
      answers.set(id, resolve);
      write({ id, method, params });
    });
  const close = () => {
    signal?.removeEventListener("abort", kill);
    child.stdin.end();
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "j3-scripted-agent", version: "1" },
  });
  if (Option.isNone(initialized)) {
    close();
    return Option.none();
  }
  write({ method: "notifications/initialized" });
  return Option.some({ request, close });
};

/**
 * Calls one of J3 Bots' own tools, as a harness does: it starts the `j3`
 * bridge for one call and reports the call as an MCP tool call.
 */
const callBotTool = async (
  turn: Turn,
  tool: string,
  input: Record<string, unknown>,
): Promise<HostToolResult> => {
  if (Option.isNone(toolBridge)) {
    await stream(turn, `No bot tools: cannot call ${tool}.`);
    return { failed: true, text: "" };
  }
  const { toolCallId, rawInput } = reportToolCall(turn, "j3", tool, input);
  const bridge = await openBridge(turn.signal);
  if (Option.isNone(bridge)) return reportToolResult(turn, toolCallId, rawInput, Option.none());
  try {
    const result = await bridge.value.request("tools/call", { name: tool, arguments: input });
    return reportToolResult(
      turn,
      toolCallId,
      rawInput,
      Option.flatMap(result, (value) => decodeToolResult({ result: value })),
    );
  } finally {
    bridge.value.close();
  }
};

/** The names of the tools the `j3` bridge lists: none when there is no bridge, or it answers nothing. */
const listBotTools = async (): Promise<ReadonlyArray<string>> => {
  const bridge = await openBridge();
  if (Option.isNone(bridge)) return [];
  try {
    const listed = Option.flatMap(await bridge.value.request("tools/list", {}), decodeToolList);
    return Option.match(listed, {
      onNone: () => [],
      onSome: ({ tools }) => tools.map((tool) => tool.name),
    });
  } finally {
    bridge.value.close();
  }
};

let botSpeech: Promise<boolean> | undefined;

/**
 * Whether this agent has J3 Bots' speech tool: the bridge the engine named
 * lists `say`. Asked once, as a harness lists a server's tools once, since
 * the engine runs one agent process per thread. The conformance bench names
 * a bridge that answers nothing, so there every answer goes through the
 * engine's own tools.
 */
const hasBotSpeech = (): Promise<boolean> =>
  (botSpeech ??= listBotTools().then((names) => names.includes("say")));

/**
 * Answers the turn as a bot does, through J3 Bots' `say` with `done: true`,
 * which is what has the server count the turn as delivered, when this agent
 * has it; otherwise through the engine's own `send_to_user`.
 */
const answer = async (turn: Turn, text: string): Promise<void> => {
  if (await hasBotSpeech()) await callBotTool(turn, "say", { text, done: true });
  else await callHostTool(turn, "send_to_user", { message: text });
};

/** The kind of the J3 Bots wake a prompt opens with, and its event, as its envelope names them. */
const WAKE = /<j3-wake kind="([a-z]+)"(?: event="([a-z-]+)")?/;

/**
 * Whether a bot owes its user a reply to this prompt: a wake from its user,
 * or a system event such as its first hello, an answer that never arrived
 * or the end of a step it asked them for, but not a change to its profile,
 * which it only follows. A room, a teammate or a routine is answered by
 * silence when there is nothing to add, as a room settles, and a turn the
 * engine started on its own carries no wake.
 */
const owesReply = (text: string): boolean => {
  const [, kind, event] = WAKE.exec(text) ?? [];
  return kind === "user" || (kind === "system" && event !== "profile-changed");
};

/** The teammates the `team` script creates, in order. */
const TEAM = ["Ana", "Bo", "Cy", "Di", "Ed"];

/** The commands the `steps` script runs, in turn. */
const STEP_COMMANDS = ["git status", "pnpm test", "pnpm lint", "git diff --stat"];

/**
 * Every script the conformance suite uses.
 *
 * - `plain`: a short reply, "Scripted reply.", and usage. When the agent has
 *   J3 Bots' `say` and the prompt is a wake a bot owes its user a reply to
 *   (`owesReply`), the reply is a `say` with `done: true`; otherwise it is
 *   the agent's own message, which reaches no conversation.
 * - `slow`: streams a word every `every` ms (default 200) until cancelled or
 *   `for` ms pass (default 60000). For stops and steers.
 * - `approval`: asks permission for a write, then says whether it was granted.
 * - `question`: asks one multiple-choice question and repeats the answer.
 * - `speak`: answers `text` as a bot does (`answer`): J3 Bots' `say` with
 *   `done: true` when the agent has it, the engine's `send_to_user` otherwise.
 * - `steps`: thinks for `think` ms (default 2000), runs `count` commands
 *   (default 3) of `each` ms (default 4000), then answers `text` as `speak`
 *   does. For a turn's work as a client shows it while it runs.
 * - `secret`: asks for a secret through the engine's `request_secret` tool:
 *   one value, or the comma-separated `fields`, each labelled with its name
 *   and masked unless `plain` names it too.
 * - `browse`: opens `url` in the engine's browser (`preview_open`), then acts
 *   on the tab every `every` ms (default 1000) for up to `for` ms (default
 *   60000). It speaks through the engine's `send_to_user` the first time an
 *   action is refused, with the engine's reason, and the first time one
 *   works again after, and ends then.
 * - `delegate`: hands a task to a child agent through the engine's
 *   `delegate_task` tool, then ends; the engine wakes the session when the
 *   child's task ends. The child runs `plain`, or with `child=slow`, `slow`
 *   for two minutes, or with `child=browser`, `browser`.
 * - `send`: sends the thread `to` a message through the engine's
 *   `t3_thread_send` tool, which has it run `browser`, then ends.
 * - `browser`: calls the engine's `t3_preview_list`, which only a session
 *   given the browser may call, then says `allowed` or `refused` through the
 *   engine's `send_to_user`.
 * - `team`: a primary bot building a team on J3 Bots' own tools: creates
 *   `count` teammates (default 4) with `create_bot`, starts a room with them
 *   with `start_room`, whose kickoff has each member run `room-answer`, then
 *   `say`s what it set up and ends. It `say`s the refusal instead when a call
 *   is refused.
 * - `room-answer`: `say`s `Answer #<n>.` and ends, where `n` is one more
 *   than the answers its prompt already carries: the members a kickoff woke
 *   one at a time count 1, 2, 3 and so on.
 *
 * No script starts work on its own after its turn: the engine offers a
 * continuation only to agents it recognizes by name (**Read**, `bc0f04d`,
 * `provider-acp-registry/src/server/adapter.ts`), and this agent claims no
 * other agent's name. Only the engine's own delegated task outlives a turn.
 */
const SCRIPTS: Record<string, (turn: Turn) => Promise<StopReason>> = {
  plain: async (turn) => {
    if (owesReply(turn.text) && (await hasBotSpeech())) {
      await callBotTool(turn, "say", { text: "Scripted reply.", done: true });
    } else {
      await stream(turn, "Scripted reply.");
    }
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
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
    await stream(turn, granted ? "Permission granted." : "Permission refused.");
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
    await stream(
      turn,
      Option.isSome(colour) ? `You picked ${String(colour.value)}.` : "No answer.",
    );
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
    await answer(turn, turn.args.get("text") ?? "Done: every step passed.");
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  speak: async (turn) => {
    await answer(turn, turn.args.get("text") ?? "A message from the scripted agent.");
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  browser: async (turn) => {
    const listed = await callHostTool(turn, "t3_preview_list", {});
    await callHostTool(turn, "send_to_user", {
      message: listed.failed ? "refused" : "allowed",
    });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  delegate: async (turn) => {
    const named = turn.args.get("child");
    const child =
      named === "slow"
        ? "[[script:slow every=500 for=120000]]"
        : named === "browser"
          ? "[[script:browser]]"
          : "[[script:plain]]";
    await callHostTool(turn, "delegate_task", {
      task: child,
      title: "Scripted delegate",
    });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  send: async (turn) => {
    await callHostTool(turn, "t3_thread_send", {
      threadId: turn.args.get("to") ?? "",
      message: "[[script:browser]]",
      mode: "auto",
    });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  secret: async (turn) => {
    const fields = turn.args.get("fields")?.split(",");
    const plain = new Set(turn.args.get("plain")?.split(",") ?? []);
    const result = await callHostTool(turn, "request_secret", {
      label: turn.args.get("label") ?? "Scripted token",
      reason: "The conformance suite asks for a secret.",
      ...(fields === undefined
        ? {}
        : {
            fields: fields.map((name) => ({
              name,
              label: name,
              ...(plain.has(name) ? { secret: false } : {}),
            })),
          }),
    });
    if (turn.signal.aborted) return "cancelled";
    await stream(turn, result.failed ? "Secret request failed." : "Secret request finished.");
    reportUsage(turn);
    return "end_turn";
  },
  team: async (turn) => {
    const refused = async (text: string) => {
      await callBotTool(turn, "say", { text: `Refused: ${text}`, done: true });
      reportUsage(turn);
      return "end_turn" as const;
    };
    const members: Array<string> = [];
    for (const name of TEAM.slice(0, Number(turn.args.get("count") ?? "4"))) {
      const created = await callBotTool(turn, "create_bot", { name, job: `${name} owns a part.` });
      const id = Option.map(decodeCreated(created.text), (value) => value.id);
      if (created.failed || Option.isNone(id)) return refused(created.text);
      members.push(id.value);
    }
    const started = await callBotTool(turn, "start_room", {
      name: "Support",
      members,
      kickoff: "Each of you takes one part, in the order you are named. [[script:room-answer]]",
      with_user: true,
    });
    if (started.failed) return refused(started.text);
    await callBotTool(turn, "say", { text: "I started Support with the team.", done: true });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
  },
  "room-answer": async (turn) => {
    const seen = turn.text.match(/Answer #\d+\./g)?.length ?? 0;
    await callBotTool(turn, "say", { text: `Answer #${seen + 1}.`, done: true });
    reportUsage(turn);
    return turn.signal.aborted ? "cancelled" : "end_turn";
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
                text,
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
