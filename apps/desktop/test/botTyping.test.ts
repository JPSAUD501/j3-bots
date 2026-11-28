// SPDX-License-Identifier: AGPL-3.0-or-later
import { CommandId, ServerOrigin, type SharedBrowserTab } from "@j3-bots/contracts";
import { BROWSER_NOTES } from "@j3-bots/prompts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ElectronApplication } from "playwright-core";
import { fakeSite, launch, linkTo, mainWindow, pairFromLink, STEP } from "./electron.ts";

// A bot at work in a tab the desktop app hosts, driven by the server as a
// bot's tools drive it: its typing and clicking are the bot's, never the
// person's, so the tab is never held for the person and no next action of
// a bot is refused. The person's own click, and their own key, in the page
// still hold it. Needs the web client built and a display (`xvfb-run`), as
// the smoke does. No real site is touched.

const FORM_PAGE = `<!doctype html><html><head><title>Fake Form</title></head>
<body><input id="field" aria-label="Field"><button id="press"
onclick="document.title = 'Pressed'">Press</button></body></html>`;

/** The page of the view showing `url`, given the person's own input: a click, or a key. */
const personUses = (app: ElectronApplication, url: string, input: "click" | "key") =>
  Effect.promise(() =>
    app.evaluate(
      ({ webContents }, { url, input }) => {
        const contents = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url);
        if (contents === undefined) throw new Error(`no view shows ${url}`);
        contents.focus();
        if (input === "click") {
          contents.sendInputEvent({
            type: "mouseDown",
            x: 10,
            y: 10,
            button: "left",
            clickCount: 1,
          });
          contents.sendInputEvent({ type: "mouseUp", x: 10, y: 10, button: "left", clickCount: 1 });
          return;
        }
        contents.sendInputEvent({ type: "keyDown", keyCode: "x" });
        contents.sendInputEvent({ type: "char", keyCode: "x" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "x" });
      },
      { url, input },
    ),
  );

it.layer(Layer.mergeAll(Server.layer(Layer.empty), NodeServices.layer), {
  excludeTestServices: true,
})("a bot in the desktop app's browser", (it) => {
  it.effect(
    "types and clicks as the bot, with no hold for the person, whose own click and key still hold the tab",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("typing-bot"),
          draft: { name: "Typing Bot", job: "" },
        });
        const { code } = yield* (yield* Server.Devices).startPairing;
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-typing-" });
        const server = yield* Schema.decodeEffect(ServerOrigin)(origin.origin);
        const site = yield* fakeSite(FORM_PAGE);
        const browser = yield* Server.Browser;
        /** The tab at `url` as the server lists it, once `done` takes it. */
        const listed = (url: string, done: (tab: SharedBrowserTab) => boolean) =>
          browser.all.pipe(
            Stream.map(({ tabs }) => tabs.find((tab) => tab.url === url && done(tab))),
            Stream.filter((tab) => tab !== undefined),
            Stream.runHead,
            Effect.flatMap(Effect.fromOption),
            Effect.timeout(STEP),
          );
        /** The person goes to `url` in the browser's tab in front. */
        const goTo = (url: string) =>
          Effect.promise(async () => {
            const address = page.getByRole("combobox", { name: "Search or type an address" });
            await address.first().click({ timeout: STEP });
            await page.keyboard.insertText(url);
            await page.keyboard.press("Enter");
          });
        /** The bot's next click on `tab` is refused, as the person holds it. */
        const refusedForPerson = (tab: SharedBrowserTab) =>
          browser.tools.act(bot.id, tab.ref, { action: "click", locator: "#press" }).pipe(
            Effect.flip,
            Effect.map((refused) => assert.strictEqual(refused.text, BROWSER_NOTES.personHolds)),
          );

        const app = yield* launch(profile, [linkTo({ _tag: "pair", server, code })]);
        const page = yield* mainWindow(app);
        yield* Effect.promise(() =>
          app.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (window.isVisible()) window.setSize(1440, 900);
            }
          }),
        );
        // The person opens the fake site in the browser beside the bot's conversation.
        yield* pairFromLink(page);
        yield* Effect.promise(async () => {
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          await page.getByRole("button", { name: "Open browser" }).click({ timeout: STEP });
        });
        const formUrl = `${site}/`;
        yield* goTo(formUrl);
        // The desktop hosts it, and the server lists it with nobody holding it.
        const form = yield* listed(
          formUrl,
          (tab) => tab.where.kind === "desktop" && tab.heldBy === null,
        );

        // The bot types, adds with a clear, and clicks: none of it is refused.
        yield* browser.tools.act(bot.id, form.ref, {
          action: "type",
          locator: "#field",
          text: "hello",
        });
        yield* browser.tools.act(bot.id, form.ref, {
          action: "type",
          locator: "#field",
          text: "again",
          clear: true,
        });
        yield* browser.tools.act(bot.id, form.ref, { action: "click", locator: "#press" });
        const pressed = yield* listed(formUrl, (tab) => tab.title === "Pressed");
        // The tab is the bot's for a moment after its actions, never the person's.
        assert.strictEqual(pressed.heldBy?.kind, "bot");

        // The person's own click in the page holds the tab for them.
        yield* personUses(app, formUrl, "click");
        const clicked = yield* listed(formUrl, (tab) => tab.heldBy?.kind === "person");
        yield* refusedForPerson(clicked);

        // In a new tab, the bot types, and the person's own key holds it for them. The
        // address is typed once the new tab is in front: typed before, it would be the
        // form's, or dropped as the new tab comes.
        yield* Effect.promise(async () => {
          await page
            .getByRole("combobox", { name: "Search or type an address" })
            .first()
            .click({ timeout: STEP });
          await page.keyboard.press("Control+t");
          await page
            .getByRole("tab", { name: "New tab", selected: true })
            .first()
            .waitFor({ timeout: STEP });
        });
        const keysUrl = `${site}/keys`;
        yield* goTo(keysUrl);
        // The person's address holds the new tab for them, until the server publishes that
        // their hold ended, 10 s on (`BROWSER_PERSON_HOLD_MS`).
        const addressed = yield* listed(
          keysUrl,
          (tab) => tab.where.kind === "desktop" && tab.heldBy?.kind === "person",
        );
        assert.notStrictEqual(addressed.ref, form.ref);
        const keys = yield* listed(
          keysUrl,
          (tab) => tab.ref === addressed.ref && tab.heldBy === null,
        );
        yield* browser.tools.act(bot.id, keys.ref, {
          action: "type",
          locator: "#field",
          text: "hello",
        });
        assert.strictEqual((yield* listed(keysUrl, () => true)).heldBy?.kind, "bot");
        yield* personUses(app, keysUrl, "key");
        const typed = yield* listed(keysUrl, (tab) => tab.heldBy?.kind === "person");
        yield* refusedForPerson(typed);
      }),
    180_000,
  );
});
