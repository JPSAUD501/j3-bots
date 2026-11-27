// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type JSONRPCMessage,
  SUBSCRIPTION_ID_META_KEY,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import * as Schema from "effect/Schema";
import { CALL_TAG, type Task, decodeCreatedTask } from "./tasks.ts";

/**
 * A session's transport, tapped: MCP's extensions J3 Bots speaks that the SDK
 * it uses does not yet, Tasks (`tasks.ts`) and Events (`events.ts`), are
 * spoken here, beside the SDK, on the same connection. The tap keeps the task
 * a tagged call was answered with, sends the extensions' requests itself,
 * framed as the SDK frames each request on that connection, and routes an
 * event stream's notifications to the stream they belong to, never to the
 * SDK. Once the SDK speaks them, this goes.
 */

/** How far a tagged call has come, as a `notifications/progress` for the call's tag says. */
const ProgressStep = Schema.Struct({
  progressToken: Schema.String,
  progress: Schema.Finite,
  total: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
});
export type ProgressStep = typeof ProgressStep.Type;
const decodeProgress = Schema.decodeUnknownOption(ProgressStep);

/** A request of the tap's the server answered with a JSON-RPC error: its code, and its `data` as sent. */
export class RawRequestError extends Schema.TaggedError<RawRequestError>()("RawRequestError", {
  code: Schema.Int,
  data: Schema.optionalKey(Schema.Unknown),
}) {}

/** The connection closed with a request of the tap's still waiting. */
export class RawRequestClosed extends Schema.TaggedError<RawRequestClosed>()(
  "RawRequestClosed",
  {},
) {}

/** The requests the tap sends for the extensions, which wait for one answer. */
export type RawMethod =
  | "tasks/get"
  | "tasks/update"
  | "tasks/cancel"
  | "events/list"
  | "events/poll"
  | "events/subscribe"
  | "events/unsubscribe";

/**
 * How a stream the client ends is told to stop: over HTTP by aborting its
 * request (`abort`), over a process's streams by `notifications/cancelled`
 * (`notify`), as there is no request of its own to abort.
 */
export type StreamCancel = "abort" | "notify";

interface Waiting {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The requests a call is tagged on: those a server may answer with a task or with a request for input. */
const TAGGED = new Set(["tools/call", "resources/read", "prompts/get"]);

/** The notifications of an event stream: each names its stream in `_meta`. */
const EVENT_NOTIFICATION_PREFIX = "notifications/events/";

/**
 * What a tapped transport sees: the tagged calls it sent, the tasks they
 * were answered with, the extensions' requests it sends, and the event
 * streams it holds open.
 */
export class ExtensionTap {
  readonly #send: (message: JSONRPCMessage, options?: TransportSendOptions) => Promise<void>;
  /** Tagged calls by their request id. */
  readonly #calls = new Map<string | number, string>();
  /** The task each tagged call was answered with, by tag. */
  readonly #tasks = new Map<string, Task>();
  readonly #waiting = new Map<string, Waiting>();
  /** Where each open event stream's notifications go, by its request id. */
  readonly #streams = new Map<string, (method: string, params: unknown) => void>();
  /** The per-request `_meta` envelope the SDK frames its own requests with now. */
  readonly #envelope: () => Readonly<Record<string, unknown>>;
  #next = 0;

  constructor(
    send: (message: JSONRPCMessage, options?: TransportSendOptions) => Promise<void>,
    envelope: () => Readonly<Record<string, unknown>>,
  ) {
    this.#send = send;
    this.#envelope = envelope;
  }

  /** Notes an outgoing message: its tag when it is a tagged call. */
  outgoing(message: JSONRPCMessage): void {
    if (!("method" in message) || !("id" in message)) return;
    const meta = isObject(message.params) ? message.params["_meta"] : undefined;
    if (!isObject(meta)) return;
    const tag = meta[CALL_TAG];
    if (TAGGED.has(message.method) && typeof tag === "string") this.#calls.set(message.id, tag);
  }

  /**
   * Looks at an incoming message: `own` when it is the tap's (an answer to
   * one of its requests, or a notification of an event stream), which it
   * takes; else the tag of the call it answers, if tagged, after noting the
   * task the call was answered with.
   */
  incoming(
    message: JSONRPCMessage,
  ): { readonly own: true } | { readonly own: false; readonly tag: string | undefined } {
    if ("method" in message && !("id" in message)) {
      if (!message.method.startsWith(EVENT_NOTIFICATION_PREFIX))
        return { own: false, tag: undefined };
      const meta = isObject(message.params) ? message.params["_meta"] : undefined;
      const id = isObject(meta) ? meta[SUBSCRIPTION_ID_META_KEY] : undefined;
      // One for no stream of the tap's is a stream it ended, or none: dropped.
      if (typeof id === "string") this.#streams.get(id)?.(message.method, message.params);
      return { own: true };
    }
    if (!("id" in message) || "method" in message || message.id === undefined) {
      return { own: false, tag: undefined };
    }
    const own = typeof message.id === "string" ? this.#waiting.get(message.id) : undefined;
    if (own !== undefined) {
      this.#waiting.delete(String(message.id));
      if ("error" in message) {
        own.reject(
          new RawRequestError({
            code: message.error.code,
            ...(message.error.data === undefined ? {} : { data: message.error.data }),
          }),
        );
      } else own.resolve(message.result);
      return { own: true };
    }
    const tag = this.#calls.get(message.id);
    if (tag === undefined) return { own: false, tag: undefined };
    this.#calls.delete(message.id);
    if ("result" in message) {
      const task = decodeCreatedTask(message.result);
      if (task._tag === "Some") {
        const { resultType: _, ...rest } = task.value;
        this.#tasks.set(tag, rest);
      }
    }
    return { own: false, tag };
  }

  /**
   * The progress of a tagged call still waiting for its answer, when the
   * message is a `notifications/progress` whose token is the call's tag.
   * Seen here, it reaches the call in the order it arrived, before the
   * answer that follows it: the SDK runs a notification's handler a step
   * later than it settles an answer, and drops progress for a call answered
   * meanwhile.
   */
  progressOf(message: JSONRPCMessage): ProgressStep | undefined {
    if (!("method" in message) || "id" in message || message.method !== "notifications/progress") {
      return undefined;
    }
    const step = decodeProgress(message.params);
    if (step._tag === "None") return undefined;
    for (const tag of this.#calls.values()) if (tag === step.value.progressToken) return step.value;
    return undefined;
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

  /** The connection closed: every request still waiting fails, and every stream ends. */
  closed(): void {
    for (const waiting of this.#waiting.values()) waiting.reject(new RawRequestClosed());
    this.#waiting.clear();
    this.#streams.clear();
  }

  /**
   * Sends one of the extensions' requests, framed as the connection's
   * requests are, with `headers` added on HTTP; aborting stops the wait.
   */
  request(
    method: RawMethod,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return this.#open(method, params, signal, { headers });
  }

  /**
   * Opens an event stream (`events/stream`): each of its notifications goes
   * to `notified` as it arrives, until the server ends it, which settles the
   * promise. Aborting ends it as `cancel` says, and rejects.
   */
  stream(
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    notified: (method: string, params: unknown) => void,
    cancel: StreamCancel,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const id = this.#nextId();
    this.#streams.set(id, notified);
    const cancelled = () =>
      void this.#send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id },
      }).catch(() => undefined);
    if (cancel === "notify") signal.addEventListener("abort", cancelled, { once: true });
    const ended = () => {
      this.#streams.delete(id);
      signal.removeEventListener("abort", cancelled);
    };
    return this.#open("events/stream", params, signal, {
      headers,
      id,
      // Over HTTP the request's own POST carries the stream: aborting it is the cancel.
      ...(cancel === "abort" ? { requestSignal: signal } : {}),
    }).then(
      () => void ended(),
      (error: unknown) => {
        ended();
        throw error;
      },
    );
  }

  #nextId(): string {
    return `j3-${++this.#next}`;
  }

  #open(
    method: RawMethod | "events/stream",
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    options: {
      readonly headers: Readonly<Record<string, string>>;
      readonly id?: string;
      readonly requestSignal?: AbortSignal;
    },
  ): Promise<unknown> {
    const id = options.id ?? this.#nextId();
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
      this.#send(
        { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...this.#envelope() } } },
        {
          ...(Object.keys(options.headers).length === 0 ? {} : { headers: { ...options.headers } }),
          ...(options.requestSignal === undefined ? {} : { requestSignal: options.requestSignal }),
        },
      ).catch((error: unknown) => {
        this.#waiting.get(id)?.reject(error instanceof Error ? error : new RawRequestClosed());
        this.#waiting.delete(id);
      });
    });
  }
}

/**
 * Taps a connected transport: every message it sends is shown to the tap
 * first, and every one it receives too, which takes those it owns. A tagged
 * call's progress goes to `progress` as it arrives, never to the SDK. An
 * answer to a tagged call is handed on inside `enter(tag)`, so whatever the
 * SDK does with it (a request for input it fulfils) runs as part of that
 * call. Done once the client is connected, when the SDK has set the
 * handlers it keeps.
 */
export const tapTransport = (
  transport: Transport,
  envelope: () => Readonly<Record<string, unknown>>,
  enter: (tag: string, deliver: () => void) => void,
  progress: (step: ProgressStep) => void,
): ExtensionTap => {
  const send = transport.send.bind(transport);
  const tap = new ExtensionTap((message, options) => send(message, options), envelope);
  transport.send = (message, options) => {
    tap.outgoing(message);
    return send(message, options);
  };
  const received = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const step = tap.progressOf(message);
    if (step !== undefined) return progress(step);
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
