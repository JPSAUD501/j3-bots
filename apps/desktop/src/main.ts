// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConnectRequest,
  type ConnectResult,
  DesktopState,
  IPC_CHANNELS,
} from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Mime from "effect/http/Mime";
import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  net,
  protocol,
  screen,
  session,
  shell,
  type WebContents,
} from "electron";
import { contentSecurityPolicy, inlineScriptSources, resolveAsset } from "./assets.ts";
import { APP_ID, appOrigin, schemeOf } from "./identity.ts";
import { externalUrl, isAppUrl } from "./navigation.ts";
import { parseServerAddress } from "./serverAddress.ts";
import { checkServer } from "./serverCheck.ts";
import * as Settings from "./settings.ts";
import { MIN_SIZE, openingBounds } from "./window.ts";

// The desktop app: a window on the web client's own build, served from a
// privileged custom scheme, which reaches the server the operator named at
// that server's origin (decision 0012).

const APP_ORIGIN = appOrigin(app.isPackaged);
const SCHEME = schemeOf(APP_ORIGIN);

/** What a page may ask for: showing notifications and writing to the clipboard. */
const PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);

// Before `ready`, as Electron requires. `standard` and `secure` make the page
// a secure context with a real origin, so Web Locks, BroadcastChannel and
// IndexedDB behave as on an HTTPS site (as T3 Code registers its own scheme).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// A packaged build and a development one keep separate profiles.
app.setPath(
  "userData",
  `${app.getPath("appData")}/${app.isPackaged ? "J3 Bots" : "J3 Bots Development"}`,
);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const encodeState = Schema.encodeSync(DesktopState);
const decodeConnectRequest = Schema.decodeUnknownOption(ConnectRequest);

/** Whether an IPC message comes from the top frame of one of the app's own pages. */
const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  event.senderFrame !== null &&
  event.senderFrame === event.sender.mainFrame &&
  isAppUrl(event.senderFrame.url, APP_ORIGIN);

/** Keeps every web contents on the app's pages, and sends links out to the system. */
const lockNavigation = (contents: WebContents) => {
  const stay = (event: { preventDefault: () => void }, url: string) => {
    if (!isAppUrl(url, APP_ORIGIN)) event.preventDefault();
  };
  contents.on("will-navigate", stay);
  contents.on("will-redirect", stay);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external !== null) void shell.openExternal(external);
    return { action: "deny" };
  });
};

const program = Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* Settings.DesktopSettings;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);

  // The web client's build, from the same checkout in development.
  const webRoot = yield* fs.realPath(path.join(app.getAppPath(), "..", "web", "dist"));
  const indexHtml = yield* fs.readFileString(path.join(webRoot, "index.html"));
  const scriptSources = yield* Effect.promise(() => inlineScriptSources(indexHtml));

  const serveFile = Effect.fn("desktop.serveFile")(
    function* (request: Request) {
      const answer = resolveAsset(
        { url: request.url, method: request.method, accept: request.headers.get("accept") },
        APP_ORIGIN,
      );
      if (answer._tag === "refused") return new Response(null, { status: answer.status });
      const { server } = yield* settings.get;
      const headers = {
        "content-security-policy": contentSecurityPolicy(server, scriptSources),
        "x-content-type-options": "nosniff",
      };
      // The file's real path, links resolved, must lie inside the build.
      const found = yield* fs.realPath(path.join(webRoot, ...answer.segments)).pipe(
        Effect.flatMap((real) =>
          real.startsWith(`${webRoot}${path.sep}`)
            ? fs.stat(real).pipe(Effect.map((info) => (info.type === "File" ? real : null)))
            : Effect.succeed(null),
        ),
        Effect.orElseSucceed(() => null),
      );
      const file = found ?? (answer.appShell ? path.join(webRoot, "index.html") : null);
      if (file === null) return new Response(null, { status: 404, headers });
      const body = yield* fs.readFile(file);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(body), {
        headers: {
          ...headers,
          "content-type": Option.getOrElse(Mime.getType(file), () => "application/octet-stream"),
        },
      });
    },
    Effect.orElseSucceed(() => new Response(null, { status: 500 })),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() => protocol.handle(SCHEME, (request) => runPromise(serveFile(request)))),
    () => Effect.sync(() => protocol.unhandle(SCHEME)),
  );

  const connect = Effect.fn("desktop.connect")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Effect.fn.Return<ConnectResult, never, never> {
    const decoded = decodeConnectRequest(request);
    // Only the server address screen connects, and only while no server is
    // kept: a page that knows a server must forget it first, which erases
    // its storage, so a device token never reaches another server.
    if (!fromApp(event) || Option.isNone(decoded) || (yield* settings.get).server !== null) {
      return { _tag: "refused", reason: "invalid" };
    }
    const parsed = parseServerAddress(decoded.value.address);
    if (Result.isFailure(parsed)) return { _tag: "refused", reason: parsed.failure };
    const refusal = yield* checkServer(parsed.success).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        net.fetch(input instanceof URL ? input.href : input, init),
      ),
    );
    if (refusal !== null) return { _tag: "refused", reason: refusal };
    yield* settings.update((current) => ({ ...current, server: parsed.success }));
    return { _tag: "connected", server: parsed.success };
  });

  const forgetServer = Effect.fn("desktop.forgetServer")(function* (event: IpcMainInvokeEvent) {
    if (!fromApp(event)) return null;
    // What the page kept for the server it leaves goes with it: the
    // credential, drafts and unsent messages, all in IndexedDB. Preferences
    // in local storage (appearance, language) belong to the device and stay.
    yield* Effect.promise(() => event.sender.session.clearStorageData({ storages: ["indexdb"] }));
    yield* settings.update((current) => ({ ...current, server: null }));
    event.sender.reload();
    return null;
  });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.on(IPC_CHANNELS.state, (event) => {
        event.returnValue = fromApp(event)
          ? encodeState({ server: runSync(settings.get).server })
          : null;
      });
      ipcMain.handle(IPC_CHANNELS.connect, (event, request: unknown) =>
        runPromise(connect(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.forgetServer, (event) => runPromise(forgetServer(event)));
    }),
    () =>
      Effect.sync(() => {
        ipcMain.removeAllListeners(IPC_CHANNELS.state);
        ipcMain.removeHandler(IPC_CHANNELS.connect);
        ipcMain.removeHandler(IPC_CHANNELS.forgetServer);
      }),
  );

  session.defaultSession.setPermissionRequestHandler((_contents, permission, grant, details) =>
    grant(PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl, APP_ORIGIN)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      PERMISSIONS.has(permission) && isAppUrl(requestingOrigin, APP_ORIGIN),
  );
  app.on("web-contents-created", (_event, contents) => lockNavigation(contents));

  const placed = openingBounds(
    (yield* settings.get).window,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    ...placed.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "J3 Bots",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  if (placed.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());

  // The window's place is saved as it closes, before it goes.
  let saved = false;
  window.on("close", (event) => {
    if (saved) return;
    event.preventDefault();
    const bounds = window.getNormalBounds();
    const state = { ...bounds, maximized: window.isMaximized() };
    void runPromise(settings.update((current) => ({ ...current, window: state }))).finally(() => {
      saved = true;
      window.close();
    });
  });

  app.on("second-instance", () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());

  yield* Effect.promise(() => window.loadURL(`${APP_ORIGIN}/`));
  return yield* Effect.never;
});

// One app per profile: a second launch brings the first one's window forward.
if (app.requestSingleInstanceLock()) {
  NodeRuntime.runMain(
    program.pipe(
      Effect.scoped,
      Effect.provide(
        Settings.layer(`${app.getPath("userData")}/desktop.json`).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
} else {
  app.quit();
}
