// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { app, BaseWindow } from "electron";
import { makeDesktopBrowser } from "../src/browser/host.ts";
import { linkToServer } from "../src/browser/link.ts";

// The desktop's browser alone, as the host check runs it: Electron on this
// file, with no window of the app, linked to the server the check plays at
// `J3_CHECK_SERVER`, its profile and scratch folder in `J3_CHECK_FOLDER`. A
// tab the server opens at `/presence` is shown in a window of its own, with a
// bot on it, as the app's page would say: its page draws the bot's pointer.

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
  yield* browser.local.pipe(
    Stream.runForEach((event) =>
      event.type === "changed" &&
      !event.tab.private &&
      URL.parse(event.page.url)?.pathname === "/presence"
        ? Effect.andThen(
            Effect.sync(() =>
              browser.show(event.tab.ref, screen, { x: 0, y: 0, width: 800, height: 600 }),
            ),
            browser.presence([
              {
                tab: event.tab.ref,
                bots: [
                  {
                    id: BotId.make("bot-check"),
                    profile: { name: "Pointer Check", avatar: { shape: "dome", color: "cobalt" } },
                    thinking: false,
                  },
                ],
                held: false,
              },
            ]),
          )
        : Effect.void,
    ),
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
