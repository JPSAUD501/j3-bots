// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A fake MCP server for tests, on Node's own HTTP server on loopback.
import * as NodeHttp from "node:http";
import {
  type Skill,
  SKILLS_EXTENSION_ID,
  skillEntry,
} from "@modelcontextprotocol/server/ext/skills";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A Streamable HTTP MCP server for tests, on loopback, of the 2025-11-25
 * revision: enough of it for a session to open (refusing `server/discover`
 * as a server of that revision does), list tools (in pages), call them, read
 * resources, serve skills (MCP's Skills extension) and hear that its tools
 * changed. Each tool answers with what its handler returns, and the
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
 * the client closes it), the refusal of its credentials once `after` is done,
 * as a service that ended a key while the call was on its way, or a server
 * error once `after` is done.
 */
type FakeAnswer =
  | {
      readonly _tag: "result";
      /** Its text block; none, for an answer of structured content alone. */
      readonly text: string | null;
      readonly isError?: boolean;
      readonly structuredContent?: Readonly<Record<string, unknown>>;
    }
  | { readonly _tag: "raw"; readonly body: string }
  | { readonly _tag: "hang" }
  | { readonly _tag: "refuse"; readonly after: Promise<void> }
  | { readonly _tag: "fail"; readonly after: Promise<void> };

/** A skill the fake serves at `skill://<path>/SKILL.md`. */
export interface FakeSkill {
  /** Its folder, `/`-separated; its last segment is the skill's name. */
  readonly path: string;
  /** Its files by path from its folder, `SKILL.md` among them. */
  readonly files: Readonly<Record<string, string>>;
  /** Its entry lists no files: the server generates them (`"dynamic"`). */
  readonly dynamic?: boolean;
  /** Its entry as the server sends it, changed from what the SDK makes of its files. */
  readonly reshape?: (entry: Skill) => Readonly<Record<string, unknown>>;
}

export interface FakeSkills {
  /** What `skills/list` lists, in order. */
  readonly listed: ReadonlyArray<FakeSkill>;
  /** Served by `skills/get` and reads, never listed. */
  readonly unlisted?: ReadonlyArray<FakeSkill>;
  /** Lists this many to a page. */
  readonly pageSize?: number;
  /** Declares and serves `resources/directory/read`. */
  readonly directoryRead?: boolean;
}

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
  /** Changes one file of a skill, or removes it (`null`): what its entry says changes with it. */
  readonly setSkillFile: (path: string, file: string, text: string | null) => void;
  /** Serves `text` at `uri` from now on, whatever the skill's entry says. */
  readonly tamper: (uri: string, text: string) => void;
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
  /** Serves skills, and declares the Skills extension. */
  readonly skills?: FakeSkills;
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

/** A skill's entry from its files as they are now. */
const entryOf = async (skill: FakeSkill): Promise<Readonly<Record<string, unknown>>> => {
  const made = await skillEntry(skill.path, skill.files);
  const entry: Skill = skill.dynamic === true ? { ...made, resources: "dynamic" } : made;
  return skill.reshape?.(entry) ?? entry;
};

const fileUri = (skill: FakeSkill, file: string) => `skill://${skill.path}/${file}`;

export const fakeMcpServer = (options: FakeOptions) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly fake: FakeMcpServer; readonly server: NodeHttp.Server }>(
      (resume) => {
        let tools = options.tools;
        const skills = {
          listed: [...(options.skills?.listed ?? [])],
          unlisted: [...(options.skills?.unlisted ?? [])],
        };
        const tampered = new Map<string, string>();
        const allSkills = () => [...skills.listed, ...skills.unlisted];
        /** What the fake serves at `uri`: a skill's file, or the files right under one of its folders. */
        const servedAt = (uri: string) => {
          for (const skill of allSkills()) {
            for (const [file, text] of Object.entries(skill.files)) {
              if (fileUri(skill, file) === uri)
                return { _tag: "file", text: tampered.get(uri) ?? text } as const;
            }
            const root = `skill://${skill.path}`;
            if (uri !== root && !uri.startsWith(`${root}/`)) continue;
            const prefix = uri === root ? "" : `${uri.slice(root.length + 1)}/`;
            const children = new Map<string, boolean>();
            for (const file of Object.keys(skill.files)) {
              if (!file.startsWith(prefix)) continue;
              const [first, ...rest] = file.slice(prefix.length).split("/");
              if (first !== undefined)
                children.set(first, children.get(first) === true || rest.length > 0);
            }
            if (children.size > 0) return { _tag: "folder", children } as const;
          }
          return undefined;
        };
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
        const refuse = (
          response: NodeHttp.ServerResponse,
          id: string | number,
          error = { code: -32601, message: "Method not found" },
        ) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, error }));
        };
        const unknown = { code: -32602, message: "Unknown resource" };
        const answerSkills = async (
          response: NodeHttp.ServerResponse,
          id: string | number,
          method: string,
          params: { readonly cursor?: string; readonly uri?: string } | undefined,
        ) => {
          if (method === "skills/list") {
            const from = Number(params?.cursor ?? 0);
            const to = from + (options.skills?.pageSize ?? skills.listed.length);
            return reply(response, id, {
              skills: await Promise.all(skills.listed.slice(from, to).map(entryOf)),
              ...(to < skills.listed.length ? { nextCursor: String(to) } : {}),
            });
          }
          if (method === "skills/get") {
            const skill = allSkills().find((one) => fileUri(one, "SKILL.md") === params?.uri);
            return skill === undefined
              ? refuse(response, id, unknown)
              : reply(response, id, { skill: await entryOf(skill) });
          }
          const uri = params?.uri ?? "";
          const served = servedAt(uri);
          if (served?._tag !== "folder") return refuse(response, id, unknown);
          return reply(response, id, {
            resources: [...served.children].map(([name, folder]) => ({
              uri: `${uri}/${name}`,
              name,
              mimeType: folder ? "inode/directory" : "text/markdown",
            })),
          });
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
                    ...(options.resources === undefined && options.skills === undefined
                      ? {}
                      : { resources: {} }),
                    ...(options.skills === undefined
                      ? {}
                      : {
                          extensions: {
                            [SKILLS_EXTENSION_ID]:
                              options.skills.directoryRead === true ? { directoryRead: true } : {},
                          },
                        }),
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
                if (answer._tag === "fail") {
                  return void answer.after.then(() => {
                    response.writeHead(500);
                    response.end();
                  });
                }
                if (answer._tag === "raw") {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(answer.body);
                  return;
                }
                return reply(response, rpc.id, {
                  content: answer.text === null ? [] : [{ type: "text", text: answer.text }],
                  isError: answer.isError ?? false,
                  ...(answer.structuredContent === undefined
                    ? {}
                    : { structuredContent: answer.structuredContent }),
                });
              }
              case "skills/list":
              case "skills/get":
              case "resources/directory/read":
                if (
                  options.skills === undefined ||
                  (rpc.method === "resources/directory/read" &&
                    options.skills.directoryRead !== true)
                ) {
                  return refuse(response, rpc.id);
                }
                return void answerSkills(response, rpc.id, rpc.method, rpc.params);
              case "resources/read": {
                const skillFile = servedAt(rpc.params?.uri ?? "");
                if (skillFile?._tag === "file") {
                  return reply(response, rpc.id, {
                    contents: [
                      { uri: rpc.params?.uri, mimeType: "text/markdown", text: skillFile.text },
                    ],
                  });
                }
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
                setSkillFile: (path, file, text) => {
                  for (const list of [skills.listed, skills.unlisted]) {
                    const at = list.findIndex((skill) => skill.path === path);
                    const skill = list[at];
                    if (skill === undefined) continue;
                    const { [file]: _removed, ...others } = skill.files;
                    list[at] = {
                      ...skill,
                      files: text === null ? others : { ...others, [file]: text },
                    };
                  }
                },
                tamper: (uri, text) => {
                  tampered.set(uri, text);
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
