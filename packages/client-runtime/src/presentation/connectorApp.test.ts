// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  CONNECTOR_APP_FRAME_POLICY,
  type ConnectorAppAnswer,
  type ConnectorAppView,
  ConnectorAppViewId,
  type ConnectorAppContext,
  type ConnectorAppContextOutcome,
  ConnectorId,
  MAX_CONNECTOR_APP_CONTEXT_BYTES,
} from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as Schema from "effect/Schema";
import {
  CONNECTOR_APP_FRAME_SANDBOX,
  CONNECTOR_APP_DEFAULT_HEIGHT,
  type ConnectorAppAsk,
  type ConnectorAppDisplayMode,
  type ConnectorAppDownload,
  type ConnectorAppHostOptions,
  type ConnectorAppPlace,
  type HostMessage,
  MAX_CONNECTOR_APP_INLINE_HEIGHT,
  connectorAppDocument,
  connectorAppFileName,
  connectorAppHost,
  connectorAppShell,
  connectorAppStartHeight,
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
  modelContext: true,
};

const SERVER = new URL("https://bots.example.com");

const place: ConnectorAppPlace = {
  appearance: "dark",
  locale: "pt-BR",
  timeZone: "America/Sao_Paulo",
  platform: "web",
  touch: false,
  hover: true,
  display: { mode: "inline", width: 480 },
  modes: ["inline", "fullscreen", "pip"],
};

/** A host over `view` with `changes`, recording what it sends the app and what it asks of the client. */
const hosted = (
  overrides: Partial<ConnectorAppHostOptions> = {},
  changes: Partial<ConnectorAppView> = {},
  base: ConnectorAppView = view,
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
  const contexts: Array<ConnectorAppContext> = [];
  const modes: Array<ReadonlyArray<ConnectorAppDisplayMode>> = [];
  const answer: ConnectorAppAnswer = { _tag: "answer", result: { content: [] } };
  const host = connectorAppHost({
    view: { ...base, ...changes },
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
    download: () => Promise.resolve(false),
    setContext: (context) => {
      contexts.push(context);
      return Promise.resolve<ConnectorAppContextOutcome>({ _tag: "kept" });
    },
    setDisplayMode: (mode) => mode,
    onModes: (shown) => modes.push(shown),
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
  return { host, sent, calls, asked, heights, contexts, modes, answered };
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

/** The fields of a notification the host sent. */
const paramsOf = (message: HostMessage | undefined): Readonly<Record<string, unknown>> => {
  if (message === undefined || !("method" in message)) throw new Error("Not a notification");
  const { params } = message;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Its params are not an object");
  }
  return { ...params };
};

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
      "result.hostContext.containerDimensions": {
        width: 480,
        maxHeight: MAX_CONNECTOR_APP_INLINE_HEIGHT,
      },
      "result.hostContext.availableDisplayModes": ["inline", "fullscreen", "pip"],
      "result.hostContext.timeZone": "America/Sao_Paulo",
      "result.hostContext.platform": "web",
      "result.hostContext.deviceCapabilities": { touch: false, hover: true },
      "result.hostContext.safeAreaInsets": { top: 0, right: 0, bottom: 0, left: 0 },
      "result.hostContext.toolInfo.tool.name": "stock",
      "result.hostCapabilities.sandbox.permissions": {},
      "result.hostCapabilities.sandbox.csp.frameDomains": [],
    });
    // Nothing but the answer before the app says it is ready.
    assert.strictEqual(sent.length, 1);
    host.placeChanged({ ...place, appearance: "light" });
    assert.strictEqual(sent.length, 1);

    host.receive(notification("ui/notifications/initialized"));
    // Once ready: the light theme it was not told of, as the fields that changed, then the call.
    assert.deepStrictEqual(
      sent.slice(1).map((message) => ("method" in message ? message.method : null)),
      [
        "ui/notifications/host-context-changed",
        "ui/notifications/tool-input",
        "ui/notifications/tool-result",
      ],
    );
    assert.sameMembers(Object.keys(paramsOf(sent[1])), ["theme", "styles"]);
    // Then each change: a narrower frame.
    host.placeChanged({ ...place, appearance: "light", display: { mode: "inline", width: 300 } });
    assert.deepStrictEqual(paramsOf(sent.at(-1)), {
      containerDimensions: { width: 300, maxHeight: MAX_CONNECTOR_APP_INLINE_HEIGHT },
    });
    // Nothing changed, nothing sent.
    const count = sent.length;
    host.placeChanged({ ...place, appearance: "light", display: { mode: "inline", width: 300 } });
    assert.strictEqual(sent.length, count);
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

  it("fits the height an app reports into the reply, and starts it there when it is drawn again", () => {
    const viewId = ConnectorAppViewId.make("app_heightsremembered00");
    assert.strictEqual(connectorAppStartHeight(viewId), CONNECTOR_APP_DEFAULT_HEIGHT);
    const first = hosted({}, { viewId });
    first.host.receive(notification("ui/notifications/size-changed", { height: 99_999 }));
    first.host.receive(notification("ui/notifications/size-changed", { height: 10 }));
    first.host.receive(notification("ui/notifications/size-changed", { height: 412.4 }));
    assert.deepStrictEqual(first.heights, [MAX_CONNECTOR_APP_INLINE_HEIGHT, 80, 413]);
    void first.host.teardown("scrolled away");
    // Drawn again, as the operator scrolls back: at the size it last had.
    assert.strictEqual(connectorAppStartHeight(viewId), 413);
  });

  it("shows an app in a mode only the client and the app both have, and says which it is shown in", () => {
    const set: Array<ConnectorAppDisplayMode> = [];
    const { host, sent, modes } = hosted({
      setDisplayMode: (mode) => {
        set.push(mode);
        return mode;
      },
    });
    host.receive(
      request(1, "ui/initialize", {
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "tv"] },
      }),
    );
    host.receive(notification("ui/notifications/initialized"));
    assert.deepStrictEqual(modes, [["inline", "fullscreen"]]);

    host.receive(request(2, "ui/request-display-mode", { mode: "pip" }));
    host.receive(request(3, "ui/request-display-mode", { mode: "fullscreen" }));
    host.receive(request(4, "ui/request-display-mode", { mode: "tv" }));
    assert.deepNestedInclude(answerTo(sent, 2), { "result.mode": "inline" });
    assert.deepNestedInclude(answerTo(sent, 3), { "result.mode": "fullscreen" });
    assert.deepNestedInclude(answerTo(sent, 4), { "error.code": -32602 });
    assert.deepStrictEqual(set, ["fullscreen"]);

    // The client shows it so, and tells it: the mode and the room it has there.
    host.placeChanged({ ...place, display: { mode: "fullscreen", width: 900, height: 700 } });
    assert.deepStrictEqual(paramsOf(sent.at(-1)), {
      displayMode: "fullscreen",
      containerDimensions: { width: 900, height: 700 },
    });
    // A client with room for no other mode, as on a narrow window: the app can only be inline.
    host.placeChanged({ ...place, modes: ["inline"] });
    assert.deepStrictEqual(modes.at(-1), ["inline"]);
    host.receive(request(5, "ui/request-display-mode", { mode: "fullscreen" }));
    assert.deepNestedInclude(answerTo(sent, 5), { "result.mode": "inline" });
    assert.deepStrictEqual(set, ["fullscreen"]);
  });

  it("keeps an app's context for its bot, its text and its data, bounded and only where the server offers it", async () => {
    const { host, sent, contexts, answered } = hosted();
    host.receive(request(1, "ui/initialize", {}));
    assert.deepNestedInclude(answerTo(sent, 1), {
      "result.hostCapabilities.updateModelContext": { text: {}, structuredContent: {} },
    });
    host.receive(
      request(2, "ui/update-model-context", {
        content: [
          { type: "text", text: "Picked the Ridge 7" },
          { type: "text", text: "in red." },
        ],
        structuredContent: { model: "Ridge 7", color: "red" },
      }),
    );
    host.receive(
      request(3, "ui/update-model-context", {
        content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      }),
    );
    host.receive(
      request(4, "ui/update-model-context", {
        content: [{ type: "text", text: "x".repeat(MAX_CONNECTOR_APP_CONTEXT_BYTES + 1) }],
      }),
    );
    await answered(2, 3, 4);
    assert.deepStrictEqual(contexts, [
      { text: "Picked the Ridge 7\n\nin red.", structured: { model: "Ridge 7", color: "red" } },
    ]);
    assert.deepNestedInclude(answerTo(sent, 2), { result: {} });
    assert.deepNestedInclude(answerTo(sent, 3), { "error.code": -32602 });
    assert.deepNestedInclude(answerTo(sent, 4), { "error.code": -32000 });

    // A server from before 0.14.0 keeps no context: the app is told so.
    const { modelContext: _, ...fromOlder } = view;
    const older = hosted({}, {}, fromOlder);
    older.host.receive(request(1, "ui/initialize", {}));
    older.host.receive(request(2, "ui/update-model-context", { content: [] }));
    await older.answered(2);
    assert.notNestedProperty(answerTo(older.sent, 1), "result.hostCapabilities.updateModelContext");
    assert.deepNestedInclude(answerTo(older.sent, 2), { "error.code": -32000 });
    assert.deepStrictEqual(older.contexts, []);
  });

  it("offers the operator an app's files under safe names, and saves nothing they put aside", async () => {
    const offered: Array<ReadonlyArray<ConnectorAppDownload>> = [];
    const { host, sent, answered } = hosted({
      download: (files) => {
        offered.push(files);
        return Promise.resolve(false);
      },
    });
    host.receive(
      request(1, "ui/download-file", {
        contents: [
          {
            type: "resource",
            resource: { uri: "file:///../../etc/stock%20list.csv", mimeType: "text/csv", text: "a,b" },
          },
          { type: "resource", resource: { uri: "ui://x/logo.png", blob: "aGk=" } },
          { type: "resource_link", uri: "https://wheelhouse.example/q4.pdf", name: "Q4 report" },
        ],
      }),
    );
    host.receive(
      request(2, "ui/download-file", {
        contents: [{ type: "resource_link", uri: "javascript:alert(1)", name: "x" }],
      }),
    );
    await answered(1, 2);
    assert.strictEqual(offered.length, 1);
    assert.deepStrictEqual(
      offered[0]?.map((file) =>
        file._tag === "file"
          ? [file.name, file.mediaType, new TextDecoder().decode(file.bytes)]
          : [file.name, file.url.href],
      ),
      [
        ["stock list.csv", "text/csv", "a,b"],
        ["logo.png", "application/octet-stream", "hi"],
        ["Q4 report", "https://wheelhouse.example/q4.pdf"],
      ],
    );
    assert.deepNestedInclude(answerTo(sent, 1), { "error.code": -32000 });
    assert.deepNestedInclude(answerTo(sent, 2), { "error.code": -32602 });
    assert.strictEqual(connectorAppFileName("..\\..\\"), "download");
  });

  it("answers a method it does not know as unknown", () => {
    const { host, sent } = hosted();
    host.receive(request(1, "sampling/createMessage", {}));
    assert.deepNestedInclude(answerTo(sent, 1), { "error.code": -32601 });
  });

  it("tells a ready app it is going away, waits for its answer, then answers nothing more", async () => {
    const { host, sent } = hosted();
    host.receive(notification("ui/notifications/initialized"));
    let settled = false;
    const gone = host.teardown("gone").then(() => {
      settled = true;
    });
    assert.deepInclude(sent.at(-1), { method: "ui/resource-teardown" });
    const count = sent.length;
    host.receive(request(9, "ping"));
    await Promise.resolve();
    assert.isFalse(settled);
    host.receive({ jsonrpc: "2.0", id: "j3-teardown", result: {} });
    await gone;
    assert.strictEqual(sent.length, count);
  });
});
