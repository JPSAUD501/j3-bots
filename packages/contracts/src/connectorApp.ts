// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, Label } from "./base.ts";
import { ConnectorId } from "./connector.ts";

// A connector's app: the interface an MCP server gives one of its tools (the
// MCP Apps extension, `io.modelcontextprotocol/ui`, at its 2026-01-26
// version), which clients draw under the bot's work, in a frame isolated from
// everything of J3 Bots' (decision 0048). docs/architecture/clients.md,
// "Connector apps", says how a client draws one; docs/architecture/security.md,
// "Connector apps", says what it can and cannot reach.

/** The extension's identifier, as a client declares it to a server. */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

/** The one kind of interface the extension defines: an HTML document. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The version of the extension's host protocol J3 Bots speaks with an app. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** The most an app's document may weigh, as UTF-8. */
export const MAX_CONNECTOR_APP_BYTES = 2 * 1024 * 1024;

/**
 * The most a tool's answer or a resource, as JSON, may weigh for an app to
 * be given it. A bot's own reading of an answer is cut far shorter.
 */
export const MAX_CONNECTOR_APP_DATA_BYTES = 2 * 1024 * 1024;

/** The most origins an app may name in each list of its policy; any past these are not allowed. */
export const MAX_CONNECTOR_APP_DOMAINS = 32;

/** The most apps one turn's work shows; a turn that opens more shows the first ones. */
export const MAX_CONNECTOR_APPS_PER_FOLD = 20;

/** The shortest and tallest an app's frame is drawn inline, in CSS pixels. */
export const MIN_CONNECTOR_APP_HEIGHT = 80;
export const MAX_CONNECTOR_APP_HEIGHT = 1_600;

/** One app a tool call opened, as its turn's work keeps it. */
export const ConnectorAppViewId = Schema.String.check(
  Schema.isPattern(/^app_[0-9a-z]{16,40}$/),
).pipe(Schema.brand("ConnectorAppViewId"));
export type ConnectorAppViewId = typeof ConnectorAppViewId.Type;

/**
 * An origin an app may reach, as a policy names it: `https:` for what it
 * loads and fetches, `wss:` for a socket, a host of at least two labels (a
 * leading `*.` for any subdomain), and a port if any. Never an IP address,
 * `localhost` or a single label, which would let a page from someone else's
 * server reach into the operator's own network, and never a path, a keyword
 * or a scheme alone.
 */
export const ConnectorAppOrigin = Schema.String.check(
  Schema.isPattern(
    /^(?:https|wss):\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$/,
  ),
);
export type ConnectorAppOrigin = typeof ConnectorAppOrigin.Type;

const origins = Schema.Array(ConnectorAppOrigin).check(
  Schema.isMaxLength(MAX_CONNECTOR_APP_DOMAINS),
);

/**
 * What an app's server declared it reaches, as J3 Bots allows it: what it
 * fetches or opens a socket to (`connectDomains`), what it loads scripts,
 * styles, images, fonts and media from (`resourceDomains`), and what its
 * `<base>` may name (`baseUriDomains`). Nested frames (`frameDomains`) and
 * device permissions are never allowed.
 */
export const ConnectorAppCsp = Schema.Struct({
  connectDomains: origins,
  resourceDomains: origins,
  baseUriDomains: origins,
});
export type ConnectorAppCsp = typeof ConnectorAppCsp.Type;

/**
 * The policy an app's document runs under: its own inline scripts and styles,
 * images, fonts and media from `data:` (and `blob:` for images and media),
 * and of the network only what its server declared. Never `'self'`, which in
 * an app's frame would name J3 Bots' own address. No frame, no form target,
 * no plugin.
 */
export const connectorAppContentPolicy = (csp: ConnectorAppCsp): string => {
  const sources = (fixed: string, declared: ReadonlyArray<string>) =>
    [fixed, ...declared].join(" ").trim();
  return [
    "default-src 'none'",
    `script-src ${sources("'unsafe-inline'", csp.resourceDomains)}`,
    `style-src ${sources("'unsafe-inline'", csp.resourceDomains)}`,
    `img-src ${sources("data: blob:", csp.resourceDomains)}`,
    `font-src ${sources("data:", csp.resourceDomains)}`,
    `media-src ${sources("data: blob:", csp.resourceDomains)}`,
    `connect-src ${csp.connectDomains.length === 0 ? "'none'" : csp.connectDomains.join(" ")}`,
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri ${csp.baseUriDomains.length === 0 ? "'none'" : csp.baseUriDomains.join(" ")}`,
    "object-src 'none'",
  ].join("; ");
};

/**
 * The page of the web client's build an app is drawn in, on the client's own
 * origin, as a visual's is. Its document has a policy of its own, which a
 * `srcdoc` frame would not.
 */
export const CONNECTOR_APP_FRAME_PATH = "/connector-app-frame.html";

/**
 * The widest policy any app's document may have: `https:` and `wss:` only,
 * never `'self'`. The document's own policy narrows it to what its server
 * declared (`connectorAppContentPolicy`), less the J3 Bots server
 * (`connectorAppDocument`). Android's shell page
 * carries it as its own (`connectorAppShell`).
 */
export const CONNECTOR_APP_WIDEST_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https: wss:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri https:",
  "object-src 'none'",
].join("; ");

/**
 * The policy whoever serves `CONNECTOR_APP_FRAME_PATH` sends with it: the
 * widest an app may have; `sandbox allow-scripts allow-forms`, so the page
 * has an opaque origin wherever it is opened, even on its own; and
 * `frame-ancestors 'self'`, so only the client's own pages may frame it.
 */
export const CONNECTOR_APP_FRAME_POLICY = `${CONNECTOR_APP_WIDEST_POLICY}; sandbox allow-scripts allow-forms; frame-ancestors 'self'`;

const utf8 = new TextEncoder();

/** Whether `text` is at most `max` bytes as UTF-8, encoding only when its length cannot tell. */
export const fitsUtf8 = (text: string, max: number): boolean =>
  text.length <= max && (text.length * 3 <= max || utf8.encode(text).length <= max);

/**
 * An app's document: an HTML document as its server wrote it, never blank,
 * well formed and at most `MAX_CONNECTOR_APP_BYTES` as UTF-8.
 */
export const ConnectorAppHtml = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.makeFilter(
    (html: string) => html.isWellFormed() || "a document that is not well-formed Unicode text",
  ),
  Schema.makeFilter(
    (html: string) =>
      fitsUtf8(html, MAX_CONNECTOR_APP_BYTES) ||
      `a document of more than ${MAX_CONNECTOR_APP_BYTES} bytes`,
  ),
);

/**
 * An app a turn's work shows, under its fold: which one, and the connector
 * and tool to name it by (the tool's title, else its name).
 */
export const ConnectorAppRef = Schema.Struct({
  viewId: ConnectorAppViewId,
  connectorId: ConnectorId,
  connector: Label,
  tool: Label,
});
export type ConnectorAppRef = typeof ConnectorAppRef.Type;

/** The tool that opened an app, as the app is told it (`hostContext.toolInfo`). */
export const ConnectorAppTool = Schema.Struct({
  /** Its name at its server. */
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.String,
  inputSchema: Schema.JsonObject,
});
export type ConnectorAppTool = typeof ConnectorAppTool.Type;

/**
 * An app, ready to draw: its document and policy, the call that opened it,
 * as its connector answered it. `result` is
 * the tool's answer as MCP gives it (`CallToolResult`), with the connector's
 * secrets taken out; null when the call had none to give, or a larger one
 * than `MAX_CONNECTOR_APP_DATA_BYTES`.
 */
export const ConnectorAppView = Schema.Struct({
  viewId: ConnectorAppViewId,
  botId: BotId,
  connectorId: ConnectorId,
  connector: Label,
  tool: ConnectorAppTool,
  html: ConnectorAppHtml,
  csp: ConnectorAppCsp,
  input: Schema.JsonObject,
  result: Schema.NullOr(Schema.Json),
});
export type ConnectorAppView = typeof ConnectorAppView.Type;

/**
 * Why J3 Bots did not pass on an app's request:
 *
 * - `gone`: the connector was removed, or the bot no longer has it.
 * - `not-for-apps`: the connector's server does not let apps call that tool
 *   (its `visibility` leaves out `app`), or the bot is not offered it.
 * - `unavailable`: the connector is not connected, or did not answer.
 * - `too-large`: the request or its answer is larger than an app may pass.
 * - `needs-allow`: the bot is not in full access, and the operator did not
 *   allow the call.
 */
export const ConnectorAppRefusal = Schema.Literals([
  "gone",
  "not-for-apps",
  "unavailable",
  "too-large",
  "needs-allow",
]);
export type ConnectorAppRefusal = typeof ConnectorAppRefusal.Type;

/**
 * What an app's request came back with: the connector's answer as MCP gives
 * it (a `CallToolResult`, a `ReadResourceResult`), with the connector's
 * secrets taken out, or why J3 Bots did not pass it on.
 */
export const ConnectorAppAnswer = Schema.Union([
  Schema.TaggedStruct("answer", { result: Schema.Json }),
  Schema.TaggedStruct("refused", { reason: ConnectorAppRefusal }),
]);
export type ConnectorAppAnswer = typeof ConnectorAppAnswer.Type;

/** A tool name as MCP allows it. */
export const ConnectorAppToolName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/),
);

/** A resource's address, as an app asks for it. */
export const ConnectorAppResourceUri = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
);
