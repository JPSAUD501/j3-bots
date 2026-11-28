// SPDX-License-Identifier: AGPL-3.0-or-later
import { CommandId, ServerOrigin } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ElectronApplication, Page } from "playwright-core";
import { fakeSite, launch, linkTo, mainWindow, pairFromLink, STEP } from "./electron.ts";

// The development build's own browser, as the person uses it: from a bot's
// conversation the globe opens it beside the conversation, an address typed
// in its bar opens a page of a fake site on the loopback, and the app lays
// the page's view over the place the window's page leaves for it, below the
// find bar while finding, and puts it away while a dialog lies over it. A private tab lives apart from the shared
// sign-ins, and a tab sent to the browser's own window goes there and comes
// back when that window closes. Needs the web client built and a display
// (`xvfb-run`), as the smoke does. No real site is touched.

const SITE_PAGE = `<!doctype html><html><head><title>Fake Shop</title></head>
<body><h1>Fake Shop</h1><p>needle one</p><p>needle two</p><p>needle three</p></body></html>`;

/** Where the views showing `site`'s pages are, by the path of the window holding each: none for the shelf. */
const viewsOf = (app: ElectronApplication, site: string) =>
  app.evaluate(({ BaseWindow, BrowserWindow, WebContentsView, session }, site) => {
    const shared = session.fromPartition("persist:j3-browser");
    // A tab no window shows is in the browser's hidden shelf, a window with no page of its own.
    return BaseWindow.getAllWindows().flatMap((window) =>
      window.contentView.children.flatMap((view) =>
        view instanceof WebContentsView && view.webContents.getURL().startsWith(site)
          ? [
              {
                window:
                  window instanceof BrowserWindow
                    ? (URL.parse(window.webContents.getURL())?.pathname ?? "")
                    : "",
                bounds: view.getBounds(),
                visible: view.getVisible(),
                shared: view.webContents.session === shared,
              },
            ]
          : [],
      ),
    );
  }, site);

/** The box of the first combobox named `name` in the page, in its CSS pixels. */
const boxOf = (page: Page, name: string) =>
  page.getByRole("combobox", { name }).first().boundingBox({ timeout: STEP });

it.layer(Layer.mergeAll(Server.layer(Layer.empty), NodeServices.layer), {
  excludeTestServices: true,
})("desktop app's browser", (it) => {
  it.effect(
    "opens beside the conversation, lays the page where the window leaves room, steps aside for a dialog, keeps a private tab apart, and moves a tab to its window",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("browser-bot"),
          draft: { name: "Browser Bot", job: "" },
        });
        const other = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("browser-bot-two"),
          draft: { name: "Second Bot", job: "" },
        });
        const room = yield* (yield* Server.Rooms).create({
          commandId: CommandId.make("browser-room"),
          name: "Fake Room",
          members: [bot.id, other.id],
        });
        const { code } = yield* (yield* Server.Devices).startPairing;
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-browser-" });
        const server = yield* Schema.decodeEffect(ServerOrigin)(origin.origin);
        const site = yield* fakeSite(SITE_PAGE);

        const app = yield* launch(profile, [linkTo({ _tag: "pair", server, code })]);
        const page = yield* mainWindow(app);
        // Wide enough for the browser beside the conversation.
        yield* Effect.promise(() =>
          app.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (window.isVisible()) window.setSize(1440, 900);
            }
          }),
        );
        const views = () => Effect.promise(() => viewsOf(app, site));
        const until = <A>(read: Effect.Effect<A>, done: (value: A) => boolean) =>
          read.pipe(
            Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
            Effect.timeout(STEP),
            // What the window showed, for the CI run's artifacts.
            Effect.tapError(() =>
              Effect.promise(() =>
                page
                  .screenshot({ path: `${import.meta.dirname}/../smoke-failure.png` })
                  .catch(() => undefined),
              ),
            ),
          );

        yield* pairFromLink(page);
        yield* Effect.promise(async () => {
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          // The globe opens the browser beside the conversation, on a new tab.
          await page.getByRole("button", { name: "Open browser" }).click({ timeout: STEP });
          const address = page.getByRole("combobox", { name: "Search or type an address" });
          await address.first().click({ timeout: STEP });
          await page.keyboard.insertText(`${site}/`);
          await page.keyboard.press("Enter");
          await page.getByRole("tab", { name: "Fake Shop" }).waitFor({ timeout: STEP });
        });

        // The page's view lies below the toolbar, beside the conversation.
        const [shown] = yield* until(views(), (now) =>
          now.some((view) => view.visible && view.window !== ""),
        );
        assert.isDefined(shown);
        const bar = yield* Effect.promise(() => boxOf(page, "Search or type an address"));
        const conversation = yield* Effect.promise(() =>
          page.getByRole("main").boundingBox({ timeout: STEP }),
        );
        if (shown === undefined || bar === null || conversation === null) {
          return assert.fail("the browser's page or the window's parts were not found");
        }
        assert.isTrue(shown.shared, "a tab opened from the bar is not in the shared sign-ins");
        assert.isAtLeast(shown.bounds.y, Math.floor(bar.y + bar.height));
        assert.isAtLeast(shown.bounds.x, Math.floor(conversation.x + conversation.width) - 1);

        // One of the app's dialogs over it: the page steps aside for a still, and comes back.
        yield* Effect.promise(() =>
          page.getByRole("button", { name: "Settings" }).click({ timeout: STEP }),
        );
        yield* until(views(), (now) => now.every((view) => !view.visible));
        yield* Effect.promise(() => page.keyboard.press("Escape"));
        yield* until(views(), (now) => now.some((view) => view.visible && view.window !== ""));

        // Finding: the bar takes a strip above the page, which moves down for it.
        yield* Effect.promise(async () => {
          await page.getByRole("combobox", { name: "Search or type an address" }).first().click();
          await page.keyboard.press("Control+f");
          await page.getByPlaceholder("Find in page").fill("needle", { timeout: STEP });
          await page.getByText("1 of 3").waitFor({ timeout: STEP });
        });
        yield* until(views(), (now) =>
          now.some((view) => view.visible && view.bounds.y > shown.bounds.y),
        );
        yield* Effect.promise(() => page.keyboard.press("Escape"));

        // A private tab, beside the shared one, in a partition of its own.
        yield* Effect.promise(async () => {
          await page.getByRole("combobox", { name: "Search or type an address" }).first().click();
          await page.keyboard.press("Control+Shift+N");
          // The new tab is in front once the bar says it is private.
          await page.getByText("Private", { exact: true }).waitFor({ timeout: STEP });
          await page.getByRole("combobox", { name: "Search or type an address" }).first().click();
          await page.keyboard.insertText(`${site}/private`);
          await page.keyboard.press("Enter");
        });
        // The private tab in front, the shared one put away in the shelf.
        const both = yield* until(views(), (now) => now.length === 2);
        assert.deepStrictEqual(
          both.map((view) => `${view.shared ? "shared" : "private"} ${view.visible}`).toSorted(),
          ["private true", "shared false"],
        );

        // To the browser's own window, and back once it closes.
        yield* Effect.promise(() =>
          page.getByRole("button", { name: "Open in a window" }).click({ timeout: STEP }),
        );
        yield* until(views(), (now) =>
          now.some((view) => view.window === "/browser" && !view.shared),
        );

        // Sent back while the main window is on a room, it shows there, beside the room.
        yield* Effect.promise(async () => {
          await page.getByText(room.name).first().click({ timeout: STEP });
          const popOut = app
            .windows()
            .find((window) => new URL(window.url()).pathname === "/browser");
          if (popOut === undefined) throw new Error("the browser's window has no page");
          await popOut
            .getByRole("button", { name: "Put beside the conversation" })
            .first()
            .click({ timeout: STEP });
        });
        yield* until(views(), (now) =>
          now.some((view) => !view.shared && view.visible && view.window.startsWith("/rooms/")),
        );
        // And to the window again, for its closing to bring it back.
        yield* Effect.promise(() =>
          page.getByRole("button", { name: "Open in a window" }).click({ timeout: STEP }),
        );
        yield* until(views(), (now) =>
          now.some((view) => view.window === "/browser" && !view.shared),
        );
        yield* Effect.promise(() =>
          app.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (URL.parse(window.webContents.getURL())?.pathname === "/browser") window.close();
            }
          }),
        );
        yield* until(views(), (now) => now.every((view) => view.window !== "/browser"));
        yield* Effect.promise(() =>
          page.getByRole("tab", { name: "Fake Shop" }).first().waitFor({ timeout: STEP }),
        );
      }),
    180_000,
  );
});
