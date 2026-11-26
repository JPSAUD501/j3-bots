// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  CONNECTOR_APP_FRAME_POLICY,
  type ConnectorAppAnswer,
  type ConnectorAppView,
  ConnectorAppViewId,
  ConnectorId,
  MAX_CONNECTOR_APP_HEIGHT,
} from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as Schema from "effect/Schema";
import {
  CONNECTOR_APP_FRAME_SANDBOX,
  type ConnectorAppAsk,
  type ConnectorAppHostOptions,
  type ConnectorAppPlace,
  type HostMessage,
  connectorAppDocument,
  connectorAppHost,
  connectorAppShell,
  fromOwnFrame,
} from "./connectorApp.ts";

const view: ConnectorAppView = {
  viewId: ConnectorAppViewId.make("app_0123456789abcdef"),
  botId: BotId.make("ana"),
  connectorId: ConnectorId.make("conn_wheelhouse0000000"),
  connector: "Wheelhouse",
  tool: {
    name: "stock",
    title: "Stock",
    description: "What the shop has.",
    inputSchema: { type: "object" },
  },
  html: "<p>Ridge 7</p>",
  csp: {
    connectDomains: ["https://api.wheelhouse.example"],
    resourceDomains: [],
    baseUriDomains: [],
  },
  input: { model: "Ridge 7" },
  result: { content: [{ type: "text", text: "2 in stock" }] },
};

const SERVER = new URL("https://bots.example.com");

const place: ConnectorAppPlace = {
  appearance: "dark",
  locale: "pt-BR",
  timeZone: "America/Sao_Paulo",
  platform: "web",
  touch: false,
  hover: true,
  width: 480,
};

/** A host over `view` with `changes`, recording what it sends the app and what it asks of the client. */
const hosted = (
  overrides: Partial<ConnectorAppHostOptions> = {},
  changes: Partial<ConnectorAppView> = {},
) => {
  const sent: Array<HostMessage> = [];
  const waiting = new Map<HostMessage["id"], () => void>();
  const calls: Array<{
    readonly name: string;
    readonly args: Schema.JsonObject;
    readonly allowed: boolean;
  }> = [];
  const asked: Array<string> = [];
  const heights: Array<number> = [];
  const answer: ConnectorAppAnswer = { _tag: "answer", result: { content: [] } };
  const host = connectorAppHost({
    view: { ...view, ...changes },
    place,
    send: (message) => {
      sent.push(message);
      if (!("method" in message)) waiting.get(message.id)?.();
    },
    callTool: (name, args, allowed) => {
      calls.push({ name, args, allowed });
      return Promise.resolve(answer);
    },
    readResource: () => Promise.resolve(answer),
    confirmCall: (tool) => {
      asked.push(tool);
      return Promise.resolve<ConnectorAppAsk>("allowed");
    },
    proposeMessage: () => Promise.resolve(false),
    openLink: () => Promise.resolve(false),
    onHeight: (height) => heights.push(height),
    ...overrides,
  });
  /** Once the host answered each of `ids`. */
  const answered = (...ids: ReadonlyArray<number>) =>
    Promise.all(
      ids.map((id) =>
        answerTo(sent, id) === undefined
          ? new Promise<void>((resolve) => waiting.set(id, resolve))
          : Promise.resolve(),
      ),
    );
  return { host, sent, calls, asked, heights, answered };
};

const request = (id: number, method: string, params: Schema.JsonObject = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const notification = (method: string, params: Schema.JsonObject = {}) => ({
  jsonrpc: "2.0",
  method,
  params,
});

/** The answer to request `id`, among what the host sent. */
const answerTo = (sent: ReadonlyArray<HostMessage>, id: number) =>
  sent.find((message) => "id" in message && message.id === id && !("method" in message));

describe("an app's document", () => {
  it("runs under its declared policy and the guard, before any of its own markup", () => {
    const document = connectorAppDocument(view, SERVER);
    assert.isNotNull(document);
    const policy =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
      "font-src data:; media-src data: blob:; connect-src https://api.wheelhouse.example; " +
      "frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
    assert.isTrue(
      document?.startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">`,
      ),
    );
    assert.isTrue(document?.endsWith(view.html));
  });

  it("is not drawn when its markup embeds another document", () => {
    assert.isNull(connectorAppDocument({ ...view, html: "<object data=x></object>" }, SERVER));
  });

  it("never reaches the J3 Bots server the client speaks to, whatever its server declared", () => {
    const document = connectorAppDocument(
      {
        ...view,
        csp: {
          connectDomains: [
            "https://bots.example.com",
            "wss://bots.example.com:8443",
            "https://*.example.com",
            "https://example.com",
            "https://api.wheelhouse.example",
          ],
          resourceDomains: ["https://*.example.com"],
          baseUriDomains: ["https://bots.example.com"],
        },
      },
      SERVER,
    );
    assert.include(document, "connect-src https://example.com https://api.wheelhouse.example;");
    assert.include(document, "script-src 'unsafe-inline';");
    assert.include(document, "base-uri 'none';");
    // An address may name the host with the root's trailing dot.
    const dotted = connectorAppDocument(
      {
        ...view,
        csp: {
          connectDomains: ["https://bots.example.com"],
          resourceDomains: [],
          baseUriDomains: [],
        },
      },
      new URL("https://bots.example.com./"),
    );
    assert.include(dotted, "connect-src 'none';");
  });

  it("runs in a frame with scripts and forms only, never the client's origin, framed by the client alone", () => {
    assert.strictEqual(CONNECTOR_APP_FRAME_SANDBOX, "allow-scripts allow-forms");
    assert.include(CONNECTOR_APP_FRAME_POLICY, "; sandbox allow-scripts allow-forms;");
    assert.include(CONNECTOR_APP_FRAME_POLICY, "frame-ancestors 'self'");
    assert.notInclude(CONNECTOR_APP_FRAME_POLICY, "'self' ");
    assert.notInclude(CONNECTOR_APP_FRAME_POLICY, "allow-same-origin");
    // Android's shell sandboxes the app's frame the same way.
    assert.include(connectorAppShell("<p>x</p>"), `sandbox="${CONNECTOR_APP_FRAME_SANDBOX}"`);
  });
});

describe("fromOwnFrame", () => {
  it("takes a message only from the app's own frame", () => {
    const frame = {};
    assert.isTrue(fromOwnFrame({ source: frame }, frame));
    assert.isFalse(fromOwnFrame({ source: {} }, frame));
    assert.isFalse(fromOwnFrame({ source: null }, frame));
    assert.isFalse(fromOwnFrame({ source: frame }, null));
  });
});

describe("connectorAppHost", () => {
  it("answers initialize with where the app is drawn, and sends the call only once it is ready", async () => {
    const { host, sent } = hosted();
    host.receive(request(1, "ui/initialize", { protocolVersion: "2026-01-26" }));
    assert.deepNestedInclude(answerTo(sent, 1), {
      "result.protocolVersion": "2026-01-26",
      "result.hostContext.theme": "dark",
      "result.hostContext.locale": "pt-BR",
      "result.hostContext.displayMode": "inline",
      "result.hostContext.containerDimensions": { width: 480, maxHeight: MAX_CONNECTOR_APP_HEIGHT },
      "result.hostContext.toolInfo.tool.name": "stock",
      "result.hostCapabilities.sandbox.permissions": {},
      "result.hostCapabilities.sandbox.csp.frameDomains": [],
    });
    // Nothing but the answer before the app says it is ready.
    assert.strictEqual(sent.length, 1);
    host.placeChanged({ ...place, appearance: "light" });
    assert.strictEqual(sent.length, 1);

    host.receive(notification("ui/notifications/initialized"));
    assert.deepStrictEqual(
      sent.slice(1).map((message) => ("method" in message ? message.method : null)),
      ["ui/notifications/tool-input", "ui/notifications/tool-result"],
    );
    host.placeChanged({ ...place, width: 300 });
    assert.deepNestedInclude(sent.at(-1), {
      method: "ui/notifications/host-context-changed",
      "params.containerDimensions.width": 300,
    });
  });

  it("says the call was cancelled when J3 Bots kept no answer for the app", () => {
    const { host, sent } = hosted({}, { result: null });
    host.receive(notification("ui/notifications/initialized"));
    assert.deepStrictEqual(
      sent.map((message) => ("method" in message ? message.method : null)),
      ["ui/notifications/tool-input", "ui/notifications/tool-cancelled"],
    );
  });

  it("asks the operator once per tool the server says needs it, and makes none they decline", async () => {
    let decision: ConnectorAppAsk = "declined";
    const { host, sent, calls, asked, answered } = hosted({
      callTool: (name, args, allowed) => {
        calls.push({ name, args, allowed });
        return Promise.resolve<ConnectorAppAnswer>(
          allowed
            ? { _tag: "answer", result: { content: [] } }
            : { _tag: "refused", reason: "needs-allow" },
        );
      },
      confirmCall: (tool) => {
        asked.push(tool);
        return Promise.resolve(decision);
      },
    });
    host.receive(request(1, "tools/call", { name: "hold", arguments: { model: "Ridge 7" } }));
    await answered(1);
    assert.deepStrictEqual(
      calls.map((call) => call.allowed),
      [false],
    );
    assert.deepInclude(answerTo(sent, 1), {
      error: { code: -32000, message: "The operator did not allow this call." },
    });

    decision = "allowed";
    host.receive(request(2, "tools/call", { name: "hold", arguments: {} }));
    host.receive(request(3, "tools/call", { name: "hold", arguments: {} }));
    await answered(2, 3);
    assert.deepStrictEqual(asked, ["hold", "hold"]);
    assert.deepStrictEqual(
      calls.map((call) => call.allowed),
      [false, false, false, true, true],
    );
    assert.deepNestedInclude(answerTo(sent, 3), { "result.content": [] });
  });

  it("tells the app why a call was refused", async () => {
    const refused: ConnectorAppAnswer = { _tag: "refused", reason: "not-for-apps" };
    const { host, sent, asked, answered } = hosted({ callTool: () => Promise.resolve(refused) });
    host.receive(request(1, "tools/call", { name: "refund" }));
    await answered(1);
    assert.deepStrictEqual(asked, []);
    assert.deepInclude(answerTo(sent, 1), {
      error: { code: -32000, message: "The connector does not let apps call that tool." },
    });
  });

  it("asks only while the bot's mode asks, as it is at each call", async () => {
    let supervised = false;
    const { host, sent, calls, asked, answered } = hosted({
      callTool: (name, args, allowed) => {
        calls.push({ name, args, allowed });
        return Promise.resolve<ConnectorAppAnswer>(
          supervised && !allowed
            ? { _tag: "refused", reason: "needs-allow" }
            : { _tag: "answer", result: { content: [] } },
        );
      },
    });
    host.receive(request(1, "tools/call", { name: "hold" }));
    await answered(1);
    supervised = true;
    host.receive(request(2, "tools/call", { name: "hold" }));
    await answered(2);
    supervised = false;
    host.receive(request(3, "tools/call", { name: "stock" }));
    await answered(3);
    assert.deepStrictEqual(asked, ["hold"]);
    assert.deepStrictEqual(
      calls.map((call) => [call.name, call.allowed]),
      [
        ["hold", false],
        ["hold", false],
        ["hold", true],
        ["stock", false],
      ],
    );
    assert.deepNestedInclude(answerTo(sent, 2), { "result.content": [] });
  });

  it("opens only an http or https link, and only once the operator opens it", async () => {
    const opened: Array<string> = [];
    const { host, sent, answered } = hosted({
      openLink: (url) => {
        opened.push(url.href);
        return Promise.resolve(true);
      },
    });
    for (const [id, url] of [
      [1, "javascript:alert(1)"],
      [2, "file:///etc/passwd"],
      [3, "https://user:pass@example.com/"],
      [4, "https://example.com/shop"],
    ] as const) {
      host.receive(request(id, "ui/open-link", { url }));
    }
    await answered(1, 2, 3, 4);
    assert.deepStrictEqual(opened, ["https://example.com/shop"]);
    for (const id of [1, 2, 3])
      assert.deepNestedInclude(answerTo(sent, id), { "error.code": -32602 });
  });

  it("sends a message the app proposes only once the operator sends it", async () => {
    const proposed: Array<string> = [];
    const { host, sent, answered } = hosted({
      proposeMessage: (text) => {
        proposed.push(text);
        return Promise.resolve(false);
      },
    });
    host.receive(
      request(1, "ui/message", {
        role: "user",
        content: [{ type: "text", text: "Hold the Ridge 7" }],
      }),
    );
    await answered(1);
    assert.deepStrictEqual(proposed, ["Hold the Ridge 7"]);
    assert.deepNestedInclude(answerTo(sent, 1), { "error.code": -32000 });
  });

  it("refuses what J3 Bots does not offer an app, and keeps its height within the frame's", () => {
    const { host, sent, heights } = hosted();
    host.receive(request(1, "ui/update-model-context", { content: [] }));
    host.receive(request(2, "ui/download-file", {}));
    host.receive(request(3, "ui/request-display-mode", { mode: "fullscreen" }));
    assert.deepNestedInclude(answerTo(sent, 1), { "error.code": -32000 });
    assert.deepNestedInclude(answerTo(sent, 2), { "error.code": -32601 });
    assert.deepNestedInclude(answerTo(sent, 3), { "result.mode": "inline" });
    host.receive(notification("ui/notifications/size-changed", { height: 99_999 }));
    host.receive(notification("ui/notifications/size-changed", { height: 10 }));
    assert.deepStrictEqual(heights, [MAX_CONNECTOR_APP_HEIGHT, 80]);
  });

  it("tells a ready app it is going away, then answers nothing more", () => {
    const { host, sent } = hosted();
    host.receive(notification("ui/notifications/initialized"));
    host.teardown("gone");
    assert.deepInclude(sent.at(-1), { method: "ui/resource-teardown" });
    const count = sent.length;
    host.receive(request(9, "ping"));
    assert.strictEqual(sent.length, count);
  });
});
