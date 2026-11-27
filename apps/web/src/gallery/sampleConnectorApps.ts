// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type ConnectorAppRef,
  type ConnectorAppView,
  ConnectorAppViewId,
  ConnectorId,
} from "@j3-bots/contracts";
import type { ConnectorAppAccess } from "../components/ConnectorAppCard";

// A connector's app as the gallery shows one: a fictional bike shop's stock
// list, which Scout's lookup opened. It draws in the host's colors, reports
// its height, can be shown full screen, and asks the host to run a tool, to
// open a link and to keep what the operator picked as context for Scout, so
// every line the client draws for an app shows here. A second one asks to
// run its tool as it opens, which the operator is asked to allow.

const STOCK_HTML = `<style>
  body { margin: 0; padding: 12px 14px; font: 14px/1.45 var(--font-sans, system-ui);
    color: var(--color-text-primary, #222); background: var(--color-background-primary, #fff); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--color-border-primary, #ddd); }
  th { font-weight: 600; color: var(--color-text-secondary, #555); font-size: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  button { font: inherit; padding: 4px 10px; border-radius: var(--border-radius-md, 6px);
    border: 1px solid var(--color-border-primary, #ccc); background: transparent; color: inherit; }
</style>
<table>
  <thead><tr><th>Model</th><th>Size</th><th>In stock</th></tr></thead>
  <tbody>
    <tr><td>Ridge 7</td><td>M</td><td>2</td></tr>
    <tr><td>Hillside Pro</td><td>M, L</td><td>1</td></tr>
    <tr><td>Commuter E</td><td>L</td><td>0</td></tr>
  </tbody>
</table>
<div class="actions">
  <button id="reserve">Hold the Ridge 7</button>
  <button id="page">Shop page</button>
  <button id="full">Full screen</button>
</div>
<script>
  let next = 1;
  const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method, params) => send({ id: next++, method, params });
  request("ui/initialize", {
    appInfo: { name: "stock", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    protocolVersion: "2026-01-26",
  });
  send({ method: "ui/notifications/initialized", params: {} });
  // The host's colors and fonts, as it says them when it answers and each time they change.
  const styled = (context) => {
    for (const [name, value] of Object.entries(context?.styles?.variables ?? {})) {
      document.documentElement.style.setProperty(name, value);
    }
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const { id, result, method, params } = event.data ?? {};
    if (id === 1) styled(result?.hostContext);
    if (method === "ui/notifications/host-context-changed") styled(params);
  });
  const sized = () =>
    send({ method: "ui/notifications/size-changed", params: { height: Math.ceil(document.body.getBoundingClientRect().height) } });
  sized();
  document.getElementById("reserve").onclick = () => {
    request("ui/update-model-context", {
      content: [{ type: "text", text: "Picked the Ridge 7 in size M to hold." }],
    });
    request("tools/call", { name: "hold_bike", arguments: { model: "Ridge 7", size: "M" } });
  };
  document.getElementById("full").onclick = () =>
    request("ui/request-display-mode", { mode: "fullscreen" });
  document.getElementById("page").onclick = () =>
    request("ui/open-link", { url: "https://example.com/shop/ridge-7" });
</script>`;

/** The same app, asking to hold the bike as it opens. */
const ASKING_HTML = `${STOCK_HTML}<script>
  window.parent.postMessage({ jsonrpc: "2.0", id: 99, method: "tools/call",
    params: { name: "hold_bike", arguments: { model: "Ridge 7", size: "M" } } }, "*");
</script>`;

const viewId = ConnectorAppViewId.make("app_samplestocklist0");

export const sampleConnectorAppRef: ConnectorAppRef = {
  viewId,
  connectorId: ConnectorId.make("conn_samplewheelhouse"),
  connector: "Wheelhouse",
  glyph: null,
  tool: "Stock by store",
};

const askingViewId = ConnectorAppViewId.make("app_sampleaskinghold0");

/** An app that asks, as it opens, to run a tool the operator has not allowed. */
export const sampleAskingAppRef: ConnectorAppRef = {
  ...sampleConnectorAppRef,
  viewId: askingViewId,
};

const sampleView: ConnectorAppView = {
  viewId,
  botId: BotId.make("scout"),
  connectorId: sampleConnectorAppRef.connectorId,
  connector: sampleConnectorAppRef.connector,
  tool: {
    name: "stock_by_store",
    title: "Stock by store",
    description: "What the shop has in stock, by model and size.",
    inputSchema: { type: "object", properties: { models: { type: "array" } } },
  },
  html: STOCK_HTML,
  csp: { connectDomains: [], resourceDomains: [], baseUriDomains: [] },
  input: { models: ["Ridge 7", "Hillside Pro", "Commuter E"] },
  result: { content: [{ type: "text", text: "3 models, 3 in stock" }], isError: false },
  modelContext: true,
};

const askingView: ConnectorAppView = { ...sampleView, viewId: askingViewId, html: ASKING_HTML };

/**
 * What the gallery's server does for its apps: it answers from the sample,
 * as for a bot that is not in full access, and sends nothing.
 */
export const sampleConnectorAppAccess: ConnectorAppAccess = {
  server: new URL("https://bots.example.com"),
  platform: "web",
  open: (asked) =>
    Promise.resolve(asked === viewId ? sampleView : asked === askingViewId ? askingView : null),
  callTool: (_view, _name, _args, allowed) =>
    Promise.resolve(
      allowed
        ? {
            _tag: "answer",
            result: { content: [{ type: "text", text: "Held until Saturday." }], isError: false },
          }
        : { _tag: "refused", reason: "needs-allow" },
    ),
  readResource: () => Promise.resolve({ _tag: "refused", reason: "unavailable" }),
  setContext: () => Promise.resolve({ _tag: "kept" }),
  sendMessage: () => Promise.resolve(true),
  openLink: () => {},
  save: () => {},
};
