// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PairingCode, PairingLinkTarget, ServerOrigin } from "@j3-bots/contracts";
import { AppLink, AppLinkUrl, IPC_CHANNELS } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { app, type BrowserWindow, ipcMain, type IpcMainEvent } from "electron";

// Links to the app (`j3bots://bot/<id>`, `room/<id>`, `pair?server&code`):
// taken from the arguments a launch is given, or a second launch hands over
// (Linux, Windows), and from the system on macOS (`open-url`), then given to
// the window's page, which opens them as it opens a notification click.

interface ServeOptions {
  readonly window: BrowserWindow;
  /** Whether an IPC message comes from the top frame of one of the app's own pages. */
  readonly fromApp: (event: IpcMainEvent) => boolean;
  /** Restores, shows and focuses the window. */
  readonly bringForward: () => void;
}

interface AppLinks {
  /** Takes the first link to this build among `args`, as a launch is given them. */
  readonly receive: (args: ReadonlyArray<string>) => void;
  /**
   * Keeps the code of the pairing link that filled in the server address
   * screen, once the server it names is kept, for the page that loads next.
   */
  readonly carry: (pairing: PairingLinkTarget) => void;
  /** The code kept for `server`, once: the page that asks first takes it. */
  readonly takeCarriedCode: (server: ServerOrigin | null) => PairingCode | null;
  /** Hands links to the window's page for as long as the scope lasts. */
  readonly serve: (options: ServeOptions) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Starts taking links of `scheme`: those of this launch's own arguments at
 * once, and on macOS the ones the system hands over, which it may do before
 * the app is ready. Called before `ready`.
 */
export const start = (scheme: string): AppLinks => {
  const decode = Schema.decodeUnknownOption(AppLinkUrl(scheme));
  const encode = Schema.encodeSync(AppLink);
  /** The latest link the page has not been given yet: one, as only the latest is wanted. */
  let waiting: AppLink | null = null;
  /** Gives a link to the page, while it listens. */
  let give: ((link: AppLink) => void) | null = null;
  let carried: PairingLinkTarget | null = null;

  const arrived = (link: AppLink) => {
    if (give === null) waiting = link;
    else give(link);
  };
  const receive = (args: ReadonlyArray<string>) => {
    for (const arg of args) {
      const link = decode(arg);
      if (Option.isSome(link)) return arrived(link.value);
    }
  };

  receive(process.argv);
  app.on("open-url", (event, url) => {
    event.preventDefault();
    receive([url]);
  });

  return {
    receive,
    carry: (pairing) => {
      carried = pairing;
    },
    takeCarriedCode: (server) => {
      const code = carried !== null && carried.server === server ? carried.code : null;
      carried = null;
      return code;
    },
    serve: ({ window, fromApp, bringForward }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          // A page that is replaced (a reload, or the server forgotten) stops
          // listening, and a link that arrives meanwhile waits for the next
          // one. Only a page that loads in the main frame replaces it, not a
          // navigation the window refuses (as notifications go, `notifier.ts`).
          const pageReplaced = () => {
            give = null;
          };
          window.webContents.on("did-navigate", pageReplaced);
          ipcMain.on(IPC_CHANNELS.appLinksWanted, (event) => {
            if (!fromApp(event)) return;
            give = (link) => {
              if (window.isDestroyed()) return;
              bringForward();
              window.webContents.send(IPC_CHANNELS.appLinkOpened, encode(link));
            };
            if (waiting === null) return;
            const link = waiting;
            waiting = null;
            give(link);
          });
          return pageReplaced;
        }),
        (pageReplaced) =>
          Effect.sync(() => {
            give = null;
            ipcMain.removeAllListeners(IPC_CHANNELS.appLinksWanted);
            if (!window.isDestroyed()) window.webContents.off("did-navigate", pageReplaced);
          }),
      ).pipe(Effect.asVoid),
  };
};
