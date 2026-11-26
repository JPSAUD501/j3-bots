// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The SDK's transport speaks over the process's Node streams.
import type * as NodeStream from "node:stream";
import {
  deserializeMessage,
  type JSONRPCMessage,
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
 * output writes, is skipped. Each chunk is searched for a line's end only
 * where it is new, and a line joined once, so a long message costs its
 * length, not its length times its chunks. A message longer than `maxMessageBytes` ends
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

  /**
   * The process's id, and its standard error, which goes nowhere. Both mark
   * this as a transport over a process's streams, where the SDK takes a
   * server silent at `server/discover` for one that predates it.
   */
  readonly pid: number;
  readonly stderr: null = null;

  /** The connection ended because one message was longer than allowed. */
  tooLarge = false;
  /** The connection ended because the process left too much of its input unread. */
  stalled = false;

  readonly #input: NodeStream.Writable;
  readonly #output: NodeStream.Readable;
  /** What has come of the line not yet ended, and how many bytes it holds. */
  #partial: Array<Buffer> = [];
  #partialBytes = 0;
  readonly #maxMessageBytes: number;
  readonly #maxUnread: number;
  readonly #onBroken: () => void;
  #closed = false;

  constructor(
    pid: number,
    input: NodeStream.Writable,
    output: NodeStream.Readable,
    maxMessageBytes: number,
    onBroken: () => void,
  ) {
    this.pid = pid;
    this.#input = input;
    this.#output = output;
    this.#maxMessageBytes = maxMessageBytes;
    this.#maxUnread = maxMessageBytes;
    this.#onBroken = onBroken;
  }

  /** Ends the connection for the process's fault. */
  #break(): void {
    void this.close();
    this.#onBroken();
  }

  readonly #onData = (chunk: Buffer) => {
    let start = 0;
    while (!this.#closed) {
      const end = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      if (this.#partialBytes + piece.length > this.#maxMessageBytes) {
        this.tooLarge = true;
        this.#break();
        return;
      }
      if (end === -1) {
        if (piece.length > 0) {
          this.#partial.push(piece);
          this.#partialBytes += piece.length;
        }
        return;
      }
      const line = Buffer.concat([...this.#partial, piece])
        .toString("utf8")
        .replace(/\r$/u, "");
      this.#partial = [];
      this.#partialBytes = 0;
      start = end + 1;
      let message: JSONRPCMessage;
      try {
        message = deserializeMessage(line);
      } catch {
        // Not a message: skipped, and nothing of it kept.
        continue;
      }
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
    this.#partial = [];
    this.#partialBytes = 0;
    this.onclose?.();
    return Promise.resolve();
  }
}
