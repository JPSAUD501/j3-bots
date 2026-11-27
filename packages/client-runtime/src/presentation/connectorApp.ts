// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalTimers:off -- the host answers its frame from the platform's message events, outside any Effect program.
import {
  CONNECTOR_APP_WIDEST_POLICY,
  type ConnectorAppAnswer,
  ConnectorAppContext,
  type ConnectorAppContextOutcome,
  type ConnectorAppCsp,
  type ConnectorAppRefusal,
  type ConnectorAppView,
  type ConnectorAppViewId,
  connectorAppContentPolicy,
  fitsUtf8,
  MAX_CONNECTOR_APP_DATA_BYTES,
  MCP_APPS_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  visualEscapesGuard,
} from "@j3-bots/contracts";
import { appStyleVariables } from "@j3-bots/design-tokens";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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

/** The shortest an app's frame is drawn, in CSS pixels. */
export const MIN_CONNECTOR_APP_HEIGHT = 80;

/**
 * The tallest an app's frame is drawn in the bot's reply, in CSS pixels:
 * compact, so the reply reads on past it. The operator expands an app that
 * wants more room.
 */
export const MAX_CONNECTOR_APP_INLINE_HEIGHT = 560;

/** The tallest an app's frame is drawn pinned at the top of the conversation (`pip`). */
export const MAX_CONNECTOR_APP_PIP_HEIGHT = 240;

/** The height an app's frame starts at, before the app reports its own. */
export const CONNECTOR_APP_DEFAULT_HEIGHT = 360;

/** Fits a height an app reports into what its frame is drawn at in the reply. */
export const clampConnectorAppHeight = (height: number): number =>
  Math.min(MAX_CONNECTOR_APP_INLINE_HEIGHT, Math.max(MIN_CONNECTOR_APP_HEIGHT, Math.ceil(height)));

/**
 * The last height each app reported, while the client runs: a frame drawn
 * again (scrolled back to, reopened, moved between modes) starts at the size
 * the app last had, so the reply does not jump as it loads.
 */
const lastHeights = new Map<ConnectorAppViewId, number>();

/** The height an app's frame starts at: the one it last reported, or the default. */
export const connectorAppStartHeight = (viewId: ConnectorAppViewId): number =>
  lastHeights.get(viewId) ?? CONNECTOR_APP_DEFAULT_HEIGHT;

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

/** The most files one `ui/download-file` may hold. */
export const MAX_CONNECTOR_APP_DOWNLOADS = 8;

/** The most bytes the files of one `ui/download-file` may hold together. */
export const MAX_CONNECTOR_APP_DOWNLOAD_BYTES = 16 * 1024 * 1024;

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
/** The app's answer to a request of the host's: only `ui/resource-teardown` is one. */
const AppResponse = Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: RequestId });
const decodeRequest = Schema.decodeUnknownOption(AppRequest);
const decodeNotification = Schema.decodeUnknownOption(AppNotification);
const decodeResponse = Schema.decodeUnknownOption(AppResponse);

/** How a host shows an app (`McpUiDisplayMode`). */
export const ConnectorAppDisplayMode = Schema.Literals(["inline", "fullscreen", "pip"]);
export type ConnectorAppDisplayMode = typeof ConnectorAppDisplayMode.Type;

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
/** What the app says of itself in `ui/initialize`: only the modes it can be shown in are read. */
const InitializeParams = Schema.Struct({
  appCapabilities: Schema.optionalKey(
    Schema.Struct({ availableDisplayModes: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
});
const DisplayModeParams = Schema.Struct({ mode: ConnectorAppDisplayMode });
const ContextParams = Schema.Struct({
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const EmbeddedFile = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Union([
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.optionalKey(Schema.String),
      text: Schema.String,
    }),
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.optionalKey(Schema.String),
      blob: Schema.String,
    }),
  ]),
});
const LinkedFile = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
});
const DownloadParams = Schema.Struct({
  contents: Schema.Array(Schema.Union([EmbeddedFile, LinkedFile])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CONNECTOR_APP_DOWNLOADS),
  ),
});

const decodeToolCall = Schema.decodeUnknownOption(ToolCallParams);
const decodeRead = Schema.decodeUnknownOption(ReadParams);
const decodeLink = Schema.decodeUnknownOption(LinkParams);
const decodeMessage = Schema.decodeUnknownOption(MessageParams);
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock);
const decodeSize = Schema.decodeUnknownOption(SizeParams);
const decodeInitialize = Schema.decodeUnknownOption(InitializeParams);
const decodeDisplayMode = Schema.decodeUnknownOption(DisplayModeParams);
const decodeMode = Schema.decodeUnknownOption(ConnectorAppDisplayMode);
const decodeContextParams = Schema.decodeUnknownOption(ContextParams);
const decodeContext = Schema.decodeUnknownOption(ConnectorAppContext);
const decodeDownload = Schema.decodeUnknownOption(DownloadParams);

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

/** How an app is shown now, and the room its frame has there. */
export type ConnectorAppDisplay =
  /** In the bot's reply: its height follows the app, up to `MAX_CONNECTOR_APP_INLINE_HEIGHT`. */
  | { readonly mode: "inline"; readonly width: number }
  /** Pinned at the top of the conversation: up to `MAX_CONNECTOR_APP_PIP_HEIGHT`. */
  | { readonly mode: "pip"; readonly width: number }
  /** Over the conversation, or the whole screen on a phone: the frame has all of it. */
  | { readonly mode: "fullscreen"; readonly width: number; readonly height: number };

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
  readonly display: ConnectorAppDisplay;
  /**
   * The modes this client can show an app in: `inline` always, and the
   * others where it has room for them.
   */
  readonly modes: ReadonlyArray<ConnectorAppDisplayMode>;
}

/** A tool call the app asked for: allowed or not, and what came of it. */
export type ConnectorAppAsk = "allowed" | "declined";

/** A file an app offers the operator (`ui/download-file`): its content, or an address to fetch it from. */
export type ConnectorAppDownload =
  | {
      readonly _tag: "file";
      /** A file name, with no folder in it, safe to save under. */
      readonly name: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }
  | { readonly _tag: "link"; readonly name: string; readonly url: URL };

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
   * Keeps what the app sets as context for its bot (`connectorApp.setContext`);
   * null when the server could not be reached. Asked only when the server
   * offers it (`ConnectorAppView.modelContext`).
   */
  readonly setContext: (context: ConnectorAppContext) => Promise<ConnectorAppContextOutcome | null>;
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
  /**
   * Shows the operator the files the app offers; true once they saved them,
   * false when they put them aside. Nothing is saved unless they press it.
   */
  readonly download: (files: ReadonlyArray<ConnectorAppDownload>) => Promise<boolean>;
  /**
   * Shows the app in `mode`, which this client has (`place.modes`) and the
   * app can be shown in, and returns the mode it is shown in now. Another
   * app shown that way goes back to the reply. The client tells the host of
   * the new place (`placeChanged`).
   */
  readonly setDisplayMode: (mode: ConnectorAppDisplayMode) => ConnectorAppDisplayMode;
  /** The modes the app can be shown in here, once it said which it has: the client offers those. */
  readonly onModes: (modes: ReadonlyArray<ConnectorAppDisplayMode>) => void;
  /** The height the app reports for its content, fitted to what the frame is drawn at in the reply. */
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
  /** Tells the app what changed of where it is drawn, once it is initialized. */
  readonly placeChanged: (place: ConnectorAppPlace) => void;
  /**
   * Tells the app it is going away (`ui/resource-teardown`). Settles once the
   * app answered, or after `CONNECTOR_APP_TEARDOWN_WAIT` ms: a client that can
   * keep the frame until then does, so the app may save its state. Nothing is
   * sent to it, and nothing it sends is read, afterwards.
   */
  readonly teardown: (reason: string) => Promise<void>;
}

/** How long a client keeps an app's frame for its answer to `ui/resource-teardown`, in ms. */
export const CONNECTOR_APP_TEARDOWN_WAIT = 1_000;

/** The id of the host's one request to the app. */
const TEARDOWN_ID = "j3-teardown";

/** Why J3 Bots did not pass on a request, as the app reads it in its error. */
const REFUSAL_MESSAGE: Readonly<Record<ConnectorAppRefusal, string>> = {
  gone: "The connector was removed, or the bot no longer has it.",
  "not-for-apps": "The connector does not let apps call that tool.",
  unavailable: "The connector is not connected, or did not answer.",
  "too-large": "The request or its answer is too large to pass on.",
  "needs-allow": "The operator did not allow this call.",
};

const containerOf = (display: ConnectorAppDisplay): Schema.JsonObject => {
  const width = Math.round(display.width);
  switch (display.mode) {
    case "inline":
      return { width, maxHeight: MAX_CONNECTOR_APP_INLINE_HEIGHT };
    case "pip":
      return { width, maxHeight: MAX_CONNECTOR_APP_PIP_HEIGHT };
    case "fullscreen":
      return { width, height: Math.round(display.height) };
  }
};

/**
 * Where the app is drawn, as `hostContext` says it. The frame always sits
 * inside the screen's safe area, under any bar or notch, so it has no inset.
 */
const placeContext = (place: ConnectorAppPlace): Schema.JsonObject => ({
  theme: place.appearance,
  styles: {
    variables: { ...appStyleVariables(place.appearance, place.touch ? "touch" : "pointer") },
  },
  displayMode: place.display.mode,
  availableDisplayModes: [...place.modes],
  containerDimensions: containerOf(place.display),
  locale: place.locale,
  timeZone: place.timeZone,
  platform: place.platform,
  deviceCapabilities: { touch: place.touch, hover: place.hover },
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  userAgent: `j3-bots/protocol-${PROTOCOL_VERSION} (${place.platform})`,
});

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
});

/** The fields of `next` that differ from `previous`: what `host-context-changed` carries. */
const changedFields = (previous: Schema.JsonObject, next: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value),
    ),
  );

/** The text of a message's content: its text blocks, in order. */
const textOf = (blocks: ReadonlyArray<unknown>): string =>
  blocks
    .flatMap((block) => Option.toArray(decodeTextBlock(block)))
    .map((block) => block.text)
    .join("\n\n")
    .trim();

/** The text of a `ui/message`'s content, one block or many. */
const messageText = (content: unknown): string =>
  textOf(Array.isArray(content) ? content : [content]);

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

/** Whether a file name may hold `char`: not a control character, nor one that names a folder or a device. */
const safeInName = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code > 0x1f && code !== 0x7f && !'/\\:*?"<>|'.includes(char);
};

/**
 * A file name safe to save under, from what the app named it: the last part
 * of its address, without anything that would reach another folder, or
 * "download" when nothing is left.
 */
export const connectorAppFileName = (named: string): string => {
  const last = named.split(/[/\\]/).filter((part) => part !== "").at(-1) ?? "";
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // An address with a stray `%`: kept as written.
  }
  const safe = Array.from(decoded)
    .filter(safeInName)
    .join("")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 128);
  return safe === "" ? "download" : safe;
};

/** The files of a `ui/download-file`, or null when one of them cannot be offered. */
const downloadsOf = (params: unknown): ReadonlyArray<ConnectorAppDownload> | null => {
  const decoded = decodeDownload(params);
  if (Option.isNone(decoded)) return null;
  const files: Array<ConnectorAppDownload> = [];
  let bytes = 0;
  for (const item of decoded.value.contents) {
    if (item.type === "resource_link") {
      const url = linkOf(item.uri);
      if (url === null) return null;
      files.push({ _tag: "link", name: connectorAppFileName(item.name), url });
      continue;
    }
    const { resource } = item;
    const content =
      "text" in resource
        ? Option.some(new TextEncoder().encode(resource.text))
        : Result.getSuccess(Base64.decode(resource.blob));
    if (Option.isNone(content)) return null;
    bytes += content.value.byteLength;
    if (bytes > MAX_CONNECTOR_APP_DOWNLOAD_BYTES) return null;
    files.push({
      _tag: "file",
      name: connectorAppFileName(resource.uri),
      mediaType: resource.mimeType ?? "application/octet-stream",
      bytes: content.value,
    });
  }
  return files;
};

/**
 * The host side of the protocol for one drawn app. It answers the app's
 * `ui/initialize` with J3 Bots' capabilities and where the app is drawn, and
 * once the app says it is initialized, gives it the tool's input and its
 * answer. It passes on the app's `tools/call` and `resources/read` to its
 * own connector, through J3 Bots, asking the operator first when the bot's
 * permission mode asks for its own calls; it takes a `ui/message` as a
 * message the operator may send, an `ui/open-link` as a link they may open,
 * a `ui/download-file` as files they may save, a `ui/update-model-context`
 * as context for its bot, a `ui/request-display-mode` as a mode the client
 * shows it in when it can, and a `ui/notifications/size-changed` as the
 * frame's height. It sends the app nothing but answers before it is
 * initialized, as the extension asks; after, each change of where it is
 * drawn, as the fields that changed.
 */
export const connectorAppHost = (options: ConnectorAppHostOptions): ConnectorAppHost => {
  const { view } = options;
  let place = options.place;
  /** Where the app was told it is drawn: in its `ui/initialize` answer, then each change. */
  let told: Schema.JsonObject | null = null;
  /** Whether the app said it is initialized, after which the host tells it of changes. */
  let ready = false;
  /** The modes the app said it can be shown in, or null when it named none. */
  let appModes: ReadonlyArray<ConnectorAppDisplayMode> | null = null;
  let closed = false;
  let answeredTeardown: (() => void) | null = null;
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

  /** The modes the app may be shown in here: the client's, of those the app has. */
  const showable = (): ReadonlyArray<ConnectorAppDisplayMode> =>
    place.modes.filter((mode) => appModes === null || appModes.includes(mode));

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

  const download = async (id: RequestId, params: unknown) => {
    const files = downloadsOf(params);
    if (files === null) return error(id, INVALID_PARAMS, "Invalid content");
    if (await options.download(files)) return result(id, {});
    error(id, DENIED, "Download denied by user");
  };

  const displayMode = (id: RequestId, params: unknown) => {
    const requested = decodeDisplayMode(params);
    if (Option.isNone(requested)) return error(id, INVALID_PARAMS, "Unknown display mode");
    const { mode } = requested.value;
    // A mode this client or the app lacks: the app stays as it is.
    if (mode === place.display.mode || !showable().includes(mode)) {
      return result(id, { mode: place.display.mode });
    }
    result(id, { mode: options.setDisplayMode(mode) });
  };

  const updateContext = async (id: RequestId, params: unknown) => {
    if (view.modelContext !== true) return error(id, DENIED, "Context update denied");
    const decoded = decodeContextParams(params);
    if (Option.isNone(decoded)) return error(id, INVALID_PARAMS, "Invalid context");
    const blocks = decoded.value.content ?? [];
    // Text and structured content only, as `hostCapabilities` says.
    if (blocks.some((block) => Option.isNone(decodeTextBlock(block)))) {
      return error(id, INVALID_PARAMS, "J3 Bots takes text and structured content as context.");
    }
    const context = decodeContext({
      text: textOf(blocks),
      structured: decoded.value.structuredContent ?? null,
    });
    if (Option.isNone(context)) return error(id, DENIED, REFUSAL_MESSAGE["too-large"]);
    const outcome = await options.setContext(context.value);
    if (outcome === null) return error(id, INTERNAL_ERROR, "J3 Bots could not reach its server.");
    if (outcome._tag === "refused") return error(id, DENIED, REFUSAL_MESSAGE[outcome.reason]);
    result(id, {});
  };

  const initialize = (id: RequestId, params: unknown) => {
    const declared = Option.flatMap(decodeInitialize(params), (init) =>
      Option.fromNullishOr(init.appCapabilities?.availableDisplayModes),
    );
    appModes = Option.isSome(declared)
      ? declared.value.flatMap((mode) => Option.toArray(decodeMode(mode)))
      : null;
    told = placeContext(place);
    result(id, {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      // The protocol J3 Bots' clients speak with its server names which J3 Bots this is.
      hostInfo: { name: "j3-bots", version: `protocol-${PROTOCOL_VERSION}` },
      hostCapabilities: {
        openLinks: {},
        downloadFile: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        message: { text: {} },
        ...(view.modelContext === true
          ? { updateModelContext: { text: {}, structuredContent: {} } }
          : {}),
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
  };

  /** Tells the app what changed of where it is drawn since it was last told. */
  const tellChanges = () => {
    const context = placeContext(place);
    // An app that skipped `ui/initialize` asked for none of it.
    const changed = told === null ? {} : changedFields(told, context);
    told = context;
    if (Object.keys(changed).length > 0) notify("ui/notifications/host-context-changed", changed);
  };

  /**
   * Once the app says it is ready: what changed of where it is drawn since
   * its `ui/initialize`, then the call's input, then its answer, or why
   * there is none.
   */
  const onInitialized = () => {
    if (ready) return;
    ready = true;
    tellChanges();
    options.onModes(showable());
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
        return initialize(id, params);
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
      case "ui/download-file":
        return void download(id, params);
      case "ui/request-display-mode":
        return displayMode(id, params);
      case "ui/update-model-context":
        return void updateContext(id, params);
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
          const height = clampConnectorAppHeight(size.value.height);
          lastHeights.set(view.viewId, height);
          options.onHeight(height);
        }
        return;
      }
      case "ui/notifications/request-teardown":
        // The app asks to be closed: the operator closes it, from the client's own controls.
        return;
      default:
        // A log line (`notifications/message`) and anything else: read by nobody.
        return;
    }
  };

  const receive = (data: unknown) => {
    if (closed) {
      if (answeredTeardown !== null) {
        const response = decodeResponse(data);
        if (Option.isSome(response) && response.value.id === TEARDOWN_ID) answeredTeardown();
      }
      return;
    }
    const asRequest = decodeRequest(data);
    if (Option.isSome(asRequest)) {
      return request(asRequest.value.id, asRequest.value.method, asRequest.value.params);
    }
    const asNotification = decodeNotification(data);
    if (Option.isSome(asNotification)) {
      notification(asNotification.value.method, asNotification.value.params);
    }
  };

  const placeChanged = (next: ConnectorAppPlace) => {
    const modesBefore = showable().join();
    place = next;
    if (!ready) return;
    tellChanges();
    if (showable().join() !== modesBefore) options.onModes(showable());
  };

  const teardown = (reason: string): Promise<void> => {
    if (closed) return Promise.resolve();
    if (!ready) {
      closed = true;
      return Promise.resolve();
    }
    send({ jsonrpc: "2.0", id: TEARDOWN_ID, method: "ui/resource-teardown", params: { reason } });
    closed = true;
    return new Promise<void>((resolve) => {
      const done = () => {
        answeredTeardown = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, CONNECTOR_APP_TEARDOWN_WAIT);
      answeredTeardown = done;
    });
  };

  return { receive, placeChanged, teardown };
};
