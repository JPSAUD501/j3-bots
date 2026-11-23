#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- a standalone MCP server process, run by tests with plain Node.
//
// A tiny MCP server over standard input and output, for the tests of command
// connectors: what they start is a real process, speaking MCP as a server
// started by command does. Its tools tell the test what the process was given:
//
// - `whoami`: its process id;
// - `environment`: the names of its environment variables;
// - `echo`: the value of the variable `name`, as a server that leaks a secret would;
// - `arguments`: its command line's arguments;
// - `spawn`: starts a process of its own that never ends, and gives its id;
// - `exit`: answers, then ends with an error, as a server that crashes.
//
// It writes a line that is not MCP to its output before anything else, and
// its whole environment to its standard error, as careless servers do. An
// argument `--tool <name>` adds a tool that does nothing.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request));
const CallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeCall = Schema.decodeUnknownOption(CallParams);

const extra = process.argv.flatMap((word, index) =>
  process.argv[index - 1] === "--tool" ? [word] : [],
);

const tool = (name: string, description: string) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
});

const TOOLS = [
  tool("whoami", "Gives the server's process id"),
  tool("environment", "Gives the names of the server's environment variables"),
  tool("echo", "Gives the value of an environment variable"),
  tool("arguments", "Gives the server's arguments"),
  tool("spawn", "Starts a process that never ends"),
  tool("exit", "Ends the server"),
  ...extra.map((name) => tool(name, "Does nothing")),
];

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

const answer = (name: string, args: Readonly<Record<string, unknown>>): string => {
  switch (name) {
    case "whoami":
      return String(process.pid);
    case "environment":
      return JSON.stringify(Object.keys(process.env).toSorted());
    case "echo":
      return String(process.env[String(args["name"])] ?? "");
    case "arguments":
      return JSON.stringify(process.argv.slice(2));
    case "spawn": {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        },
      );
      return String(child.pid);
    }
    case "exit":
      setTimeout(() => process.exit(3), 50);
      return "ending";
    default:
      return "done";
  }
};

process.stdout.write("fixture: starting, and this line is not MCP\n");
process.stderr.write(`${JSON.stringify(process.env)}\n`);

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = decodeRequest(line);
  if (Option.isNone(request) || request.value.id === undefined) return;
  const { id, method, params } = request.value;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: String(params?.["protocolVersion"] ?? "2025-11-25"),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const call = decodeCall(params);
      if (Option.isNone(call)) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: text(answer(call.value.name, call.value.arguments ?? {})),
      });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
// A server started by command ends when its input closes, as the MCP specification asks.
lines.on("close", () => process.exit(0));
