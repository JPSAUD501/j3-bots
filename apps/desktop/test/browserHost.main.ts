// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type BrowserTabRef, DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { app, BaseWindow, net, WebContentsView } from "electron";
import { makeDesktopBrowser } from "../src/browser/host.ts";
import { linkToServer } from "../src/browser/link.ts";

// The desktop's browser alone, as the host check runs it: Electron on this
// file, with no window of the app, linked to the server the check plays at
// `J3_CHECK_SERVER`, its profile and scratch folder in `J3_CHECK_FOLDER`. A
// tab the server opens at `/presence` is shown in a window of its own, with a
// bot on it, as the app's page would say: its page draws the bot's pointer.
// One at `/aside` has the bot on it too, and no window shows it.
// As that page's title asks ("Look"), what the window shows of it goes to the
// server at `/seen`, as the person sees it.

const server = process.env["J3_CHECK_SERVER"];
const folder = process.env["J3_CHECK_FOLDER"];
if (server === undefined || folder === undefined)
  throw new Error("The host check gave no server or folder.");
app.setPath("userData", `${folder}/profile`);
app.setPath("downloads", `${folder}/downloads`);
// The browser lives on with no window open.
app.on("window-all-closed", () => undefined);

const program = Effect.gen(function* () {
  const browser = yield* makeDesktopBrowser({
    scratch: `${folder}/scratch`,
    // The web client's build, which the check builds first.
    drawing: `${import.meta.dirname}/../../web/dist-presence/presence.js`,
  });
  const screen = yield* Effect.acquireRelease(
    Effect.sync(() => new BaseWindow({ width: 800, height: 600 })),
    (window) => Effect.sync(() => window.destroy()),
  );
  const look = Effect.gen(function* () {
    const view = screen.contentView.children.find(
      (child): child is WebContentsView => child instanceof WebContentsView,
    );
    if (view === undefined) return yield* Effect.die("The window shows no tab.");
    const image = yield* Effect.promise(() => view.webContents.capturePage());
    yield* Effect.promise(() =>
      net.fetch(`${server}/seen`, { method: "POST", body: Uint8Array.from(image.toPNG()) }),
    );
  });
  /** The tabs the bot is on. */
  const botOn = new Set<BrowserTabRef>();
  const withBot = (tab: BrowserTabRef) =>
    Effect.suspend(() => {
      botOn.add(tab);
      return browser.presence(
        [...botOn].map((tab) => ({
          tab,
          bots: [
            {
              id: BotId.make("bot-check"),
              profile: { name: "Pointer Check", avatar: { shape: "dome", color: "cobalt" } },
              thinking: false,
            },
          ],
          held: false,
        })),
      );
    });
  yield* browser.local.pipe(
    Stream.runForEach((event) => {
      if (event.type !== "changed" || event.tab.private) return Effect.void;
      const path = URL.parse(event.page.url)?.pathname;
      if (path === "/aside") return withBot(event.tab.ref);
      if (path !== "/presence") return Effect.void;
      if (event.page.title === "Look") return look;
      return Effect.andThen(
        Effect.sync(() =>
          browser.show(event.tab.ref, screen, { x: 0, y: 0, width: 800, height: 600 }),
        ),
        withBot(event.tab.ref),
      );
    }),
    Effect.forkScoped,
  );
  // A private tab of the person's, which the server must never hear of.
  yield* browser.openForPerson({ url: `${server}/`, private: true });
  yield* linkToServer({
    origin: server,
    token: Redacted.make("device-token-of-the-check"),
    host: browser.hostFor(DeviceId.make("device-check")),
    refused: Effect.succeed(false),
    onRefused: Effect.void,
  });
}).pipe(Effect.scoped);

void app.whenReady().then(() =>
  Effect.runPromise(
    program.pipe(
      Effect.tapCause(Effect.logError),
      Effect.onError(() => Effect.sync(() => app.exit(1))),
    ),
  ),
);
