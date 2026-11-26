// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- drives the agent as the engine does: a plain Node process on its own pipes, with a local MCP server beside it.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AGENT = `${import.meta.dirname}/agent.ts`;

/**
 * A `j3` bridge that lists `say` and answers each call with its arguments,
 * so the agent's report of the call shows what reached the bridge.
 */
const SPEAKING_BRIDGE = `
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "j3", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "say", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

/** A bridge that ends without answering, as the conformance bench's does. */
const SILENT_BRIDGE = "";

const Answer = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

const ToolCallEnded = Schema.Struct({
  method: Schema.Literal("session/update"),
  params: Schema.Struct({
    update: Schema.Struct({
      sessionUpdate: Schema.Literal("tool_call_update"),
      status: Schema.String,
      rawInput: Schema.Struct({
        server: Schema.String,
        tool: Schema.String,
        arguments: Schema.Record(Schema.String, Schema.Unknown),
      }),
      rawOutput: Schema.Struct({ text: Schema.String }),
    }),
  }),
});
const decodeToolCallEnded = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallEnded));

const McpRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({ arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
});
const decodeMcpRequest = Schema.decodeUnknownOption(Schema.fromJsonString(McpRequest));

const SessionCreated = Schema.Struct({ sessionId: Schema.String });
const PromptEnded = Schema.Struct({ stopReason: Schema.String });

/** A tool call as the agent reported its end. */
interface ToolCall {
  readonly server: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly status: string;
  /** What the server answered. */
  readonly answered: string;
}

/**
 * The engine's own MCP server for a session, as the engine offers it over
 * HTTP, answering each tool call with its arguments.
 */
const startHostTools = () =>
  new Promise<{ readonly url: string; readonly close: () => void }>((resolve) => {
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        const message = decodeMcpRequest(body);
        if (Option.isNone(message) || message.value.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.value.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "t3", version: "1" },
              }
            : {
                content: [
                  { type: "text", text: JSON.stringify(message.value.params?.arguments ?? {}) },
                ],
              };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.value.id, result }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => server.close() });
    });
  });

/**
 * The agent, run as the engine runs it, with `bridge` as the source of the
 * `j3` bridge the engine names, and one session on the given host tools.
 */
const startAgent = async (bridge: string, hostUrl: string) => {
  const child = NodeChildProcess.spawn(process.execPath, [AGENT], {
    env: { ...process.env, J3_TOOL_BRIDGE: JSON.stringify([process.execPath, "-e", bridge]) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const answers = new Map<number, (answer: typeof Answer.Type) => void>();
  let calls: Array<ToolCall> = [];
  NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const ended = decodeToolCallEnded(line);
    if (Option.isSome(ended)) {
      const { rawInput, status, rawOutput } = ended.value.params.update;
      calls.push({ ...rawInput, status, answered: rawOutput.text });
      return;
    }
    const answer = decodeAnswer(line);
    if (Option.isNone(answer)) return;
    answers.get(answer.value.id)?.(answer.value);
    answers.delete(answer.value.id);
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      answers.set(id, (answer) =>
        answer.error === undefined
          ? resolve(answer.result)
          : reject(new Error(`${method} failed: ${JSON.stringify(answer.error)}`)),
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = Schema.decodeUnknownSync(SessionCreated)(
    await request("session/new", {
      cwd: import.meta.dirname,
      mcpServers: [{ type: "http", name: "t3", url: hostUrl, headers: [] }],
    }),
  );
  return {
    /** Runs one turn on `text` and returns the tool calls it made, in order. */
    prompt: async (text: string) => {
      calls = [];
      const { stopReason } = Schema.decodeUnknownSync(PromptEnded)(
        await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
      );
      assert.strictEqual(stopReason, "end_turn");
      return calls;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.stdin.end();
      }),
  };
};

const wake = (kind: string, body: string, event?: string) =>
  `<j3-wake kind="${kind}"${event === undefined ? "" : ` event="${event}"`} at="2026-11-20T09:41:00-03:00">\n${body}\n</j3-wake>`;

describe("the scripted agent", () => {
  it("answers what a bot owes its user through J3 Bots' say, and stays quiet elsewhere", async () => {
    const host = await startHostTools();
    const agent = await startAgent(SPEAKING_BRIDGE, host.url);
    try {
      const said = (text: string): ToolCall => {
        const input = { text, done: true };
        return {
          server: "j3",
          tool: "say",
          arguments: input,
          status: "completed",
          answered: JSON.stringify(input),
        };
      };
      assert.deepStrictEqual(await agent.prompt(wake("user", "Hi")), [said("Scripted reply.")]);
      assert.deepStrictEqual(await agent.prompt(wake("system", "", "first-run")), [
        said("Scripted reply."),
      ]);
      assert.deepStrictEqual(await agent.prompt(wake("system", "", "profile-changed")), []);
      assert.deepStrictEqual(await agent.prompt(wake("room", "Ana: done.")), []);
      assert.deepStrictEqual(await agent.prompt(wake("routine", "Check the inbox.")), []);
      assert.deepStrictEqual(await agent.prompt("[[script:speak text=Hello]]"), [said("Hello")]);
    } finally {
      await agent.stop();
      host.close();
    }
  });

  it("answers through the engine's send_to_user when its bridge answers nothing", async () => {
    const host = await startHostTools();
    const agent = await startAgent(SILENT_BRIDGE, host.url);
    try {
      assert.deepStrictEqual(await agent.prompt(wake("user", "Hi")), []);
      assert.deepStrictEqual(await agent.prompt("[[script:speak text=Hello]]"), [
        {
          server: "t3",
          tool: "send_to_user",
          arguments: { message: "Hello" },
          status: "completed",
          answered: JSON.stringify({ message: "Hello" }),
        },
      ]);
    } finally {
      await agent.stop();
      host.close();
    }
  });
});
