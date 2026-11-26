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
// - `folder`: the folder it runs in;
// - `spawn`: starts a process of its own that never ends, and gives its id;
// - `exit`: answers, then ends with an error, as a server that crashes;
// - `flood`: answers, then writes more than a message may hold, unasked.
//
// It writes a line that is not MCP to its output before anything else, and
// its whole environment to its standard error, as careless servers do. An
// argument `--tool <name>` adds a tool that does nothing; `--exit-on-unknown`
// makes it end at a request it does not know, as `server/discover` is to it.
//
// It imports nothing but Node's own modules: a test starts it many times, and
// a library to read its lines would take most of each start.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON-RPC request with an id, or none for anything else (a notification, a line that is not JSON). */
const decodeRequest = (
  line: string,
): { readonly id: string | number; readonly method: string; readonly params: Fields } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isFields(parsed)) return null;
  const { id, method, params } = parsed;
  if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string") return null;
  if (params !== undefined && !isFields(params)) return null;
  return { id, method, params: params ?? {} };
};

/** A tool call's name and arguments, or none when they are not those. */
const decodeCall = (
  params: Fields,
): { readonly name: string; readonly arguments: Fields } | null => {
  const { name, arguments: args } = params;
  if (typeof name !== "string" || (args !== undefined && !isFields(args))) return null;
  return { name, arguments: args ?? {} };
};

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
  tool("folder", "Gives the folder the server runs in"),
  tool("spawn", "Starts a process that never ends"),
  tool("exit", "Ends the server"),
  tool("flood", "Writes too long a message"),
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
    case "folder":
      return process.cwd();
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
    case "flood":
      setTimeout(() => process.stdout.write("x".repeat(11 * 1024 * 1024)), 50);
      return "flooding";
    default:
      return "done";
  }
};

process.stdout.write("fixture: starting, and this line is not MCP\n");
process.stderr.write(`${JSON.stringify(process.env)}\n`);

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = decodeRequest(line);
  if (request === null) return;
  const { id, method, params } = request;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: String(params["protocolVersion"] ?? "2025-11-25"),
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
      if (call === null) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: text(answer(call.name, call.arguments)),
      });
      return;
    }
    default:
      // As servers on SDKs that end at a request they do not know.
      if (process.argv.includes("--exit-on-unknown")) process.exit(1);
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
// A server started by command ends when its input closes, as the MCP specification asks.
lines.on("close", () => process.exit(0));
