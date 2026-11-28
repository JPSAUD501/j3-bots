// SPDX-License-Identifier: AGPL-3.0-or-later
import { CommandId, HTTP_PATHS, ServerOrigin, type BrowserTabRef } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocket } from "ws";
import { fakeSite, launch, linkTo, mainWindow, pairFromLink, STEP } from "./electron.ts";

// A desktop tab the people watched, and stopped watching while the host's
// newest picture waited for a socket that never drew it, still sends its
// pictures to the next one to watch; and a watched page that does not
// change sends none, with the bot's pointer drawn in it. Needs the web
// client built and a display (`xvfb-run`), as the smoke does. No real site
// is touched.

/** A page that changes every tenth of a second at `?tick`, and never otherwise. */
const PAGE = `<!doctype html><html><head><title>Fake Errand</title></head>
<body style="background:#f4a261"><h1>Fake Errand</h1><p id="tick"></p><button id="press">Press</button>
<script>
  if (location.search === "?tick") {
    let ticks = 0;
    setInterval(() => { document.getElementById("tick").textContent = String(++ticks); }, 100);
  }
</script></body></html>`;

/** How soon a watched tab's next picture comes. */
const PICTURE = Duration.seconds(5);

/** One media socket on a tab, as a client's: the pictures it gets, and its acknowledgements. */
interface Watching {
  readonly picture: Effect.Effect<Uint8Array>;
  /** Draws each picture as it comes, as a live view does, for as long as it runs. */
  readonly drawing: Effect.Effect<never>;
  readonly ack: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  /** How many pictures it got so far. */
  readonly got: () => number;
}

it.layer(Layer.mergeAll(Server.layer(Layer.empty), NodeServices.layer), {
  excludeTestServices: true,
})("a desktop tab watched again", (it) => {
  it.effect(
    "sends its pictures after the last socket left with the newest undrawn, and none while it stays the same",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("errand-bot"),
          draft: { name: "Errand Bot", job: "" },
        });
        const devices = yield* Server.Devices;
        const { code } = yield* devices.startPairing;
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-watch-" });
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
        // The person opens a page of their own: the desktop now hosts the tabs.
        yield* Effect.promise(async () => {
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          await page.getByRole("button", { name: "Open browser" }).click({ timeout: STEP });
          const address = page.getByRole("combobox", { name: "Search or type an address" });
          await address.first().click({ timeout: STEP });
          await page.keyboard.insertText(`${site}/mine`);
          await page.keyboard.press("Enter");
        });
        yield* hosted(`${site}/mine`);

        /** A socket of a new device of the person's on `ref`, as the apps open one. */
        const watch = Effect.fnUntraced(function* (ref: BrowserTabRef, name: string) {
          const device = yield* devices
            .pair({ code: (yield* devices.startPairing).code, name })
            .pipe(Effect.orDie);
          const pictures = yield* Queue.unbounded<Uint8Array>();
          let got = 0;
          const url = `${origin.origin.replace(/^http/, "ws")}${HTTP_PATHS.browser}?ref=${ref}`;
          const socket = yield* Effect.acquireRelease(
            Effect.callback<WebSocket>((resume) => {
              const socket = new WebSocket(url, {
                headers: { authorization: `Bearer ${device.token}` },
              });
              socket.on("message", (data, binary) => {
                if (!binary || !(data instanceof Buffer)) return;
                got += 1;
                Queue.offerUnsafe(pictures, new Uint8Array(data));
              });
              socket.once("open", () => resume(Effect.succeed(socket)));
              socket.once("error", (cause) => resume(Effect.die(cause)));
            }),
            (socket) => Effect.sync(() => socket.close()),
          );
          const watching: Watching = {
            picture: Queue.take(pictures).pipe(Effect.timeout(PICTURE), Effect.orDie),
            drawing: Effect.forever(
              Effect.andThen(
                Queue.take(pictures),
                Effect.sync(() => socket.send(JSON.stringify({ type: "ack" }))),
              ),
            ),
            ack: Effect.sync(() => socket.send(JSON.stringify({ type: "ack" }))),
            close: Effect.sync(() => socket.close()),
            got: () => got,
          };
          return watching;
        });

        // The bot works on a page that keeps changing; the person's card and their phone watch it.
        const errand = `${site}/errand?tick`;
        const ref = yield* Server.botOpens(bot.id, errand);
        yield* hosted(errand);
        const card = yield* watch(ref, "Card");
        const phone = yield* watch(ref, "Phone");
        // The card never draws its first picture; the phone draws a few, then leaves
        // with the host's newest in flight, which the card would get next. Then the card leaves.
        yield* card.picture;
        for (let drawn = 0; drawn < 3; drawn += 1) {
          yield* phone.picture;
          yield* phone.ack;
        }
        yield* phone.picture;
        // Each leave is given time to reach the desktop, so the next screencast starts after
        // the old one stopped rather than taking its place.
        yield* phone.close;
        yield* Effect.sleep(Duration.seconds(1));
        yield* card.close;
        yield* Effect.sleep(Duration.seconds(1));
        // Whoever watches next gets pictures, one after another.
        const again = yield* watch(ref, "Phone again");
        for (let drawn = 0; drawn < 3; drawn += 1) {
          assert.isAbove((yield* again.picture).length, 0);
          yield* again.ack;
        }
        yield* again.close;

        // A page that never changes, watched with the bot's pointer drawn in it, sends
        // pictures while the pointer moves for the bot's click, and none once it rests.
        const still = `${site}/still`;
        const stillRef = yield* Server.botOpens(bot.id, still);
        yield* hosted(still);
        const viewer = yield* watch(stillRef, "Viewer");
        yield* Effect.forkScoped(viewer.drawing);
        /** How many pictures the viewer gets in the next `span`. */
        const picturesIn = (span: Duration.Duration) =>
          Effect.gen(function* () {
            const before = viewer.got();
            yield* Effect.sleep(span);
            return viewer.got() - before;
          });
        const beforeClick = viewer.got();
        yield* browser.tools
          .act(bot.id, stillRef, { action: "click", locator: "#press" })
          .pipe(Effect.orDie);
        yield* Effect.sleep(Duration.seconds(1));
        assert.isAbove(viewer.got() - beforeClick, 0);
        const drawn = yield* Effect.promise(() =>
          app.evaluate(({ webContents }, url) => {
            const contents = webContents.getAllWebContents().find((one) => one.getURL() === url);
            return contents?.executeJavaScript(`document.querySelector("j3-presence") !== null`);
          }, still),
        );
        assert.strictEqual(drawn, true);
        yield* Effect.sleep(Duration.seconds(2));
        // Before, the pointer's face lived on and the page sent about 60 a second.
        assert.isAtMost(yield* picturesIn(Duration.seconds(3)), 2);
      }),
    180_000,
  );
});
