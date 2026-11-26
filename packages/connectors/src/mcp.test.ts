// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Where the fixture servers are is node:url's to say.
import * as NodeOs from "node:os";
import * as NodeUrl from "node:url";
import type { Elicitation, ElicitationAnswer } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import { InMemoryResponseCacheStore } from "@modelcontextprotocol/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { openCommandSession } from "./command/session.ts";
import type { ConnectorFailure } from "./errors.ts";
import type { UrlPolicy } from "./guard.ts";
import {
  type CallHooks,
  type CallProgress,
  DEFAULT_SESSION_LIMITS,
  type ListKind,
  type McpSession,
  openSession,
} from "./session.ts";
import { APPROVAL_URL } from "./testing/notesServer.ts";
import { type Revision, sdkHttpServer } from "./testing/sdkHttpServer.ts";
import { serverEnvironment, STDIO_SERVER } from "./testing/stdioFixture.ts";

/**
 * J3 Bots' MCP client against servers built on the MCP SDK's own server, at
 * 2026-07-28 and at 2025-11-25, over Streamable HTTP and over a process's
 * streams: which revision it speaks, what it lists, the requests for input
 * it puts to the operator, and calls run as tasks.
 */

const POLICY: UrlPolicy = {
  loopback: "allow-http",
  privateNetwork: "refuse",
  redirects: "recheck",
};
const NOTES_STDIO = NodeUrl.fileURLToPath(
  new URL("./testing/notesStdioServer.ts", import.meta.url),
);
const CLIENT = { name: "j3-bots-test", version: "0.0.0" };
const NO_CREDENTIALS = {
  current: Effect.succeed({ bearer: Option.none(), headers: [], hidden: [], carried: [] }),
  rejected: () => Effect.void,
};

const overHttp = (
  revision: Revision,
  onListChanged: (kind: ListKind) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const fake = yield* sdkHttpServer({ revision });
    const session = yield* openSession({
      url: new URL(fake.url),
      policy: POLICY,
      credentials: NO_CREDENTIALS,
      limits: DEFAULT_SESSION_LIMITS,
      client: CLIENT,
      cache: new InMemoryResponseCacheStore(),
      onListChanged,
    });
    return { fake, session };
  });

const overStdio = (file: string, args: ReadonlyArray<string> = []) =>
  openCommandSession({
    platform: process.platform,
    program: process.execPath,
    args: [file, ...args].map((arg) => Redacted.make(arg)),
    variables: [],
    hidden: [],
    carried: [],
    serverEnvironment,
    cwd: NodeOs.tmpdir(),
    limits: DEFAULT_SESSION_LIMITS,
    client: CLIENT,
    cache: new InMemoryResponseCacheStore(),
    onListChanged: () => Effect.void,
  }).pipe(Effect.map((command) => command.session));

/** Hooks that answer every request for input with `answer`, and keep what they were shown. */
const answering = (answer: ElicitationAnswer) => {
  const shown: Array<Elicitation> = [];
  const progress: Array<CallProgress> = [];
  const hooks: CallHooks = {
    progress: (step) => Effect.sync(() => void progress.push(step)),
    elicit: (elicitation) =>
      Effect.sync(() => {
        shown.push(elicitation);
        return answer;
      }),
  };
  return { shown, progress, hooks };
};

const textOf = (session: McpSession, name: string, hooks?: CallHooks) =>
  session
    .callTool({ name, arguments: {}, ...(hooks === undefined ? {} : { hooks }) })
    .pipe(Effect.map((answer) => answer.text));

const transports: ReadonlyArray<{
  readonly name: string;
  readonly revision: Revision;
  readonly open: Effect.Effect<McpSession, ConnectorFailure, Scope.Scope>;
}> = [
  {
    name: "HTTP at 2026-07-28",
    revision: "2026-07-28",
    open: overHttp("2026-07-28").pipe(Effect.map(({ session }) => session)),
  },
  {
    name: "HTTP at 2025-11-25",
    revision: "2025-11-25",
    open: overHttp("2025-11-25").pipe(Effect.map(({ session }) => session)),
  },
  { name: "stdio", revision: "2026-07-28", open: overStdio(NOTES_STDIO) },
];

describe("revision", () => {
  it.live("speaks 2026-07-28 to a server that answers server/discover, without initialize", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* overHttp("2026-07-28");
      assert.strictEqual(session.info.protocolVersion, "2026-07-28");
      assert.deepStrictEqual(session.info.offers, {
        tools: true,
        resources: true,
        prompts: true,
        tasks: false,
      });
      const methods = fake.requests.map((request) => request.method);
      assert.strictEqual(methods[0], "server/discover");
      assert.isFalse(methods.includes("initialize"));
    }).pipe(Effect.scoped),
  );

  it.live("falls back to initialize with a 2025-11-25 server over HTTP", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* overHttp("2025-11-25");
      assert.strictEqual(session.info.protocolVersion, "2025-11-25");
      const methods = fake.requests.map((request) => request.method);
      assert.deepStrictEqual(methods.slice(0, 2), ["server/discover", "initialize"]);
    }).pipe(Effect.scoped),
  );

  // Each process a test starts loads its SDK before it answers, which takes
  // seconds on a busy machine: a test here starts as few as what it proves.
  it.live(
    "falls back to initialize over a process's streams with a server that refuses server/discover",
    () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* overStdio(STDIO_SERVER)).info.protocolVersion, "2025-11-25");
      }).pipe(Effect.scoped),
  );

  it.live("starts again, with initialize, a server that ends at server/discover", () =>
    Effect.gen(function* () {
      const restarted = yield* overStdio(STDIO_SERVER, ["--exit-on-unknown"]);
      assert.strictEqual(restarted.info.protocolVersion, "2025-11-25");
      assert.match(yield* textOf(restarted, "whoami"), /^\d+$/);
    }).pipe(Effect.scoped),
  );
});

describe.each(transports)("over $name", ({ open, revision }) => {
  it.live(
    "speaks its revision, lists tools, resources and prompts, reads a resource and gets a prompt",
    () =>
      Effect.gen(function* () {
        const session = yield* open;
        assert.strictEqual(session.info.protocolVersion, revision);
        const tools = yield* session.listTools;
        assert.includeMembers(
          tools.map((tool) => tool.name),
          ["echo", "confirm", "approve", "count"],
        );
        const resources = yield* session.listResources;
        assert.deepStrictEqual(
          resources.map((resource) => [resource.kind, resource.uri]),
          [
            ["resource", "note://readme"],
            ["resource", "ui://notes/board"],
            ["template", "note://{id}"],
          ],
        );
        const prompts = yield* session.listPrompts;
        assert.deepStrictEqual(
          prompts.map((prompt) => [prompt.name, prompt.arguments.map((a) => [a.name, a.required])]),
          [["summarize", [["topic", true]]]],
        );

        const readme = yield* session.readResource({ uri: "note://readme" });
        assert.deepStrictEqual(
          readme.contents.map((item) => ("text" in item ? item.text : null)),
          ["# Notes\nKept by date."],
        );
        const board = yield* session.readResource({ uri: "ui://notes/board" });
        assert.deepStrictEqual(board.contents[0]?._meta, { ui: { prefersBorder: true } });

        const prompt = yield* session.getPrompt({
          name: "summarize",
          arguments: { topic: "travel" },
        });
        assert.deepStrictEqual(prompt.messages, [
          { role: "user", text: "Summarize my notes about travel." },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live("puts a form to the operator, and gives the server their answer", () =>
    Effect.gen(function* () {
      const session = yield* open;
      const accepted = answering({ _tag: "accept", content: { proceed: true, reason: "old" } });
      assert.strictEqual(
        yield* textOf(session, "confirm", accepted.hooks),
        'accepted: {"proceed":true,"reason":"old"}',
      );
      const [form] = accepted.shown;
      assert.strictEqual(form?._tag, "form");
      if (form?._tag === "form") {
        assert.strictEqual(form.message, 'Delete the note "Groceries"?');
        assert.deepStrictEqual(
          form.fields.map((field) => [field._tag, field.key, field.label, field.required]),
          [
            ["boolean", "proceed", "Go ahead", true],
            ["text", "reason", "Why", false],
          ],
        );
      }
      assert.strictEqual(
        yield* textOf(session, "confirm", answering({ _tag: "decline" }).hooks),
        "declined",
      );
      assert.strictEqual(
        yield* textOf(session, "confirm", answering({ _tag: "cancel" }).hooks),
        "cancelled",
      );
    }).pipe(Effect.scoped),
  );

  it.live("asks the operator to open a page, naming its host", () =>
    Effect.gen(function* () {
      const session = yield* open;
      const accepted = answering({ _tag: "accept", content: {} });
      assert.strictEqual(yield* textOf(session, "approve", accepted.hooks), "accept");
      assert.deepStrictEqual(accepted.shown, [
        {
          _tag: "url",
          message: "Approve access to your notes.",
          url: APPROVAL_URL,
          host: "approve.notes.example",
        },
      ]);
      assert.strictEqual(
        yield* textOf(session, "approve", answering({ _tag: "decline" }).hooks),
        "decline",
      );
    }).pipe(Effect.scoped),
  );

  it.live("declines a request for input no one can answer", () =>
    Effect.gen(function* () {
      const session = yield* open;
      assert.strictEqual(yield* textOf(session, "confirm"), "declined");
    }).pipe(Effect.scoped),
  );

  it.live("passes a call's progress on", () =>
    Effect.gen(function* () {
      const session = yield* open;
      const watched = answering({ _tag: "cancel" });
      assert.strictEqual(yield* textOf(session, "count", watched.hooks), "counted");
      // By the answer: the first step, and the last, which is never held back.
      assert.deepStrictEqual(watched.progress, [
        { message: "Counted 1", fraction: 0.5 },
        { message: "Counted 2", fraction: 1 },
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("list caching", () => {
  it.live(
    "serves tools from the cache while the server says they hold, and asks again once they change",
    () =>
      Effect.gen(function* () {
        const changed = yield* Deferred.make<void>();
        const { fake, session } = yield* overHttp("2026-07-28", (kind) =>
          kind === "tools" ? Deferred.succeed(changed, undefined) : Effect.void,
        );
        const listings = () =>
          fake.requests.filter((request) => request.method === "tools/list").length;
        yield* session.listTools;
        yield* session.listTools;
        assert.strictEqual(listings(), 1);
        // The client listens for changes once its first listing is done.
        yield* Effect.sleep("200 millis");
        fake.changed("tools");
        yield* Deferred.await(changed);
        yield* session.listTools;
        assert.strictEqual(listings(), 2);
      }).pipe(Effect.scoped),
  );
});

describe("tasks", () => {
  it.live(
    "follows a call run as a task: its status as progress, its question to the operator, its result",
    () =>
      Effect.gen(function* () {
        const { session } = yield* overHttp("2026-07-28");
        const watched = answering({ _tag: "accept", content: { keep: true } });
        const answer = yield* textOf(session, "long_job", watched.hooks);
        assert.strictEqual(
          answer,
          'job done: {"keep":{"action":"accept","content":{"keep":true}}}',
        );
        assert.strictEqual(watched.progress[0]?.message, "Starting");
        assert.strictEqual(watched.shown[0]?._tag, "form");
      }).pipe(Effect.scoped),
  );

  it.live("cancels the task at its server when the call is stopped", () =>
    Effect.gen(function* () {
      const fake = yield* sdkHttpServer({ revision: "2026-07-28", endless: true });
      const session = yield* openSession({
        url: new URL(fake.url),
        policy: POLICY,
        credentials: NO_CREDENTIALS,
        limits: DEFAULT_SESSION_LIMITS,
        client: CLIENT,
        cache: new InMemoryResponseCacheStore(),
        onListChanged: () => Effect.void,
      });
      const started = yield* Deferred.make<void>();
      const call = yield* Effect.forkChild(
        session.callTool({
          name: "long_job",
          arguments: {},
          hooks: {
            progress: (step) =>
              step.message?.startsWith("Step") === true
                ? Deferred.succeed(started, undefined)
                : Effect.void,
            elicit: () => Effect.succeed({ _tag: "cancel" }),
          },
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(call);
      assert.isTrue(fake.taskCancelled());
    }).pipe(Effect.scoped),
  );
});
