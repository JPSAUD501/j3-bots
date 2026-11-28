// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BrowserAddress,
  type BrowserTabRef,
  CommandId,
  HTTP_PATHS,
  ServerOrigin,
  type SharedBrowserTab,
} from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocket } from "ws";
import { fakeSite, launch, linkTo, mainWindow, pairFromLink, STEP } from "./electron.ts";

// A tab a bot opens on the desktop, which the person never shows there,
// still sends its pictures at once, through the server, to a card's
// stills and a live view. Needs the web client built and a
// display (`xvfb-run`), as the smoke does. No real site is touched.

const PAGE = `<!doctype html><html><head><title>Fake Errand</title></head>
<body style="background:#f4a261"><h1>Fake Errand</h1></body></html>`;

/** How soon a watched tab's first picture comes. */
const PICTURE = Duration.seconds(5);

it.layer(Layer.mergeAll(Server.layer(Layer.empty), NodeServices.layer), {
  excludeTestServices: true,
})("a tab the desktop app never showed", (it) => {
  it.effect(
    "sends a card's stills and a live view's pictures at once, and a hidden window's tab still does",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("errand-bot"),
          draft: { name: "Errand Bot", job: "" },
        });
        const { code } = yield* (yield* Server.Devices).startPairing;
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-unshown-" });
        const server = yield* Schema.decodeEffect(ServerOrigin)(origin.origin);
        const site = yield* fakeSite(PAGE);
        const browser = yield* Server.Browser;

        const app = yield* launch(profile, [linkTo({ _tag: "pair", server, code })]);
        const page = yield* mainWindow(app);
        yield* pairFromLink(page);
        /** The tab at `url` as the server lists it, once the desktop hosts it and its page loaded. */
        const hosted = (url: string) =>
          browser.all.pipe(
            Stream.map(({ tabs }) =>
              tabs.find((tab) => tab.url === url && tab.where.kind === "desktop" && !tab.loading),
            ),
            Stream.filter((tab) => tab !== undefined),
            Stream.runHead,
            Effect.flatMap(Effect.fromOption),
            Effect.timeout(STEP),
          );
        // The person opens a page of their own in the browser beside the bot's
        // conversation, as in the demo: the desktop now hosts the tabs.
        yield* Effect.promise(async () => {
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          await page.getByRole("button", { name: "Open browser" }).click({ timeout: STEP });
          const address = page.getByRole("combobox", { name: "Search or type an address" });
          await address.first().click({ timeout: STEP });
          await page.keyboard.insertText(`${site}/mine`);
          await page.keyboard.press("Enter");
        });
        yield* hosted(`${site}/mine`);
        // The bot opens its own; it stays behind the person's, never shown.
        const errand = `${site}/errand`;
        const ref = yield* Server.botOpens(bot.id, errand);
        const tab: SharedBrowserTab = yield* hosted(errand);
        assert.strictEqual(tab.ref, ref);
        // Its view is in the shelf, the one-pixel window out of sight.
        const holder = yield* Effect.promise(() =>
          app.evaluate(({ BaseWindow, WebContentsView }, errand) => {
            const window = BaseWindow.getAllWindows().find((window) =>
              window.contentView.children.some(
                (view) => view instanceof WebContentsView && view.webContents.getURL() === errand,
              ),
            );
            return window?.getBounds() ?? null;
          }, errand),
        );
        assert.deepInclude(holder, { width: 1, height: 1 });

        // A phone of the person's watches it, through the server, as the apps do.
        const devices = yield* Server.Devices;
        const phone = yield* devices
          .pair({ code: (yield* devices.startPairing).code, name: "Phone" })
          .pipe(Effect.orDie);
        /** The first picture a new socket on `ref` gets: a card's still, or a live view's first. */
        const firstPicture = (ref: BrowserTabRef) =>
          Effect.callback<Uint8Array, Error>((resume) => {
            const url = `${origin.origin.replace(/^http/, "ws")}${HTTP_PATHS.browser}?ref=${ref}`;
            const socket = new WebSocket(url, {
              headers: { authorization: `Bearer ${phone.token}` },
            });
            socket.on("message", (data, binary) => {
              if (!binary || !(data instanceof Buffer)) return;
              resume(Effect.succeed(new Uint8Array(data)));
              socket.close();
            });
            socket.on("error", (cause) => resume(Effect.fail(cause)));
            return Effect.sync(() => socket.close());
          }).pipe(
            Effect.timeout(PICTURE),
            Effect.map((picture) => assert.isAbove(picture.length, 0)),
          );
        // The card's still comes each time it is asked, and so does a live view's picture.
        for (const _asked of ["still", "still again", "live view"]) yield* firstPicture(tab.ref);

        // The person's own tab, shown in the main window, keeps sending its
        // pictures once the window hides and its page moves to another site,
        // whose page begins anew while no window of it is on screen.
        const mine = yield* hosted(`${site}/mine`);
        yield* Effect.promise(() =>
          app.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) window.hide();
          }),
        );
        const elsewhere = `${site.replace("127.0.0.1", "localhost")}/elsewhere`;
        yield* browser.tools.navigate(bot.id, {
          tab: mine.ref,
          url: yield* Schema.decodeEffect(BrowserAddress)(elsewhere),
        });
        yield* hosted(elsewhere);
        yield* firstPicture(mine.ref);
      }),
    180_000,
  );
});
