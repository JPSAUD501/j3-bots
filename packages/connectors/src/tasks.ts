// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import * as Schema from "effect/Schema";

/**
 * MCP's Tasks extension (`io.modelcontextprotocol/tasks`, on 2026-07-28): a
 * server may answer a `tools/call` with a task it keeps running, which the
 * client polls with `tasks/get`, answers with `tasks/update` when it needs
 * input, and stops with `tasks/cancel`.
 *
 * The SDK J3 Bots uses declares the extension but neither reads a task
 * result (it rejects the call as of a result type it does not know) nor
 * sends `tasks/*` on a 2026-07-28 connection. So a session's transport is
 * tapped: the tap keeps the task a tagged call was answered with, and sends
 * the extension's requests itself, framed as the SDK frames each request on
 * that connection.
 */

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** The `_meta` key a call is tagged with, so its answer can be told from others'. */
export const CALL_TAG = "j3-bots/call";

const TaskStatus = Schema.Literals([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);
type TaskStatus = typeof TaskStatus.Type;

/** A task as the server first answered with it, or as `tasks/get` gives it now. */
export const Task = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: TaskStatus,
  statusMessage: Schema.optionalKey(Schema.String),
  /** How long the server keeps the task after it was created, in milliseconds; null for no bound. */
  ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  pollIntervalMs: Schema.optionalKey(Schema.Finite),
});
export type Task = typeof Task.Type;

const CreatedTask = Schema.Struct({ ...Task.fields, resultType: Schema.Literal("task") });
const decodeCreated = Schema.decodeUnknownOption(CreatedTask);

/** What a server asks for while a task waits on input: requests keyed by the name its answers go back under. */
const InputRequests = Schema.Record(
  Schema.String,
  Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) }),
);

/** A task as `tasks/get` details it: with its input requests, its result, or its error. */
export const DetailedTask = Schema.Struct({
  ...Task.fields,
  inputRequests: Schema.optionalKey(InputRequests),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int, message: Schema.String })),
});
export type DetailedTask = typeof DetailedTask.Type;

/** A request of the tap's the server answered with a JSON-RPC error. */
export class RawRequestError extends Schema.TaggedError<RawRequestError>()("RawRequestError", {
  code: Schema.Int,
}) {}

/** The connection closed with a request of the tap's still waiting. */
export class RawRequestClosed extends Schema.TaggedError<RawRequestClosed>()(
  "RawRequestClosed",
  {},
) {}

interface Waiting {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The requests a call is tagged on: those a server may answer with a task or with a request for input. */
const TAGGED = new Set(["tools/call", "resources/read", "prompts/get"]);

/** The reserved `_meta` keys of 2026-07-28's per-request envelope. */
const ENVELOPE_PREFIX = "io.modelcontextprotocol/";

/**
 * What a tapped transport sees: the tagged calls it sent, the tasks they
 * were answered with, and the extension's requests it sends.
 */
export class TaskTap {
  readonly #send: (message: JSONRPCMessage) => Promise<void>;
  /** Tagged calls by their request id. */
  readonly #calls = new Map<string | number, string>();
  /** The task each tagged call was answered with, by tag. */
  readonly #tasks = new Map<string, Task>();
  readonly #waiting = new Map<string, Waiting>();
  #envelope: Readonly<Record<string, unknown>> = {};
  #next = 0;

  constructor(send: (message: JSONRPCMessage) => Promise<void>) {
    this.#send = send;
  }

  /** Notes an outgoing message: the envelope the SDK framed it with, and its tag when it is a tagged call. */
  outgoing(message: JSONRPCMessage): void {
    if (!("method" in message) || !("id" in message)) return;
    const meta = isObject(message.params) ? message.params["_meta"] : undefined;
    if (!isObject(meta)) return;
    const envelope = Object.fromEntries(
      Object.entries(meta).filter(([key]) => key.startsWith(ENVELOPE_PREFIX)),
    );
    if (Object.keys(envelope).length > 0) this.#envelope = envelope;
    const tag = meta[CALL_TAG];
    if (TAGGED.has(message.method) && typeof tag === "string") this.#calls.set(message.id, tag);
  }

  /**
   * Looks at an incoming message: `own` when it answers one of the tap's own
   * requests, which it takes; else the tag of the call it answers, if
   * tagged, after noting the task the call was answered with.
   */
  incoming(
    message: JSONRPCMessage,
  ): { readonly own: true } | { readonly own: false; readonly tag: string | undefined } {
    if (!("id" in message) || "method" in message || message.id === undefined) {
      return { own: false, tag: undefined };
    }
    const own = typeof message.id === "string" ? this.#waiting.get(message.id) : undefined;
    if (own !== undefined) {
      this.#waiting.delete(String(message.id));
      if ("error" in message) own.reject(new RawRequestError({ code: message.error.code }));
      else own.resolve(message.result);
      return { own: true };
    }
    const tag = this.#calls.get(message.id);
    if (tag === undefined) return { own: false, tag: undefined };
    this.#calls.delete(message.id);
    if ("result" in message) {
      const task = decodeCreated(message.result);
      if (task._tag === "Some") {
        const { resultType: _, ...rest } = task.value;
        this.#tasks.set(tag, rest);
      }
    }
    return { own: false, tag };
  }

  /** The task the call tagged `tag` was answered with, once: undefined when it was answered otherwise. */
  taken(tag: string): Task | undefined {
    const task = this.#tasks.get(tag);
    this.#tasks.delete(tag);
    return task;
  }

  /** Forgets a tagged call that ended without an answer. */
  forget(tag: string): void {
    for (const [id, own] of this.#calls) if (own === tag) this.#calls.delete(id);
    this.#tasks.delete(tag);
  }

  /** The connection closed: every request still waiting fails. */
  closed(): void {
    for (const waiting of this.#waiting.values()) waiting.reject(new RawRequestClosed());
    this.#waiting.clear();
  }

  /** Sends one of the extension's requests, framed as the connection's requests are; aborting stops the wait. */
  request(
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = `j3-${++this.#next}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiting.delete(id);
        reject(signal.reason instanceof Error ? signal.reason : new RawRequestClosed());
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.#waiting.set(id, {
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.#send({
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: { ...this.#envelope } },
      }).catch((error: unknown) => {
        this.#waiting.get(id)?.reject(error instanceof Error ? error : new RawRequestClosed());
        this.#waiting.delete(id);
      });
    });
  }
}

/**
 * Taps a connected transport: every message it sends is shown to the tap
 * first, and every one it receives too, which takes those it owns. An answer
 * to a tagged call is handed on inside `enter(tag)`, so whatever the SDK does
 * with it (a request for input it fulfils) runs as part of that call. Done
 * once the client is connected, when the SDK has set the handlers it keeps.
 */
export const tapTransport = (
  transport: Transport,
  enter: (tag: string, deliver: () => void) => void,
): TaskTap => {
  const send = transport.send.bind(transport);
  const tap = new TaskTap((message) => send(message));
  transport.send = (message, options) => {
    tap.outgoing(message);
    return send(message, options);
  };
  const received = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const seen = tap.incoming(message);
    if (seen.own) return;
    if (seen.tag === undefined) received?.(message, extra);
    else enter(seen.tag, () => received?.(message, extra));
  };
  const closed = transport.onclose;
  transport.onclose = () => {
    tap.closed();
    closed?.();
  };
  return tap;
};
