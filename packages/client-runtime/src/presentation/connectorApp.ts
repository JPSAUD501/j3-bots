// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CONNECTOR_APP_WIDEST_POLICY,
  type ConnectorAppAnswer,
  type ConnectorAppCsp,
  type ConnectorAppRefusal,
  type ConnectorAppView,
  connectorAppContentPolicy,
  fitsUtf8,
  MAX_CONNECTOR_APP_DATA_BYTES,
  MAX_CONNECTOR_APP_HEIGHT,
  MCP_APPS_PROTOCOL_VERSION,
  MIN_CONNECTOR_APP_HEIGHT,
  PROTOCOL_VERSION,
  visualEscapesGuard,
} from "@j3-bots/contracts";
import { appStyleVariables } from "@j3-bots/design-tokens";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PAGE_GUARD, type VisualAppearance } from "./visual.ts";

/**
 * How every client hosts a connector's app (the MCP Apps extension at
 * `MCP_APPS_PROTOCOL_VERSION`, decision 0048): the document it draws, the
 * frame it draws it in, and the host side of the protocol the app speaks
 * with it over `postMessage`. The web and the desktop app frame the client's
 * app page; Android frames `connectorAppShell`'s. Both run the same
 * `connectorAppHost`. docs/architecture/security.md, "Connector apps", says
 * what each rule keeps out.
 */

/**
 * The `sandbox` of an app's frame: scripts, and forms, whose submission its
 * policy sends nowhere (`form-action 'none'`), so a form's own script still
 * runs. Never `allow-same-origin`, which would give the app the client's
 * origin, its storage and its session; never top navigation, popups or
 * modals. Every document the app makes inherits it.
 */
export const CONNECTOR_APP_FRAME_SANDBOX = "allow-scripts allow-forms";

/**
 * The object an Android WebView puts on `connectorAppShell`'s window to take
 * what the app sends: a `postMessage(string)` that receives each message as
 * JSON. Android's side names it with the same literal.
 */
export const CONNECTOR_APP_BRIDGE = "J3App";

/** The height an app's frame starts at, before the app reports its own. */
export const CONNECTOR_APP_DEFAULT_HEIGHT = 360;

/** Fits a height an app reports into what its frame is drawn at inline. */
export const clampConnectorAppHeight = (height: number): number =>
  Math.min(MAX_CONNECTOR_APP_HEIGHT, Math.max(MIN_CONNECTOR_APP_HEIGHT, Math.ceil(height)));

/**
 * An app's document, ready for the client's app page or `connectorAppShell`:
 * the policy its server declared, as J3 Bots allows it, then the guard every
 * visual runs first (no WebRTC, which no policy covers, and no nested
 * document, which would have it again), then the document as its server
 * wrote it. They come before any of it, so the policy holds from its first
 * byte and the guard has run before its first script.
 *
 * Of the declared origins, none that reaches the host of `server`, the J3
 * Bots server the client speaks to, at any port, directly or through a
 * wildcard: an app never sends a request there, with or without credentials.
 *
 * Null when the document's markup holds what the guard could not watch,
 * another document or a declarative shadow root (`visualEscapesGuard`): the
 * client shows that it could not show it.
 */
export const connectorAppDocument = (
  view: Pick<ConnectorAppView, "html" | "csp">,
  server: URL,
): string | null =>
  visualEscapesGuard(view.html)
    ? null
    : "<!doctype html>" +
      `<meta http-equiv="Content-Security-Policy" content="${connectorAppContentPolicy(withoutServer(view.csp, server))}">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<script>${PAGE_GUARD}</script>` +
      view.html;

/** Whether `origin` (`ConnectorAppOrigin`) reaches `host`: the same host, or a wildcard over it. */
const reaches = (origin: string, host: string): boolean => {
  const named = origin.replace(/^[a-z]+:\/\//, "").replace(/:[0-9]+$/, "");
  return named.startsWith("*.") ? host.endsWith(named.slice(1)) : named === host;
};

/** `csp` without an origin that reaches the host of `server`. */
const withoutServer = (csp: ConnectorAppCsp, server: URL): ConnectorAppCsp => {
  // A host may be written with the root's trailing dot; an origin never is.
  const host = server.hostname.toLowerCase().replace(/\.$/, "");
  const kept = (origins: ReadonlyArray<string>) =>
    origins.filter((origin) => !reaches(origin, host));
  return {
    connectDomains: kept(csp.connectDomains),
    resourceDomains: kept(csp.resourceDomains),
    baseUriDomains: kept(csp.baseUriDomains),
  };
};

/** `text` as a double-quoted attribute's value: the parser gives back `text`. */
const attributeValue = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// Passes on what the app's frame sends, from that frame's window alone, to
// the WebView's bridge as JSON; and gives the app what the app's side hands
// `deliver`, as the web client would post it.
const RELAY = `(function(){var f=document.getElementById("app"),b=window[${JSON.stringify(CONNECTOR_APP_BRIDGE)}];window.addEventListener("message",function(e){if(e.source!==f.contentWindow||!b)return;var t;try{t=JSON.stringify(e.data);}catch(x){return;}if(typeof t==="string")b.postMessage(t);});window.deliver=function(t){f.contentWindow.postMessage(JSON.parse(t),"*");};})();`;

/**
 * The page a WebView loads to show `document`, as `connectorAppDocument`
 * builds it. A WebView loads its own page unsandboxed, so the app runs in a
 * frame sandboxed as on the web, under its own policy, and this page, under
 * the widest an app may have, relays its messages to and from the app's bridge
 * (`CONNECTOR_APP_BRIDGE`). The frame fills the page; the app sizes the
 * WebView to the height the app reports.
 */
export const connectorAppShell = (document: string): string =>
  "<!doctype html>" +
  `<meta http-equiv="Content-Security-Policy" content="${CONNECTOR_APP_WIDEST_POLICY}">` +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>" +
  `<iframe id="app" sandbox="${CONNECTOR_APP_FRAME_SANDBOX}" srcdoc="${attributeValue(document)}"></iframe>` +
  `<script>${RELAY}</script>`;

/**
 * Whether a message reached the client from `frame`, the window of the app's
 * own frame: anything from another window, another app's or a visual's
 * included, is not the app's and is dropped unread.
 */
export const fromOwnFrame = (
  event: { readonly source: unknown },
  frame: object | null | undefined,
): boolean => frame !== null && frame !== undefined && event.source === frame;

// ---- The protocol --------------------------------------------------------------------

/** A JSON-RPC id, as the app chose it. */
const RequestId = Schema.Union([Schema.String, Schema.Finite]);
type RequestId = typeof RequestId.Type;

const Params = Schema.optionalKey(Schema.Record(Schema.String, Schema.Json));

const AppRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: RequestId,
  method: Schema.String,
  params: Params,
});
const AppNotification = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Params,
});
const decodeRequest = Schema.decodeUnknownOption(AppRequest);
const decodeNotification = Schema.decodeUnknownOption(AppNotification);

const ToolCallParams = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const ReadParams = Schema.Struct({
  uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
});
const LinkParams = Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(8_192)) });
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const MessageParams = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([TextBlock, Schema.Array(Schema.Unknown)]),
});
const SizeParams = Schema.Struct({
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
});

const decodeToolCall = Schema.decodeUnknownOption(ToolCallParams);
const decodeRead = Schema.decodeUnknownOption(ReadParams);
const decodeLink = Schema.decodeUnknownOption(LinkParams);
const decodeMessage = Schema.decodeUnknownOption(MessageParams);
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock);
const decodeSize = Schema.decodeUnknownOption(SizeParams);

/** A message the host sends the app. */
export type HostMessage =
  | {
      readonly jsonrpc: "2.0";
      readonly id: RequestId;
      readonly result: Schema.Json;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: RequestId;
      readonly error: { readonly code: number; readonly message: string };
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id?: RequestId;
      readonly method: string;
      readonly params: Schema.Json;
    };

/** JSON-RPC's own codes, and the extension's for a request the host turned down. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const DENIED = -32000;

/** What a client tells an app of where it is drawn (`hostContext`), apart from the tool. */
export interface ConnectorAppPlace {
  readonly appearance: VisualAppearance;
  /** BCP 47, as the interface speaks it. */
  readonly locale: string;
  /** IANA, as the device keeps it. */
  readonly timeZone: string;
  readonly platform: "web" | "desktop" | "mobile";
  readonly touch: boolean;
  readonly hover: boolean;
  /** The width the frame has; its height follows the app, up to `MAX_CONNECTOR_APP_HEIGHT`. */
  readonly width: number;
}

/** A tool call the app asked for: allowed or not, and what came of it. */
export type ConnectorAppAsk = "allowed" | "declined";

/** What a client does for the app, each when the app asks. */
export interface ConnectorAppHostOptions {
  readonly view: ConnectorAppView;
  readonly place: ConnectorAppPlace;
  /** Sends the app one message (`postMessage` to its frame's window, or through the shell). */
  readonly send: (message: HostMessage) => void;
  /**
   * Makes the call, as the bot (`connectorApp.callTool`), saying whether the
   * operator `allowed` it; null when the server could not be reached.
   */
  readonly callTool: (
    name: string,
    args: Schema.JsonObject,
    allowed: boolean,
  ) => Promise<ConnectorAppAnswer | null>;
  /** Reads the resource (`connectorApp.readResource`); null when the server could not be reached. */
  readonly readResource: (uri: string) => Promise<ConnectorAppAnswer | null>;
  /**
   * Asks the operator whether the app may call `tool`, in the client's own
   * line beside the frame, where the app cannot reach: when the server
   * answers `needs-allow`, since the bot is not in full access as the call
   * comes. Each tool is asked once while the app is drawn.
   */
  readonly confirmCall: (tool: string) => Promise<ConnectorAppAsk>;
  /**
   * Shows the operator a message the app would send the bot as theirs; true
   * once they sent it, false when they put it aside. Nothing is sent unless
   * they press it.
   */
  readonly proposeMessage: (text: string) => Promise<boolean>;
  /** Asks the operator to open `url` in their browser; true once they opened it. */
  readonly openLink: (url: URL) => Promise<boolean>;
  /** The height the app reports for its content, fitted to what the frame is drawn at. */
  readonly onHeight: (height: number) => void;
}

/** The host's side of one drawn app. */
export interface ConnectorAppHost {
  /**
   * Takes one message from the app, which the caller checked came from the
   * app's own frame (`fromOwnFrame`). Anything that is not a message of the
   * protocol is dropped.
   */
  readonly receive: (data: unknown) => void;
  /** Tells the app where it is drawn changed, once it is initialized. */
  readonly placeChanged: (place: ConnectorAppPlace) => void;
  /**
   * Tells the app it is going away (`ui/resource-teardown`), as its frame
   * goes with the view that drew it: the client does not hold the frame for
   * its answer. Nothing is sent to it, and nothing it sends is read,
   * afterwards.
   */
  readonly teardown: (reason: string) => void;
}

/** Why J3 Bots did not pass on a request, as the app reads it in its error. */
const REFUSAL_MESSAGE: Readonly<Record<ConnectorAppRefusal, string>> = {
  gone: "The connector was removed, or the bot no longer has it.",
  "not-for-apps": "The connector does not let apps call that tool.",
  unavailable: "The connector is not connected, or did not answer.",
  "too-large": "The request or its answer is too large to pass on.",
  "needs-allow": "The operator did not allow this call.",
};

const hostContextOf = (view: ConnectorAppView, place: ConnectorAppPlace): Schema.JsonObject => ({
  toolInfo: {
    tool: {
      name: view.tool.name,
      ...(view.tool.title === null ? {} : { title: view.tool.title }),
      description: view.tool.description,
      inputSchema: view.tool.inputSchema,
    },
  },
  ...placeContext(place),
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  userAgent: "j3-bots",
});

const placeContext = (place: ConnectorAppPlace): Schema.JsonObject => ({
  theme: place.appearance,
  styles: { variables: { ...appStyleVariables(place.appearance) } },
  containerDimensions: { width: Math.round(place.width), maxHeight: MAX_CONNECTOR_APP_HEIGHT },
  locale: place.locale,
  timeZone: place.timeZone,
  platform: place.platform,
  deviceCapabilities: { touch: place.touch, hover: place.hover },
});

/** The text of a `ui/message`'s content: its text blocks, in order. */
const messageText = (content: unknown): string => {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .flatMap((block) => Option.toArray(decodeTextBlock(block)))
    .map((block) => block.text)
    .join("\n\n")
    .trim();
};

/** An address the operator's browser may open: `http:` or `https:` only, with no user name or password. */
const linkOf = (url: string): URL | null => {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username === "" &&
    parsed.password === ""
    ? parsed
    : null;
};

/**
 * The host side of the protocol for one drawn app. It answers the app's
 * `ui/initialize` with J3 Bots' capabilities and where the app is drawn, and
 * once the app says it is initialized, gives it the tool's input and its
 * answer. It passes on the app's `tools/call` and `resources/read` to its
 * own connector, through J3 Bots, asking the operator first when the bot's
 * permission mode asks for its own calls; it takes a `ui/message` as a
 * message the operator may send, an `ui/open-link` as a link they may open,
 * and a `ui/notifications/size-changed` as the frame's height. It sends the
 * app nothing but answers before it is initialized, as the extension asks.
 */
export const connectorAppHost = (options: ConnectorAppHostOptions): ConnectorAppHost => {
  const { view } = options;
  let place = options.place;
  let initialized = false;
  let closed = false;
  const allowed = new Set<string>();
  const asking = new Map<string, Promise<ConnectorAppAsk>>();

  const send = (message: HostMessage) => {
    if (!closed) options.send(message);
  };
  const result = (id: RequestId, value: Schema.Json) => send({ jsonrpc: "2.0", id, result: value });
  const error = (id: RequestId, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: Schema.Json) => send({ jsonrpc: "2.0", method, params });

  const answer = (id: RequestId, outcome: ConnectorAppAnswer | null) => {
    if (outcome === null) return error(id, INTERNAL_ERROR, "J3 Bots could not reach its server.");
    if (outcome._tag === "refused") return error(id, DENIED, REFUSAL_MESSAGE[outcome.reason]);
    return result(id, outcome.result);
  };

  /** Asks the operator once per tool while the app is drawn; a call asked meanwhile waits on the same answer. */
  const mayCall = (tool: string): Promise<ConnectorAppAsk> => {
    if (allowed.has(tool)) return Promise.resolve("allowed");
    const pending = asking.get(tool);
    if (pending !== undefined) return pending;
    const ask = options.confirmCall(tool).then((outcome) => {
      asking.delete(tool);
      if (outcome === "allowed") allowed.add(tool);
      return outcome;
    });
    asking.set(tool, ask);
    return ask;
  };

  const callTool = async (id: RequestId, params: unknown) => {
    const call = decodeToolCall(params);
    if (Option.isNone(call)) return error(id, INVALID_PARAMS, "A tool call names a tool.");
    const args = call.value.arguments ?? {};
    if (!fitsUtf8(JSON.stringify(args), MAX_CONNECTOR_APP_DATA_BYTES)) {
      return error(id, DENIED, REFUSAL_MESSAGE["too-large"]);
    }
    const { name } = call.value;
    const declined = () => error(id, DENIED, REFUSAL_MESSAGE["needs-allow"]);
    // The server says whether the bot's mode asks for this call, as it is now.
    let outcome = await options.callTool(name, args, allowed.has(name));
    if (outcome?._tag === "refused" && outcome.reason === "needs-allow") {
      if ((await mayCall(name)) === "declined") return declined();
      outcome = await options.callTool(name, args, true);
    }
    answer(id, outcome);
  };

  const readResource = async (id: RequestId, params: unknown) => {
    const read = decodeRead(params);
    if (Option.isNone(read)) return error(id, INVALID_PARAMS, "A read names a resource.");
    answer(id, await options.readResource(read.value.uri));
  };

  const openLink = async (id: RequestId, params: unknown) => {
    const link = Option.flatMap(decodeLink(params), ({ url }) => Option.fromNullishOr(linkOf(url)));
    if (Option.isNone(link)) return error(id, INVALID_PARAMS, "Invalid URL");
    if (await options.openLink(link.value)) return result(id, {});
    error(id, DENIED, "Link opening denied by user");
  };

  const message = async (id: RequestId, params: unknown) => {
    const text = Option.map(decodeMessage(params), ({ content }) => messageText(content));
    if (Option.isNone(text) || text.value === "") {
      return error(id, INVALID_PARAMS, "Invalid message format");
    }
    if (await options.proposeMessage(text.value)) return result(id, {});
    error(id, DENIED, "Message sending denied");
  };

  const initialize = (id: RequestId) =>
    result(id, {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      // The protocol J3 Bots' clients speak with its server names which J3 Bots this is.
      hostInfo: { name: "j3-bots", version: `protocol-${PROTOCOL_VERSION}` },
      hostCapabilities: {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        sandbox: {
          permissions: {},
          csp: {
            connectDomains: [...view.csp.connectDomains],
            resourceDomains: [...view.csp.resourceDomains],
            frameDomains: [],
            baseUriDomains: [...view.csp.baseUriDomains],
          },
        },
      },
      hostContext: hostContextOf(view, place),
    });

  /** Once the app says it is ready: the call's input, then its answer, or why there is none. */
  const onInitialized = () => {
    if (initialized) return;
    initialized = true;
    notify("ui/notifications/tool-input", { arguments: view.input });
    if (view.result === null) {
      notify("ui/notifications/tool-cancelled", {
        reason: "J3 Bots did not keep this call's answer for the app.",
      });
    } else {
      notify("ui/notifications/tool-result", view.result);
    }
  };

  const request = (id: RequestId, method: string, params: unknown) => {
    switch (method) {
      case "ui/initialize":
        return initialize(id);
      case "ping":
        return result(id, {});
      case "tools/call":
        return void callTool(id, params);
      case "resources/read":
        return void readResource(id, params);
      case "ui/open-link":
        return void openLink(id, params);
      case "ui/message":
        return void message(id, params);
      case "ui/request-display-mode":
        return result(id, { mode: "inline" });
      case "ui/update-model-context":
        return error(id, DENIED, "Context update denied");
      default:
        return error(id, METHOD_NOT_FOUND, "Method not found");
    }
  };

  const notification = (method: string, params: unknown) => {
    switch (method) {
      case "ui/notifications/initialized":
        return onInitialized();
      case "ui/notifications/size-changed": {
        const size = decodeSize(params);
        if (Option.isSome(size) && size.value.height !== undefined && size.value.height > 0) {
          options.onHeight(clampConnectorAppHeight(size.value.height));
        }
        return;
      }
      default:
        // A log line (`notifications/message`) and anything else: read by nobody.
        return;
    }
  };

  const receive = (data: unknown) => {
    if (closed) return;
    const asRequest = decodeRequest(data);
    if (Option.isSome(asRequest)) {
      return request(asRequest.value.id, asRequest.value.method, asRequest.value.params);
    }
    // An answer the app sends (to `ui/resource-teardown`) asks nothing of the host.
    const asNotification = decodeNotification(data);
    if (Option.isSome(asNotification)) {
      notification(asNotification.value.method, asNotification.value.params);
    }
  };

  const placeChanged = (next: ConnectorAppPlace) => {
    place = next;
    if (initialized) notify("ui/notifications/host-context-changed", placeContext(next));
  };

  const teardown = (reason: string) => {
    if (closed) return;
    if (initialized) {
      send({
        jsonrpc: "2.0",
        id: "j3-teardown",
        method: "ui/resource-teardown",
        params: { reason },
      });
    }
    closed = true;
  };

  return { receive, placeChanged, teardown };
};
