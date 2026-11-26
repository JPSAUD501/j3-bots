// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fromJsonSchema,
  inputRequired,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A fictional notes app's MCP server, built on the MCP SDK's own server so
 * it speaks each revision as a real one does: 2026-07-28 to a client that
 * asks for it, 2025-11-25 to one that does not, with the same handlers (the
 * SDK fulfils a request for input on the older revision by asking the
 * client itself).
 *
 * - tools: `echo` (gives back `text`), `confirm` (asks a form, a yes or
 *   no), `approve` (asks the operator to open a page), `count` (reports
 *   progress, then answers), and `long_job` (served as a task by the HTTP
 *   fake, `sdkHttpServer.ts`);
 * - resources: `note://readme`, the template `note://{id}`, and a
 *   `ui://notes/board` page for MCP Apps;
 * - prompts: `summarize`, which takes a `topic`.
 */

const Echo = Schema.Struct({ text: Schema.String });
const decodeEcho = Schema.decodeUnknownOption(Echo);
const Topic = Schema.Struct({ topic: Schema.String });
const decodeTopic = Schema.decodeUnknownOption(Topic);
const Answer = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeAnswer = Schema.decodeUnknownOption(Answer);

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** What the operator answered to the request `key`, once the client retried with it. */
const answered = (responses: Readonly<Record<string, unknown>> | undefined, key: string) =>
  decodeAnswer(responses?.[key]);

/** The page `approve` asks the operator to open. */
export const APPROVAL_URL = "https://approve.notes.example/flow/7";

export const notesServer = (): McpServer => {
  const server = new McpServer(
    { name: "Fake Notes", version: "1.4.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      },
      // Its tools hold for a minute, unless it says they changed.
      cacheHints: { "tools/list": { ttlMs: 60_000, cacheScope: "public" } },
    },
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Gives back the text it is given.",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    },
    (args) =>
      text(`echo: ${Option.match(decodeEcho(args), { onNone: () => "", onSome: (a) => a.text })}`),
  );

  server.registerTool(
    "confirm",
    { description: "Asks whether to go ahead, then says what was answered." },
    (ctx) => {
      const answer = answered(ctx.mcpReq.inputResponses, "confirm");
      if (Option.isNone(answer)) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: 'Delete the note "Groceries"?',
              requestedSchema: {
                type: "object",
                properties: {
                  proceed: { type: "boolean", title: "Go ahead" },
                  reason: { type: "string", title: "Why", maxLength: 100 },
                },
                required: ["proceed"],
              },
            }),
          },
        });
      }
      const { action, content } = answer.value;
      const said = {
        accept: `accepted: ${JSON.stringify(content ?? {})}`,
        decline: "declined",
        cancel: "cancelled",
      };
      return text(said[action]);
    },
  );

  server.registerTool(
    "approve",
    { description: "Asks the operator to approve on the notes app's own page." },
    (ctx) => {
      const answer = answered(ctx.mcpReq.inputResponses, "approve");
      if (Option.isNone(answer)) {
        return inputRequired({
          inputRequests: {
            approve: inputRequired.elicitUrl({
              message: "Approve access to your notes.",
              url: APPROVAL_URL,
            }),
          },
        });
      }
      return text(`${answer.value.action}`);
    },
  );

  server.registerTool(
    "count",
    { description: "Counts to two, saying how far it got." },
    async (ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      if (token !== undefined) {
        for (const progress of [1, 2]) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress, total: 2, message: `Counted ${progress}` },
          });
        }
      }
      return text("counted");
    },
  );

  server.registerTool("long_job", { description: "A job that takes a while." }, () =>
    text("done at once"),
  );

  server.registerResource(
    "readme",
    "note://readme",
    { title: "Read me", description: "How the notes are kept.", mimeType: "text/markdown" },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Notes\nKept by date." }],
    }),
  );

  server.registerResource(
    "note",
    new ResourceTemplate("note://{id}", { list: undefined }),
    { title: "A note", description: "One note, by its id." },
    (uri, variables) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: `Note ${String(variables["id"])}` },
      ],
    }),
  );

  server.registerResource(
    "board",
    "ui://notes/board",
    { title: "Board", mimeType: "text/html;profile=mcp-app" },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><title>Board</title><p>Notes</p>",
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );

  server.registerPrompt(
    "summarize",
    {
      title: "Summarize",
      description: "Summarizes the notes on a topic.",
      argsSchema: fromJsonSchema({
        type: "object",
        properties: { topic: { type: "string", description: "What to summarize" } },
        required: ["topic"],
      }),
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Summarize my notes about ${Option.match(decodeTopic(args), { onNone: () => "", onSome: (a) => a.topic })}.`,
          },
        },
      ],
    }),
  );

  return server;
};
