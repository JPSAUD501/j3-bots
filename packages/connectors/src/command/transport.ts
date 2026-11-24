// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The SDK's transport speaks over the process's Node streams.
import type * as NodeStream from "node:stream";
import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/client";

/**
 * MCP over a process's standard streams, as the stdio transport frames it:
 * one JSON-RPC message per line. The SDK's own stdio transport starts the
 * process itself, with an environment and a stop of its own; this one speaks
 * over a process `startProcess` started, which owns both.
 *
 * A line that is not a JSON-RPC message, as a server that logs to its
 * output writes, is skipped. A message longer than `maxMessageBytes` ends
 * the connection: every request waiting on it fails. So does a process that
 * would leave more than `maxMessageBytes` of what was sent it unread, rather
 * than the server holding all it sends. Either is the process's fault, and
 * `onBroken` hears of it, so the process is stopped whether or not a request
 * was waiting.
 */
export class ProcessTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined;

  /** The connection ended because one message was longer than allowed. */
  tooLarge = false;
  /** The connection ended because the process left too much of its input unread. */
  stalled = false;

  readonly #input: NodeStream.Writable;
  readonly #output: NodeStream.Readable;
  readonly #buffer: ReadBuffer;
  readonly #maxUnread: number;
  readonly #onBroken: () => void;
  #closed = false;

  constructor(
    input: NodeStream.Writable,
    output: NodeStream.Readable,
    maxMessageBytes: number,
    onBroken: () => void,
  ) {
    this.#input = input;
    this.#output = output;
    this.#buffer = new ReadBuffer({ maxBufferSize: maxMessageBytes });
    this.#maxUnread = maxMessageBytes;
    this.#onBroken = onBroken;
  }

  /** Ends the connection for the process's fault. */
  #break(): void {
    void this.close();
    this.#onBroken();
  }

  readonly #onData = (chunk: Buffer) => {
    try {
      this.#buffer.append(chunk);
    } catch {
      this.tooLarge = true;
      this.#break();
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#buffer.readMessage();
      } catch {
        // Not a message: skipped, and nothing of it kept.
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  };

  readonly #onEnd = () => {
    void this.close();
  };

  start(): Promise<void> {
    this.#output.on("data", this.#onData);
    this.#output.once("end", this.#onEnd);
    this.#output.once("close", this.#onEnd);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("The process's input is closed."));
    const line = serializeMessage(message);
    if (this.#input.writableLength + Buffer.byteLength(line, "utf8") > this.#maxUnread) {
      this.stalled = true;
      this.#break();
      return Promise.reject(new Error("The process is not reading its input."));
    }
    return new Promise((resolve, reject) => {
      this.#input.write(line, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new Error("The process's input is closed."));
      });
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#output.off("data", this.#onData);
    this.#output.off("end", this.#onEnd);
    this.#output.off("close", this.#onEnd);
    this.#buffer.clear();
    this.onclose?.();
    return Promise.resolve();
  }
}
