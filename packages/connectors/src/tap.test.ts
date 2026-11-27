// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { CALL_TAG } from "./tasks.ts";
import { tapTransport } from "./tap.ts";

/** A connected transport whose messages a test delivers, the SDK's handler recording what reaches it. */
const fakeTransport = (seen: Array<string>): Transport => ({
  start: () => Promise.resolve(),
  close: () => Promise.resolve(),
  send: () => Promise.resolve(),
  onmessage: (message: JSONRPCMessage) => {
    seen.push("method" in message ? `sdk: ${message.method}` : "sdk: answer");
  },
});

it("hands a tagged call its progress as it arrives, before the answer behind it, and never to the SDK", async () => {
  const seen: Array<string> = [];
  const transport = fakeTransport(seen);
  tapTransport(
    transport,
    () => ({}),
    (_tag, deliver) => deliver(),
    (step) => seen.push(`call: ${step.message ?? ""}`),
  );
  await transport.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "count", _meta: { [CALL_TAG]: "tag-1", progressToken: "tag-1" } },
  });

  // The last step and the answer arrive together, as in one read from a process's output.
  const progress = (n: number, token: string): JSONRPCMessage => ({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: token, progress: n, total: 2, message: `Counted ${n}` },
  });
  transport.onmessage?.(progress(1, "tag-1"));
  transport.onmessage?.(progress(2, "tag-1"));
  transport.onmessage?.({ jsonrpc: "2.0", id: 7, result: { content: [] } });
  // Progress for a token that is no call's tag is the SDK's.
  transport.onmessage?.(progress(1, "another"));

  assert.deepStrictEqual(seen, [
    "call: Counted 1",
    "call: Counted 2",
    "sdk: answer",
    "sdk: notifications/progress",
  ]);
});
