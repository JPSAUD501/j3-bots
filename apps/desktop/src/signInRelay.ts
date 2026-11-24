// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- one listener for one request on the loopback, answered by hand, needs no HTTP server of Effect's.
import { createServer, type Server } from "node:http";
import {
  IPC_CHANNELS,
  SignInExpectation,
  type SignInRelayStart,
  SignInRelayRequest,
  SignInRelayStop,
  SignInReturn,
} from "@j3-bots/desktop-bridge";
import { createI18n } from "@j3-bots/i18n";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { LOOPBACK_HEADERS, landingPage, type SignInCatch, signInCatch } from "./loopback.ts";

// The browser's return from a connector's sign-in, caught on this computer's
// loopback and handed to the page, which relays it to the server. The server
// may sit on another machine, on plain HTTP, where no browser could come back
// to it; the authorization server accepts a loopback address on any port, and
// the code that comes back is worth nothing without the verifier only the
// server holds. One sign-in at a time, for as long as the server keeps it,
// and only its own return: the page tells the listener the sign-in's state
// before the browser opens it.

const decodeRequest = Schema.decodeUnknownOption(SignInRelayRequest);
const decodeExpectation = Schema.decodeUnknownOption(SignInExpectation);
const decodeStop = Schema.decodeUnknownOption(SignInRelayStop);
const encodeReturn = Schema.encodeSync(SignInReturn);

/** How long the browser has to come back, as long as the server waits for it. */
const WAIT = Duration.minutes(10);

interface Options {
  readonly window: BrowserWindow;
  /** Whether an IPC message comes from the top frame of one of the app's own pages. */
  readonly fromApp: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Restores, shows and focuses the window. */
  readonly bringForward: () => void;
}

/** Catches the browser's returns from sign-ins the window's page asks for, while the scope lasts. */
export const serve = Effect.fn("SignInRelay.serve")(function* ({
  window,
  fromApp,
  bringForward,
}: Options) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let current: {
    readonly server: Server;
    readonly port: number;
    readonly caught: SignInCatch;
    readonly expiry: Fiber.Fiber<void>;
  } | null = null;

  const stop = () => {
    if (current === null) return;
    const { server, expiry } = current;
    current = null;
    server.close();
    server.closeAllConnections();
    runFork(Fiber.interrupt(expiry));
  };

  /** Opens a listener on a port the system picks, in place of any other. */
  const start = (language: SignInRelayRequest["language"]) =>
    Effect.callback<SignInRelayStart>((resume) => {
      stop();
      const i18n = createI18n(language);
      const page = landingPage({
        language,
        title: i18n.t("signInReturn.title"),
        body: i18n.t("signInReturn.body"),
      });
      let caught: SignInCatch | null = null;
      const server = createServer((request, response) => {
        const answer = caught?.answer({
          method: request.method,
          url: request.url,
          host: request.headers.host,
        }) ?? { _tag: "refused", status: 400 };
        if (answer._tag === "refused") {
          response.writeHead(answer.status, LOOPBACK_HEADERS).end();
          return;
        }
        response
          .writeHead(200, { ...LOOPBACK_HEADERS, "content-type": "text/html; charset=utf-8" })
          .end(page, () => {
            if (current?.server === server) stop();
          });
      });
      server.once("error", () => resume(Effect.succeed({ _tag: "failed" })));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          resume(Effect.succeed({ _tag: "failed" }));
          return;
        }
        const port = address.port;
        caught = signInCatch(port, {
          relay: (url) => {
            if (!window.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.signInReturned, encodeReturn({ url }));
            }
          },
          focus: bringForward,
        });
        const expiry = runFork(
          Effect.sleep(WAIT).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (current?.server === server) stop();
              }),
            ),
          ),
        );
        current = { server, port, caught, expiry };
        resume(Effect.succeed({ _tag: "listening", port }));
      });
    });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.handle(IPC_CHANNELS.catchSignIn, (event, request: unknown) => {
        const decoded = decodeRequest(request);
        if (!fromApp(event) || Option.isNone(decoded)) return { _tag: "failed" };
        return Effect.runPromiseWith(context)(start(decoded.value.language));
      });
      // The sign-in's state, from the address the page is about to open, for the listener on `port` alone.
      ipcMain.handle(IPC_CHANNELS.expectSignIn, (event, request: unknown) => {
        const decoded = decodeExpectation(request);
        if (!fromApp(event) || Option.isNone(decoded) || current?.port !== decoded.value.port) {
          return false;
        }
        current.caught.expect(decoded.value.state);
        return true;
      });
      // Only the listener on `port`: a later sign-in's listener is not an earlier one's to stop.
      ipcMain.on(IPC_CHANNELS.stopCatchingSignIn, (event, request: unknown) => {
        const decoded = decodeStop(request);
        if (fromApp(event) && Option.isSome(decoded) && current?.port === decoded.value.port)
          stop();
      });
      // A page that replaces the one that asked has nothing waiting for the return.
      window.webContents.on("did-navigate", stop);
    }),
    () =>
      Effect.sync(() => {
        ipcMain.removeHandler(IPC_CHANNELS.catchSignIn);
        ipcMain.removeHandler(IPC_CHANNELS.expectSignIn);
        ipcMain.removeAllListeners(IPC_CHANNELS.stopCatchingSignIn);
        if (!window.isDestroyed()) window.webContents.off("did-navigate", stop);
        stop();
      }),
  );
});
