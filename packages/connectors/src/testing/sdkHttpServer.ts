// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A fake MCP server for tests, on Node's own HTTP server on loopback.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import {
  createMcpHandler,
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type EventsControl, type EventsFakeOptions, eventsFake } from "./eventsFake.ts";
import { notesServer } from "./notesServer.ts";

export type { Delivered, EventsControl, EventsFakeOptions } from "./eventsFake.ts";
export { APPROVAL_URL } from "./notesServer.ts";

/**
 * The notes server (`notesServer.ts`) over Streamable HTTP on loopback, at
 * one revision: `2026-07-28`, served statelessly by the SDK and refusing
 * older clients, or `2025-11-25`, served with a session per `initialize` as
 * servers of that revision are.
 *
 * At 2026-07-28 it also runs `long_job` as a task (MCP's Tasks extension),
 * which the SDK does not serve: it asks for a yes or no once the task is
 * under way, and ends when answered, unless `endless`, when it runs until
 * cancelled. Given `events`, it offers them too (`eventsFake.ts`).
 */

export type Revision = "2026-07-28" | "2025-11-25";

export interface SdkHttpServer {
  readonly url: string;
  /** Every JSON-RPC method asked, in order, with the headers it came with. */
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly headers: NodeHttp.IncomingHttpHeaders;
  }>;
  /** Says one of its lists changed, to the client listening. */
  readonly changed: (kind: "tools" | "resources" | "prompts") => void;
  /** Whether the task was cancelled (`tasks/cancel`). */
  readonly taskCancelled: () => boolean;
  /** Its events, when it offers them. */
  readonly events: EventsControl | null;
}

export interface SdkHttpOptions {
  readonly revision: Revision;
  /** The task runs until cancelled. */
  readonly endless?: boolean;
  /** The events it offers, at 2026-07-28. */
  readonly events?: EventsFakeOptions;
}

const Rpc = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeRpcs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Rpc, Schema.Array(Rpc)])),
);

const toRequest = (request: NodeHttp.IncomingMessage, body: Buffer, signal: AbortSignal) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
  }
  const method = request.method ?? "GET";
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    method,
    headers,
    signal,
    ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
  });
};

const send = async (answer: Response, response: NodeHttp.ServerResponse) => {
  response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
  if (answer.body === null) return void response.end();
  try {
    for await (const chunk of answer.body) response.write(chunk);
  } catch {
    // The client went away mid-stream.
  }
  response.end();
};

const json = (response: NodeHttp.ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

/** The task `long_job` runs as, step by step. */
const taskFake = (endless: boolean) => {
  let polls = 0;
  let answer: unknown;
  let cancelled = false;
  const now = "2026-11-01T09:00:00.000Z";
  const base = {
    taskId: "task-7",
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 60_000,
    pollIntervalMs: 500,
  };
  const state = () => {
    if (cancelled) return { ...base, status: "cancelled" };
    if (endless || polls < 1)
      return { ...base, status: "working", statusMessage: `Step ${polls + 1}` };
    if (answer === undefined) {
      return {
        ...base,
        status: "input_required",
        inputRequests: {
          keep: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Keep the old copy?",
              requestedSchema: {
                type: "object",
                properties: { keep: { type: "boolean", title: "Keep it" } },
                required: ["keep"],
              },
            },
          },
        },
      };
    }
    return {
      ...base,
      status: "completed",
      result: { content: [{ type: "text", text: `job done: ${JSON.stringify(answer)}` }] },
    };
  };
  return {
    created: () => ({ resultType: "task", ...base, status: "working", statusMessage: "Starting" }),
    get: () => {
      const current = state();
      polls += 1;
      return { resultType: "complete", ...current };
    },
    update: (responses: unknown) => {
      answer = responses;
      return { resultType: "complete" };
    },
    cancel: () => {
      cancelled = true;
      return { resultType: "complete" };
    },
    cancelled: () => cancelled,
  };
};

export const sdkHttpServer = (options: SdkHttpOptions) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly fake: SdkHttpServer;
      readonly server: NodeHttp.Server;
      readonly close: () => Promise<void>;
    }>((resume) => {
      const requests: Array<{ method: string; headers: NodeHttp.IncomingHttpHeaders }> = [];
      const task = taskFake(options.endless === true);
      const events = options.events === undefined ? null : eventsFake(options.events);
      const modern = createMcpHandler(() => notesServer({ events: events !== null }), {
        legacy: "reject",
      });
      const legacy = new Map<
        string,
        { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }
      >();

      const legacyAnswer = async (request: Request, initialize: boolean): Promise<Response> => {
        const id = request.headers.get("mcp-session-id");
        const known = id === null ? undefined : legacy.get(id);
        if (known !== undefined) return known.transport.handleRequest(request);
        if (!initialize) return new Response("Unknown session", { status: 404 });
        const server = notesServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => NodeCrypto.randomUUID(),
          onsessioninitialized: (sessionId) => {
            legacy.set(sessionId, { transport, server });
          },
        });
        await server.connect(transport);
        return transport.handleRequest(request);
      };

      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks);
          const parsed = decodeRpcs(body.toString("utf8"));
          const rpcs = Option.match(parsed, {
            onNone: () => [],
            onSome: (value) => (Array.isArray(value) ? value : [value]),
          });
          for (const rpc of rpcs) {
            if (rpc.method !== undefined)
              requests.push({ method: rpc.method, headers: request.headers });
          }
          const [rpc] = rpcs;
          if (
            events !== null &&
            rpc?.id !== undefined &&
            rpc.method !== undefined &&
            events.handle({ id: rpc.id, method: rpc.method, params: rpc.params ?? {} }, response)
          ) {
            return;
          }
          if (options.revision === "2026-07-28" && rpc?.id !== undefined) {
            const taskId = rpc.params?.["taskId"];
            if (rpc.method === "tools/call" && rpc.params?.["name"] === "long_job") {
              return json(response, { jsonrpc: "2.0", id: rpc.id, result: task.created() });
            }
            if (rpc.method?.startsWith("tasks/") === true && taskId !== "task-7") {
              return json(response, {
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32602, message: "Unknown task" },
              });
            }
            if (rpc.method === "tasks/get")
              return json(response, { jsonrpc: "2.0", id: rpc.id, result: task.get() });
            if (rpc.method === "tasks/update") {
              return json(response, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: task.update(rpc.params?.["inputResponses"]),
              });
            }
            if (rpc.method === "tasks/cancel")
              return json(response, { jsonrpc: "2.0", id: rpc.id, result: task.cancel() });
          }
          const abort = new AbortController();
          response.on("close", () => abort.abort());
          const web = toRequest(request, body, abort.signal);
          const answer =
            options.revision === "2026-07-28"
              ? modern.fetch(web)
              : legacyAnswer(web, rpc?.method === "initialize");
          void answer.then((value) => send(value, response));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address !== null && typeof address === "object" ? address.port : 0;
        resume(
          Effect.succeed({
            server,
            close: async () => {
              await modern.close();
              for (const { server: one } of legacy.values()) await one.close();
            },
            fake: {
              url: `http://127.0.0.1:${port}/mcp`,
              requests,
              changed: (kind) => {
                if (options.revision === "2026-07-28") {
                  if (kind === "tools") modern.notify.toolsChanged();
                  else if (kind === "resources") modern.notify.resourcesChanged();
                  else modern.notify.promptsChanged();
                  return;
                }
                for (const { server: one } of legacy.values()) {
                  if (kind === "tools") one.sendToolListChanged();
                  else if (kind === "resources") one.sendResourceListChanged();
                  else one.sendPromptListChanged();
                }
              },
              taskCancelled: task.cancelled,
              events: events?.control ?? null,
            },
          }),
        );
      });
    }),
    ({ server, close }) =>
      Effect.callback<void>((resume) => {
        void close().finally(() => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        });
      }),
  ).pipe(Effect.map(({ fake }) => fake));
