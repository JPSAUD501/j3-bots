// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the fake site is a plain node:http server.
import * as NodeHttp from "node:http";
import { CommandId, ServerOrigin, type SharedBrowserTab } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ElectronApplication } from "playwright-core";
import { launch, linkTo, mainWindow, STEP } from "./electron.ts";

// A bot at work in a tab the desktop app hosts, driven by the server as a
// bot's tools drive it: its typing and clicking are the bot's, never the
// person's, so the tab is never held for the person and no next action of
// a bot is refused. The person's own keys in the page still hold it. Needs
// the web client built and a display (`xvfb-run`), as the smoke does. No
// real site is touched.

const FORM_PAGE = `<!doctype html><html><head><title>Fake Form</title></head>
<body><input id="field" aria-label="Field"><button id="press"
onclick="document.title = 'Pressed'">Press</button></body></html>`;

/** A fake site on the loopback; answers its origin. Closed with the scope. */
const fakeSite = Effect.acquireRelease(
  Effect.callback<NodeHttp.Server>((resume) => {
    const server = NodeHttp.createServer((_request, response) =>
      response.writeHead(200, { "content-type": "text/html" }).end(FORM_PAGE),
    );
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap((server) => {
    const address = server.address();
    return address === null || typeof address === "string"
      ? Effect.die("not an IP listener")
      : Effect.succeed(`http://127.0.0.1:${address.port}`);
  }),
);

/** The person types a key in the page of the view showing `site`, as the view's own input. */
const personTypes = (app: ElectronApplication, site: string) =>
  Effect.promise(() =>
    app.evaluate(({ webContents }, site) => {
      const contents = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(site));
      if (contents === undefined) throw new Error("no view shows the fake site");
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", keyCode: "x" });
      contents.sendInputEvent({ type: "char", keyCode: "x" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "x" });
    }, site),
  );

it.layer(Layer.mergeAll(Server.layer(Layer.empty), NodeServices.layer), {
  excludeTestServices: true,
})("a bot in the desktop app's browser", (it) => {
  it.effect(
    "types and clicks as the bot, with no hold for the person, whose own keys still hold the tab",
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
        const site = yield* fakeSite;
        const browser = yield* Server.Browser;
        /** The fake site's tab as the server lists it, once `done` takes it. */
        const listed = (done: (tab: SharedBrowserTab) => boolean) =>
          browser.all.pipe(
            Stream.map(({ tabs }) => tabs.find((tab) => tab.url.startsWith(site) && done(tab))),
            Stream.filter((tab) => tab !== undefined),
            Stream.runHead,
            Effect.flatMap(Effect.fromOption),
            Effect.timeout(STEP),
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
        yield* Effect.promise(async () => {
          await page.getByText("This pairing link is for").waitFor({ timeout: STEP });
          await page.getByRole("button", { name: "Continue" }).click();
          await page.getByLabel("Pairing code").waitFor({ timeout: STEP });
          await page.getByRole("button", { name: "Pair", exact: true }).click();
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          await page.getByRole("button", { name: "Open browser" }).click({ timeout: STEP });
          const address = page.getByRole("combobox", { name: "Search or type an address" });
          await address.first().click({ timeout: STEP });
          await page.keyboard.insertText(`${site}/`);
          await page.keyboard.press("Enter");
          await page.getByRole("tab", { name: "Fake Form" }).waitFor({ timeout: STEP });
        });
        // The desktop hosts it, and the server lists it with nobody holding it.
        const tab = yield* listed((tab) => tab.where.kind === "desktop" && tab.heldBy === null);

        // The bot types, adds with a clear, and clicks: none of it is refused.
        yield* browser.tools.act(bot.id, tab.ref, {
          action: "type",
          locator: "#field",
          text: "hello",
        });
        yield* browser.tools.act(bot.id, tab.ref, {
          action: "type",
          locator: "#field",
          text: "again",
          clear: true,
        });
        yield* browser.tools.act(bot.id, tab.ref, { action: "click", locator: "#press" });
        const after = yield* listed(
          (listed) => listed.ref === tab.ref && listed.title === "Pressed",
        );
        // The tab is the bot's for a moment after its actions, never the person's.
        assert.strictEqual(after.heldBy?.kind, "bot");

        // The person's own key in the page holds the tab for them.
        yield* personTypes(app, site);
        const held = yield* listed((listed) => listed.ref === tab.ref && listed.heldBy !== null);
        assert.strictEqual(held.heldBy?.kind, "person");
        // And a bot's next action waits for them.
        const refused = yield* browser.tools
          .act(bot.id, tab.ref, { action: "click", locator: "#press" })
          .pipe(Effect.flip, Effect.option);
        assert.isTrue(Option.isSome(refused));
      }),
    180_000,
  );
});
