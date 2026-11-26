// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A fake MCP server for tests, on Node's own HTTP server on loopback.
import * as NodeHttp from "node:http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A Streamable HTTP MCP server for tests, on loopback, of the 2025-11-25
 * revision: enough of it for a session to open (refusing `server/discover`
 * as a server of that revision does), list tools (in pages), call them, read
 * resources and hear that its tools changed. Each tool answers with what its handler returns, and the
 * server records every request's headers. Like a server that ignores
 * cancellation, it keeps a request it holds open until the client closes it.
 */

interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a call answers: a result, a raw body, nothing at all (it is held until
 * the client closes it), or the refusal of its credentials once `after` is
 * done, as a service that ended a key while the call was on its way.
 */
type FakeAnswer =
  | {
      readonly _tag: "result";
      readonly text: string;
      readonly isError?: boolean;
      readonly structuredContent?: Readonly<Record<string, unknown>>;
    }
  | { readonly _tag: "raw"; readonly body: string }
  | { readonly _tag: "hang" }
  | { readonly _tag: "refuse"; readonly after: Promise<void> };

interface FakeRequest {
  readonly method: string;
  readonly rpc: string | null;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

export interface FakeMcpServer {
  readonly url: string;
  readonly requests: ReadonlyArray<FakeRequest>;
  /** The capabilities each `initialize` declared, in order. */
  readonly clientCapabilities: ReadonlyArray<unknown>;
  /** Replaces the listed tools. */
  readonly setTools: (tools: ReadonlyArray<FakeTool>) => void;
  /** Tells every open stream that the tools changed. */
  readonly notifyToolsChanged: () => void;
  /** Done once the client opened its stream for server messages. */
  readonly streamOpened: Effect.Effect<void>;
  /** Done once the server has held `count` requests unanswered, in all. */
  readonly held: (count: number) => Effect.Effect<void>;
  /** Done once the client has closed every request the server holds. */
  readonly released: Effect.Effect<void>;
  /** Done once the client cancelled a request (`notifications/cancelled`). */
  readonly cancelled: Effect.Effect<void>;
}

export interface FakeOptions {
  readonly tools: ReadonlyArray<FakeTool>;
  readonly call: (name: string, args: unknown, headers: NodeHttp.IncomingHttpHeaders) => FakeAnswer;
  /** Answers `refusal` (401 `invalid_token` by default) unless `authorization` is accepted. */
  readonly authorize?: (authorization: string | undefined) => boolean;
  readonly refusal?: { readonly status: number; readonly challenge: string };
  /** Holds every request for these methods unanswered, as it is asked. */
  readonly hold?: (rpc: string) => boolean;
  /** Lists the tools this many to a page. */
  readonly pageSize?: number;
  /** What `resources/read` answers for an address: its `contents`, or an error when undefined. */
  readonly resources?: (uri: string) => ReadonlyArray<unknown> | undefined;
}

const Rpc = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(
    Schema.Struct({
      protocolVersion: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      arguments: Schema.optionalKey(Schema.Unknown),
      cursor: Schema.optionalKey(Schema.String),
      uri: Schema.optionalKey(Schema.String),
      capabilities: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const decodeRpc = Schema.decodeUnknownSync(Schema.fromJsonString(Rpc));

export const fakeMcpServer = (options: FakeOptions) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly fake: FakeMcpServer; readonly server: NodeHttp.Server }>(
      (resume) => {
        let tools = options.tools;
        const requests: Array<FakeRequest> = [];
        const clientCapabilities: Array<unknown> = [];
        const streams = new Set<NodeHttp.ServerResponse>();
        const streamOpened = Deferred.makeUnsafe<void>();
        const cancelled = Deferred.makeUnsafe<void>();
        let heldCount = 0;
        const holding = new Set<NodeHttp.ServerResponse>();
        const heldWaiters: Array<{
          readonly count: number;
          readonly done: Deferred.Deferred<void>;
        }> = [];
        const releasedWaiters: Array<Deferred.Deferred<void>> = [];
        const hold = (response: NodeHttp.ServerResponse) => {
          heldCount += 1;
          holding.add(response);
          response.on("close", () => {
            holding.delete(response);
            if (holding.size > 0) return;
            for (const done of releasedWaiters.splice(0)) Deferred.doneUnsafe(done, Effect.void);
          });
          for (const waiter of heldWaiters.filter((w) => w.count <= heldCount)) {
            heldWaiters.splice(heldWaiters.indexOf(waiter), 1);
            Deferred.doneUnsafe(waiter.done, Effect.void);
          }
        };
        const reply = (response: NodeHttp.ServerResponse, id: string | number, result: unknown) => {
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "fake-session",
          });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        };
        const refuse = (response: NodeHttp.ServerResponse, id: string | number) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
        };
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          request.on("end", () => {
            const rpc = request.method === "POST" ? decodeRpc(body) : null;
            requests.push({
              method: request.method ?? "",
              rpc: rpc?.method ?? null,
              headers: request.headers,
            });
            const refuse401 = () => {
              const refusal = options.refusal ?? {
                status: 401,
                challenge: 'Bearer error="invalid_token"',
              };
              response.writeHead(refusal.status, { "www-authenticate": refusal.challenge });
              response.end();
            };
            if (
              options.authorize !== undefined &&
              !options.authorize(request.headers.authorization)
            ) {
              return refuse401();
            }
            if (request.method === "GET") {
              response.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
              });
              response.flushHeaders();
              streams.add(response);
              Deferred.doneUnsafe(streamOpened, Effect.void);
              response.on("close", () => streams.delete(response));
              return;
            }
            if (request.method === "DELETE") {
              response.writeHead(200);
              response.end();
              return;
            }
            if (rpc?.method === "notifications/cancelled")
              Deferred.doneUnsafe(cancelled, Effect.void);
            if (rpc === null || rpc.id === undefined) {
              response.writeHead(202);
              response.end();
              return;
            }
            if (options.hold?.(rpc.method) === true) return hold(response);
            switch (rpc.method) {
              case "server/discover":
                return refuse(response, rpc.id);
              case "initialize":
                clientCapabilities.push(rpc.params?.capabilities);
                return reply(response, rpc.id, {
                  protocolVersion: rpc.params?.protocolVersion ?? "2025-11-25",
                  capabilities: {
                    tools: { listChanged: true },
                    ...(options.resources === undefined ? {} : { resources: {} }),
                  },
                  serverInfo: { name: "fake", version: "1.0.0" },
                });
              case "tools/list": {
                const from = Number(rpc.params?.cursor ?? 0);
                const to = from + (options.pageSize ?? tools.length);
                return reply(response, rpc.id, {
                  tools: tools.slice(from, to).map((tool) => ({
                    inputSchema: { type: "object", properties: {} },
                    ...tool,
                  })),
                  ...(to < tools.length ? { nextCursor: String(to) } : {}),
                });
              }
              case "tools/call": {
                const answer = options.call(
                  rpc.params?.name ?? "",
                  rpc.params?.arguments,
                  request.headers,
                );
                if (answer._tag === "hang") return hold(response);
                if (answer._tag === "refuse") return void answer.after.then(refuse401);
                if (answer._tag === "raw") {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(answer.body);
                  return;
                }
                return reply(response, rpc.id, {
                  content: [{ type: "text", text: answer.text }],
                  isError: answer.isError ?? false,
                  ...(answer.structuredContent === undefined
                    ? {}
                    : { structuredContent: answer.structuredContent }),
                });
              }
              case "resources/read": {
                const contents = options.resources?.(rpc.params?.uri ?? "");
                if (contents === undefined) {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: rpc.id,
                      error: { code: -32002, message: "Resource not found" },
                    }),
                  );
                  return;
                }
                return reply(response, rpc.id, { contents });
              }
              default:
                return reply(response, rpc.id, {});
            }
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = address !== null && typeof address === "object" ? address.port : 0;
          resume(
            Effect.succeed({
              server,
              fake: {
                url: `http://127.0.0.1:${port}/mcp`,
                requests,
                clientCapabilities,
                streamOpened: Deferred.await(streamOpened),
                held: (count) =>
                  Effect.suspend(() => {
                    if (heldCount >= count) return Effect.void;
                    const done = Deferred.makeUnsafe<void>();
                    heldWaiters.push({ count, done });
                    return Deferred.await(done);
                  }),
                released: Effect.suspend(() => {
                  if (holding.size === 0) return Effect.void;
                  const done = Deferred.makeUnsafe<void>();
                  releasedWaiters.push(done);
                  return Deferred.await(done);
                }),
                cancelled: Deferred.await(cancelled),
                setTools: (next) => {
                  tools = next;
                },
                notifyToolsChanged: () => {
                  for (const stream of streams) {
                    stream.write(
                      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
                    );
                  }
                },
              },
            }),
          );
        });
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ fake }) => fake));
