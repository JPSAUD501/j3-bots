// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConnectRequest,
  type ConnectResult,
  DesktopState,
  type ForgetResult,
  IPC_CHANNELS,
  LocalDeviceRequest,
  LocalDeviceResult,
  LocalPairingLink,
  LocalPairingRequest,
  LocalServerState,
  type ModeChange,
  type UseThisComputerResult,
  NetworkState,
  OpenRequest,
  type OpenResult,
  PhoneAccess,
  PhoneAccessChange,
  PhoneAccessRequest,
  SealRequest,
  type SealResult,
  SecretCopy,
} from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Mime from "effect/http/Mime";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  type WebContents,
} from "electron";
import { secretClipboard } from "@j3-bots/client-runtime/presentation";
import { desktopIcon, renderAppIcon } from "@j3-bots/design-tokens/raster";
import * as Appearance from "./appearance.ts";
import * as AppLinks from "./appLinks.ts";
import * as Autostart from "./autostart.ts";
import { inlineScriptSources, policyFor, resolveAsset } from "./assets.ts";
import { electronFetch } from "./electronFetch.ts";
import { APP_ID, appOrigin, schemeOf } from "./identity.ts";
import * as LinkHandler from "./linkHandler.ts";
import * as LocalHost from "./localServer/localHost.ts";
import * as PhoneAccessControl from "./localServer/phoneAccess.ts";
import { quitGate } from "./localServer/quitGate.ts";
import { thisComputer } from "./localServer/thisComputer.ts";
import * as Menus from "./menus.ts";
import { externalUrl, isAppUrl, isFrameUrl } from "./navigation.ts";
import * as Notifier from "./notifier.ts";
import * as SignInRelay from "./signInRelay.ts";
import * as ServerChoice from "./serverChoice.ts";
import { checkServer } from "./serverCheck.ts";
import * as Settings from "./settings.ts";
import { makeTokenSeal } from "./tokenSeal.ts";
import * as Updater from "./updater.ts";
import { MIN_SIZE, openingBounds } from "./window.ts";

// The desktop app: a window on the web client's own build, served from a
// privileged custom scheme, which reaches the server the operator named at
// that server's origin (decision 0012).

const APP_ORIGIN = appOrigin(app.isPackaged);
const SCHEME = schemeOf(APP_ORIGIN);
/** Links to the app, taken from as early as the system hands them over. */
const links = AppLinks.start(SCHEME);

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
const encodeNetwork = Schema.encodeSync(NetworkState);
const decodeConnectRequest = Schema.decodeUnknownOption(ConnectRequest);
const decodeSealRequest = Schema.decodeUnknownOption(SealRequest);
const decodeSecretCopy = Schema.decodeUnknownOption(SecretCopy);
const decodeOpenRequest = Schema.decodeUnknownOption(OpenRequest);
const decodeLocalDeviceRequest = Schema.decodeUnknownOption(LocalDeviceRequest);
const decodePhoneAccessRequest = Schema.decodeUnknownOption(PhoneAccessRequest);
const decodePairingRequest = Schema.decodeUnknownOption(LocalPairingRequest);
const encodeLocalDevice = Schema.encodeSync(LocalDeviceResult);
const encodeLocalServer = Schema.encodeSync(Schema.NullOr(LocalServerState));
const encodePhoneAccess = Schema.encodeSync(PhoneAccess);
const encodePhoneAccessChange = Schema.encodeSync(PhoneAccessChange);
const encodePairingLink = Schema.encodeSync(LocalPairingLink);

/** Whether the system has a network, as the page is told. */
const networkState = () => encodeNetwork({ online: net.isOnline() });

/** Whether an IPC message comes from the top frame of one of the app's own pages. */
const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  event.senderFrame !== null &&
  event.senderFrame === event.sender.mainFrame &&
  isAppUrl(event.senderFrame.url, APP_ORIGIN);

/** Whether a failed load was cut short by another navigation. */
const isAborted = (error: unknown): boolean =>
  error instanceof Error && Reflect.get(error, "code") === "ERR_ABORTED";

/** The page that sent `event`, as the server choice acts on it. */
const pageOf = (event: IpcMainInvokeEvent): ServerChoice.Page => ({
  // The credential, drafts and unsent messages, all in IndexedDB. Preferences
  // in local storage (appearance, language) belong to the device and stay.
  clearStorage: Effect.tryPromise({
    try: () => event.sender.session.clearStorageData({ storages: ["indexdb"] }),
    catch: (cause) => new ServerChoice.StorageNotCleared({ cause }),
  }),
  // Not awaited: the page that asked is the one going away. A load the page
  // cuts short by navigating first (`ERR_ABORTED`) leaves it where it went;
  // any other failure is logged.
  openHome: Effect.forkDetach(
    Effect.promise(() =>
      event.sender.loadURL(`${APP_ORIGIN}/`).then(
        () => null,
        (error: unknown) => ({ error }),
      ),
    ).pipe(
      Effect.flatMap((notLoaded) =>
        notLoaded === null || isAborted(notLoaded.error)
          ? Effect.void
          : Effect.logError("Opening the app's first page failed", notLoaded.error),
      ),
    ),
  ).pipe(Effect.asVoid),
});

/**
 * Brings the app's window forward, once there is one. Until then, a second
 * launch is remembered and the window is focused as it first shows.
 */
let bringForward: (() => void) | null = null;
let launchedWhileStarting = false;

/** Keeps every web contents on the app's pages, and sends links out to the system. */
const lockNavigation = (contents: WebContents) => {
  const stay = (event: { preventDefault: () => void }, url: string) => {
    if (!isAppUrl(url, APP_ORIGIN)) event.preventDefault();
  };
  contents.on("will-navigate", stay);
  contents.on("will-redirect", stay);
  // A frame inside the page: only a bot's visual or a connector's app, each
  // in its page of the app. Whatever either does then, it does not take its
  // frame anywhere else.
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isFrameUrl(event.url, APP_ORIGIN)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external !== null) void shell.openExternal(external);
    return { action: "deny" };
  });
};

const program = Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady());
  // Started by the system as the operator signed in: the app opens in the
  // tray, its window shown only when they ask for it.
  const hidden = Autostart.launchedHidden();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* Settings.DesktopSettings;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);

  // The web client's build, from the same checkout in development.
  const webRoot = yield* fs.realPath(path.join(app.getAppPath(), "..", "web", "dist"));
  /** The real path of `segments` in the build: a regular file inside it, or `null`. */
  const fileInBuild = (segments: ReadonlyArray<string>) =>
    fs.realPath(path.join(webRoot, ...segments)).pipe(
      Effect.flatMap((real) =>
        real.startsWith(`${webRoot}${path.sep}`)
          ? fs.stat(real).pipe(Effect.map((info) => (info.type === "File" ? real : null)))
          : Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );
  // The app shell, resolved once: what the CSP's hashes are taken from is what is served.
  const appShell = yield* fileInBuild(["index.html"]);
  if (appShell === null) return yield* Effect.die("The web client's build has no index.html.");
  const indexHtml = yield* fs.readFileString(appShell);
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
        "content-security-policy": policyFor(answer.segments, server, scriptSources),
        "x-content-type-options": "nosniff",
      };
      // The file's real path, links resolved, must lie inside the build.
      const found = yield* fileInBuild(answer.segments);
      const file = found ?? (answer.appShell ? appShell : null);
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

  // The server this computer runs for its bots, in local mode.
  const computer = thisComputer();
  const localHost = yield* LocalHost.make({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
    webClient: webRoot,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDirectory: app.getPath("home"),
    hostname: computer.hostname,
    loginShell: computer.loginShell,
  });
  const { supervisor } = localHost;
  /** The server this computer runs, as the page and the tray are told: `null` outside local mode. */
  const localServerNow = Effect.gen(function* () {
    if ((yield* settings.get).mode !== "local") return null;
    return yield* localHost.state;
  });
  const localServerChanges = localHost.changes.pipe(Stream.mapEffect(() => localServerNow));

  const choice = yield* ServerChoice.make(
    (origin) =>
      checkServer(origin).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, electronFetch),
      ),
    localHost.local,
  );

  // Phones on this computer's network reaching its server. A move of the
  // server is one step with the changes of where the bots live: it never
  // starts a server the operator just left.
  const phone = yield* PhoneAccessControl.serve({
    listening: localHost.phone,
    supervisor,
    whileLocal: choice.whileLocal,
  });

  const setPhoneAccess = Effect.fn("desktop.setPhoneAccess")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ) {
    const decoded = decodePhoneAccessRequest(request);
    if (!fromApp(event) || Option.isNone(decoded)) return null;
    return encodePhoneAccessChange(yield* phone.set(decoded.value));
  });

  const localPairingLink = Effect.fn("desktop.localPairingLink")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ) {
    const decoded = decodePairingRequest(request);
    if (!fromApp(event) || Option.isNone(decoded)) return null;
    return encodePairingLink(yield* phone.pairingLink(decoded.value.unlock));
  });

  const connect = Effect.fn("desktop.connect")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Effect.fn.Return<ConnectResult> {
    const decoded = decodeConnectRequest(request);
    // Only the server address screen connects.
    if (!fromApp(event) || Option.isNone(decoded)) return { _tag: "refused", reason: "invalid" };
    const { address, pairing } = decoded.value;
    const result = yield* choice.connect(address, pageOf(event));
    if (result._tag === "connected" && pairing !== undefined) links.carry(pairing);
    return result;
  });

  const tokens = makeTokenSeal();

  // The main process copies a secret's value, not the page: it alone can read
  // the clipboard back, to take the value off only if it is still there.
  const secretCopies = secretClipboard({
    write: (text) => clipboard.writeText(text).then(() => true),
    read: () => clipboard.readText(),
    clear: () => Promise.resolve(clipboard.clear()),
  });

  const sealToken = Effect.fn("desktop.sealToken")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Effect.fn.Return<SealResult> {
    const decoded = decodeSealRequest(request);
    if (!fromApp(event) || Option.isNone(decoded)) return { _tag: "failed" };
    return yield* tokens.seal(decoded.value.token);
  });

  const openToken = Effect.fn("desktop.openToken")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Effect.fn.Return<OpenResult> {
    const decoded = decodeOpenRequest(request);
    // Not opened, which is not the same as opened to something not the app's:
    // only that reads as not paired, and deletes what is kept for the pairing.
    if (!fromApp(event) || Option.isNone(decoded)) return { _tag: "unavailable" };
    return yield* tokens.open(decoded.value.sealed);
  });

  const forgetServer = Effect.fn("desktop.forgetServer")(function* (
    event: IpcMainInvokeEvent,
  ): Effect.fn.Return<ForgetResult> {
    if (!fromApp(event)) return "failed";
    return yield* choice.forget(pageOf(event));
  });

  const useThisComputer = Effect.fn("desktop.useThisComputer")(function* (
    event: IpcMainInvokeEvent,
  ): Effect.fn.Return<UseThisComputerResult> {
    if (!fromApp(event)) return "failed";
    return yield* choice.useThisComputer(pageOf(event));
  });

  const connectToServerInstead = Effect.fn("desktop.connectToServerInstead")(function* (
    event: IpcMainInvokeEvent,
  ): Effect.fn.Return<ModeChange> {
    if (!fromApp(event)) return "failed";
    return yield* choice.connectToServerInstead(pageOf(event));
  });

  // Only the app's own top frame is given a device token.
  const localDevice = Effect.fn("desktop.localDevice")(function* (
    event: IpcMainInvokeEvent,
    request: unknown,
  ) {
    const decoded = decodeLocalDeviceRequest(request);
    if (!fromApp(event) || Option.isNone(decoded)) return encodeLocalDevice({ _tag: "failed" });
    return encodeLocalDevice(yield* localHost.signIn(decoded.value));
  });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.on(IPC_CHANNELS.state, (event) => {
        if (!fromApp(event)) {
          event.returnValue = null;
          return;
        }
        const { server, mode, startWithSystem } = runSync(settings.get);
        event.returnValue = encodeState({
          server,
          pairingCode: links.takeCarriedCode(server),
          mode,
          localAvailable: localHost.available,
          localServer: runSync(localServerNow),
          phoneAccess: runSync(phone.current),
          startWithSystem,
        });
      });
      ipcMain.handle(IPC_CHANNELS.connect, (event, request: unknown) =>
        runPromise(connect(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.forgetServer, (event) => runPromise(forgetServer(event)));
      ipcMain.handle(IPC_CHANNELS.sealToken, (event, request: unknown) =>
        runPromise(sealToken(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.openToken, (event, request: unknown) =>
        runPromise(openToken(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.network, (event) => (fromApp(event) ? networkState() : null));
      ipcMain.handle(IPC_CHANNELS.useThisComputer, (event) => runPromise(useThisComputer(event)));
      ipcMain.handle(IPC_CHANNELS.connectToServerInstead, (event) =>
        runPromise(connectToServerInstead(event)),
      );
      ipcMain.handle(IPC_CHANNELS.localDevice, (event, request: unknown) =>
        runPromise(localDevice(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.localServer, (event) =>
        fromApp(event) ? encodeLocalServer(runSync(localServerNow)) : null,
      );
      ipcMain.on(IPC_CHANNELS.retryLocalServer, (event) => {
        if (fromApp(event)) {
          void runPromise(
            choice.whileLocal(Effect.andThen(phone.tryNetworkAgain, supervisor.retry)),
          );
        }
      });
      ipcMain.on(IPC_CHANNELS.retryServerUpdate, (event) => {
        if (fromApp(event)) void runPromise(choice.whileLocal(localHost.retryUpdate));
      });
      ipcMain.handle(IPC_CHANNELS.setPhoneAccess, (event, request: unknown) =>
        runPromise(setPhoneAccess(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.phoneAccess, (event) =>
        fromApp(event) ? runPromise(phone.refresh.pipe(Effect.map(encodePhoneAccess))) : null,
      );
      ipcMain.handle(IPC_CHANNELS.localPairingLink, (event, request: unknown) =>
        runPromise(localPairingLink(event, request)),
      );
      ipcMain.handle(IPC_CHANNELS.copySecret, (event, request: unknown) => {
        const decoded = decodeSecretCopy(request);
        if (!fromApp(event) || Option.isNone(decoded)) return false;
        return secretCopies.copy(decoded.value.text);
      });
    }),
    () =>
      Effect.sync(() => {
        ipcMain.removeAllListeners(IPC_CHANNELS.state);
        ipcMain.removeHandler(IPC_CHANNELS.connect);
        ipcMain.removeHandler(IPC_CHANNELS.forgetServer);
        ipcMain.removeHandler(IPC_CHANNELS.sealToken);
        ipcMain.removeHandler(IPC_CHANNELS.openToken);
        ipcMain.removeHandler(IPC_CHANNELS.network);
        ipcMain.removeHandler(IPC_CHANNELS.useThisComputer);
        ipcMain.removeHandler(IPC_CHANNELS.connectToServerInstead);
        ipcMain.removeHandler(IPC_CHANNELS.localDevice);
        ipcMain.removeHandler(IPC_CHANNELS.localServer);
        ipcMain.removeAllListeners(IPC_CHANNELS.retryLocalServer);
        ipcMain.removeAllListeners(IPC_CHANNELS.retryServerUpdate);
        ipcMain.removeHandler(IPC_CHANNELS.setPhoneAccess);
        ipcMain.removeHandler(IPC_CHANNELS.phoneAccess);
        ipcMain.removeHandler(IPC_CHANNELS.localPairingLink);
        ipcMain.removeHandler(IPC_CHANNELS.copySecret);
      }),
  );

  // The app's page only, never a frame in it: a bot's visual and a
  // connector's app are on the app's scheme, though sandboxed.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, grant, details) =>
    grant(
      PERMISSIONS.has(permission) &&
        details.isMainFrame &&
        isAppUrl(details.requestingUrl, APP_ORIGIN),
    ),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin, details) =>
      PERMISSIONS.has(permission) && details.isMainFrame && isAppUrl(requestingOrigin, APP_ORIGIN),
  );
  app.on("web-contents-created", (_event, contents) => lockNavigation(contents));

  const placed = openingBounds(
    (yield* settings.get).window,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  // Before the window: its title bar and background take the appearance kept
  // from the last launch, so nothing shows in the other theme before the page paints.
  const appearance = yield* Appearance.start();
  const window = new BrowserWindow({
    ...placed.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "J3 Bots",
    backgroundColor: appearance.windowBackground(),
    // Linux shows the window with the icon it is given. Windows takes the
    // executable's, the icon file with each size it draws; macOS the bundle's.
    ...(process.platform === "linux"
      ? { icon: nativeImage.createFromBuffer(Buffer.from(renderAppIcon(desktopIcon(256)))) }
      : {}),
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
  yield* Appearance.serve({ window, appearance, fromApp });
  // A restart the page asks for, as once a keyring is unlocked (Chromium
  // keeps the encryption it set up for the process, so only a new one sees
  // the unlocked keyring), is the updater's: it may be into an update.
  const updates = yield* Updater.serve(window, fromApp, {
    beforeInstall: supervisor.stop,
    installFailed: Effect.gen(function* () {
      if ((yield* settings.get).mode === "local") yield* supervisor.start;
    }),
  });
  yield* Autostart.serve(fromApp);

  // Quit, from the tray, the menu or the system, waits for the server this
  // computer runs to stop; nothing is left running behind the app.
  let quitting = false;
  const holdQuit = quitGate({
    serverRuns: () => runSync(supervisor.state).state !== "stopped",
    stopServer: () => runPromise(supervisor.stop),
    quit: () => app.quit(),
  });
  const beforeQuit = (event: { readonly preventDefault: () => void }) => {
    quitting = true;
    holdQuit(event);
  };
  app.on("before-quit", beforeQuit);
  // Linux and macOS say when the system shuts down: the app quits, which the
  // gate holds while the server stops. (Electron's types give this event no
  // argument, so the app cannot ask the system to wait; the system's own
  // SIGTERM and the server's stdin lifeline end the server if it is cut short.)
  powerMonitor.on("shutdown", () => app.quit());

  const saveBounds = () => {
    const bounds = window.getNormalBounds();
    const state = { ...bounds, maximized: window.isMaximized() };
    return runPromise(
      settings
        .update((current) => ({ ...current, window: state }))
        .pipe(
          Effect.catch((error) => Effect.logWarning("Saving the window's place failed", error)),
        ),
    );
  };

  // The window's place is saved as it closes, before it goes. While the bots
  // run on this computer, closing the window only hides it: the app stays in
  // the tray, and the bots keep working, until the operator quits.
  let saved = false;
  window.on("close", (event) => {
    if (saved) return;
    event.preventDefault();
    if (!quitting && runSync(settings.get).mode === "local") {
      void saveBounds();
      window.hide();
      return;
    }
    void saveBounds().finally(() => {
      saved = true;
      window.close();
    });
  });

  const forward = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  bringForward = forward;
  yield* Notifier.listen({
    window,
    fromApp,
    bringForward: forward,
    appIcon: path.join(webRoot, "icon-192.png"),
  });
  yield* links.serve({ window, fromApp, bringForward: forward });
  yield* SignInRelay.serve({ window, fromApp, bringForward: forward });
  yield* LinkHandler.register(SCHEME).pipe(Effect.forkScoped);
  yield* Menus.serve({
    window,
    appearance,
    fromApp,
    bringForward: forward,
    localServer: localServerChanges,
    phoneAccess: phone.changes,
  });
  // The page follows the server this computer runs.
  yield* localServerChanges.pipe(
    Stream.runForEach((state) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.localServerChanged, encodeLocalServer(state));
        }
      }),
    ),
    Effect.forkScoped,
  );
  // The page follows phone access.
  yield* phone.changes.pipe(
    Stream.runForEach((access) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.phoneAccessChanged, encodePhoneAccess(access));
        }
      }),
    ),
    Effect.forkScoped,
  );
  // After sleep the network may have changed under the page: it is told, so
  // the client tries again at once rather than when its backoff ends.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const resumed = () => {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.resumed, networkState());
        // The server was frozen with the system, not stopped: it should
        // answer at once, and is started again if it does not. The network
        // it is reached at may be another now.
        void runPromise(Effect.andThen(supervisor.ping, phone.refresh));
      };
      powerMonitor.on("resume", resumed);
      return resumed;
    }),
    (resumed) => Effect.sync(() => powerMonitor.off("resume", resumed)),
  );

  window.once("ready-to-show", () => {
    if (hidden && !launchedWhileStarting) return;
    window.show();
    if (launchedWhileStarting) window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  // macOS: a click on the dock's icon brings back a window that was hidden.
  app.on("activate", forward);

  // The server this computer runs starts once the launch's update is over:
  // at once, before the page loads, where the launch installs nothing first;
  // not at all when the app restarts into a newer version.
  const startLocal = Effect.gen(function* () {
    if ((yield* settings.get).mode === "local" && localHost.available) yield* supervisor.start;
  });
  if (updates.updatesFirst) yield* Effect.forkScoped(Effect.andThen(updates.launched, startLocal));
  else yield* startLocal;

  // A load that fails (the page navigating away first, or a build that will
  // not load) leaves the window open on what it shows: the app keeps running.
  const notLoaded = yield* Effect.promise(() =>
    window.loadURL(`${APP_ORIGIN}/`).then(
      () => null,
      (error: unknown) => ({ error }),
    ),
  );
  if (notLoaded !== null) yield* Effect.logError("Loading the app's page failed", notLoaded.error);
  return yield* Effect.never;
});

// One app per profile: a second launch brings the first one's window forward,
// or, while the app is still starting, as soon as it has one, and hands over
// the link it was started with, if any.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", (_event, argv) => {
    links.receive(argv);
    // The system starting the app again as the operator signs in shows nothing.
    if (Autostart.startsHidden(argv)) return;
    if (bringForward === null) launchedWhileStarting = true;
    else bringForward();
  });
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
