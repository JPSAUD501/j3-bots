// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { type CdpRelayTarget, createCdpRelayConnection, RELAY_PAGE_ONLY } from "./cdpRelay.ts";

const PAGE = "page-target";

/** A relay over a fake page whose debugger answers `send` with `reply`. */
const relayOf = (reply: (method: string) => unknown = () => ({})) => {
  const written: Array<unknown> = [];
  const sent: Array<{ readonly method: string; readonly sessionId: string | undefined }> = [];
  const acked: Array<number> = [];
  let closed = 0;
  const target: CdpRelayTarget = {
    send: async (method, _params, sessionId) => {
      sent.push({ method, sessionId });
      return reply(method);
    },
    receivesScreencast: () => true,
    ackScreencastFrame: (frameId) => {
      acked.push(frameId);
    },
    targetId: async () => PAGE,
    url: () => "https://example.test/",
    title: () => "Example",
    userAgent: () => "Mozilla/5.0 Test",
    setDownloadDirectory: () => undefined,
  };
  const relay = createCdpRelayConnection(
    target,
    (message) => {
      written.push(JSON.parse(message));
    },
    () => {
      closed += 1;
    },
  );
  let id = 0;
  /** Sends a command and waits until the relay has answered it. */
  const call = async (method: string, params: object = {}, sessionId?: string) => {
    const sentId = ++id;
    relay.receive(
      JSON.stringify({
        id: sentId,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    return written.find(
      (message) =>
        typeof message === "object" && message !== null && "id" in message && message.id === sentId,
    );
  };
  return { relay, call, written, sent, acked, closed: () => closed };
};

describe("createCdpRelayConnection", () => {
  it("announces the page as the browser's one target when Playwright auto-attaches", async () => {
    const { call, written } = relayOf();
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true });
    assert.deepInclude(written, {
      method: "Target.attachedToTarget",
      params: {
        sessionId: "j3-tab-page",
        targetInfo: {
          targetId: PAGE,
          type: "page",
          title: "Example",
          url: "https://example.test/",
          attached: true,
          canAccessOpener: false,
          browserContextId: "j3-tab",
        },
        waitingForDebugger: false,
      },
    });
  });

  it("refuses to attach to anything but its page", async () => {
    const { call } = relayOf();
    assert.deepStrictEqual(await call("Target.attachToTarget", { targetId: "another" }), {
      id: 1,
      error: { code: -32000, message: RELAY_PAGE_ONLY },
    });
    const attached = await call("Target.attachToTarget", { targetId: PAGE });
    assert.deepStrictEqual(attached, { id: 2, result: { sessionId: "j3-tab-page-1" } });
  });

  it("answers a message it cannot read as a command, so Playwright does not wait for it", async () => {
    const { relay, written } = relayOf();
    relay.receive(JSON.stringify({ id: 7, method: "Page.navigate", params: [] }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(written, [
      { id: 7, error: { code: -32600, message: "Not a CDP command." } },
    ]);
  });

  it("passes the page session's commands to the page's debugger", async () => {
    const { call, sent } = relayOf((method) =>
      method === "Runtime.evaluate" ? { result: 2 } : {},
    );
    await call("Target.setAutoAttach", { autoAttach: true });
    const answered = await call("Runtime.evaluate", { expression: "1 + 1" }, "j3-tab-page");
    assert.deepStrictEqual(answered, { id: 2, result: { result: 2 }, sessionId: "j3-tab-page" });
    assert.deepStrictEqual(sent, [{ method: "Runtime.evaluate", sessionId: undefined }]);
  });

  it("fails a reply too large to send, and only that command", async () => {
    const { call, closed } = relayOf(() => ({ data: "x".repeat(64 * 1024 * 1024) }));
    await call("Target.setAutoAttach", { autoAttach: true });
    const answered = await call("Page.captureScreenshot", {}, "j3-tab-page");
    assert.deepStrictEqual(answered, {
      id: 2,
      error: { code: -32000, message: "CDP payload too large" },
      sessionId: "j3-tab-page",
    });
    assert.strictEqual(closed(), 0);
  });

  it("reports the target detached for every page session when the page closes itself", async () => {
    const { relay, call, written, closed } = relayOf();
    await call("Target.setAutoAttach", { autoAttach: true });
    await call("Target.attachToTarget", { targetId: PAGE });
    relay.pageDestroyed(PAGE);
    const detached = written.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "Target.detachedFromTarget",
    );
    assert.deepStrictEqual(detached, [
      { method: "Target.detachedFromTarget", params: { sessionId: "j3-tab-page", targetId: PAGE } },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: "j3-tab-page-1", targetId: PAGE },
      },
    ]);
    assert.strictEqual(closed(), 1);
    // Nothing is sent once closed.
    const before = written.length;
    relay.event("Page.loadEventFired", {}, undefined);
    assert.strictEqual(written.length, before);
  });

  it("holds the page's screencast to one unacknowledged frame and keeps only the newest", async () => {
    const { relay, call, written, acked } = relayOf();
    await call("Target.setAutoAttach", { autoAttach: true });
    const frames = () =>
      written.flatMap((message) =>
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "Page.screencastFrame" &&
        "params" in message &&
        typeof message.params === "object" &&
        message.params !== null &&
        "sessionId" in message.params
          ? [message.params.sessionId]
          : [],
      );
    relay.event("Page.screencastFrame", { sessionId: 1, data: "" }, undefined);
    relay.event("Page.screencastFrame", { sessionId: 2, data: "" }, undefined);
    relay.event("Page.screencastFrame", { sessionId: 3, data: "" }, undefined);
    assert.deepStrictEqual(frames(), [1]);
    // The first went out, so Chromium may paint on; the others wait unacknowledged.
    assert.deepStrictEqual(acked, [1]);
    await call("Page.screencastFrameAck", { sessionId: 1 }, "j3-tab-page");
    assert.deepStrictEqual(frames(), [1, 3]);
    assert.deepStrictEqual(acked, [1, 2]);
  });

  it("starts a new screencast free of the frame an old one left unacknowledged", async () => {
    const { relay, call, written, acked } = relayOf();
    await call("Target.setAutoAttach", { autoAttach: true });
    const frames = () => written.filter((message) => isMethod(message, "Page.screencastFrame"));
    await call("Page.startScreencast", {}, "j3-tab-page");
    relay.event("Page.screencastFrame", { sessionId: 1, data: "" }, undefined);
    relay.event("Page.screencastFrame", { sessionId: 1, data: "" }, undefined);
    assert.deepStrictEqual(acked, [1]);
    // Its watcher goes away with the first frame unacknowledged and the second held.
    await call("Page.stopScreencast", {}, "j3-tab-page");
    assert.deepStrictEqual(acked, [1, 1]);
    // Chromium numbers a new run's frames afresh; the first is the new watcher's.
    await call("Page.startScreencast", {}, "j3-tab-page");
    relay.event("Page.screencastFrame", { sessionId: 2, data: "" }, undefined);
    assert.strictEqual(frames().length, 2);
    assert.deepStrictEqual(acked, [1, 1, 2]);
  });
});

const isMethod = (message: unknown, method: string) =>
  typeof message === "object" &&
  message !== null &&
  "method" in message &&
  message.method === method;
