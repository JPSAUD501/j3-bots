// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Electron runs as a child the check starts and stops, on a folder it makes and removes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import { type PageHost, pageHostOnSocket } from "@j3-bots/browser";
import {
  type BrowserHostError,
  DeviceId,
  type BrowserHostEvent,
  BrowserTabRef,
  HTTP_PATHS,
} from "@j3-bots/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import { electronPath } from "./electron.ts";

// The desktop's browser, run by Electron on its own (browserHost.main.ts),
// against a server this check plays: it accepts the host's socket and makes
// the server's calls, and serves fake pages under `j3test.localhost`, which
// the browser reaches on the loopback. No real site is touched.

const TOKEN = "device-token-of-the-check";
const STEP = 30_000;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** The fake site, by path. */
const PAGES: Readonly<Record<string, () => HttpServerResponse.HttpServerResponse>> = {
  "/": () =>
    HttpServerResponse.text(
      page(
        "Start",
        `<button onclick="window.open('/popup')">Open pop-up</button>
         <a href="/file">Get the file</a>
         <button onclick="alert('Hello')">Alert</button>
         <label>Notes <input type="file" onchange="document.title = this.files[0].name"></label>`,
      ),
      { contentType: "text/html", headers: { "set-cookie": "seen=1; Path=/" } },
    ),
  // A sign-in kept as a Firebase app keeps one: in IndexedDB.
  "/firebase": () =>
    HttpServerResponse.text(
      page(
        "Firebase",
        `<script>
           window.signedIn = new Promise((resolve) => {
             const open = indexedDB.open("firebaseLocalStorageDb", 1);
             open.onupgradeneeded = () =>
               open.result.createObjectStore("firebaseLocalStorage", { keyPath: "fbase_key" });
             open.onsuccess = () => {
               const db = open.result;
               const writing = db.transaction("firebaseLocalStorage", "readwrite");
               writing.objectStore("firebaseLocalStorage").put({
                 fbase_key: "firebase:authUser:fake-key:[DEFAULT]",
                 value: { uid: "person-on-the-desktop" },
               });
               writing.oncomplete = () => { db.close(); resolve(true); };
             };
           });
         </script>`,
      ),
      { contentType: "text/html" },
    ),
  // Who the page finds signed in, holding its database open as a Firebase app does.
  "/whoami": () =>
    HttpServerResponse.text(
      page(
        "Who",
        `<script>
           window.who = new Promise((resolve) => {
             const open = indexedDB.open("firebaseLocalStorageDb");
             open.onsuccess = () => {
               const db = open.result;
               if (!db.objectStoreNames.contains("firebaseLocalStorage")) return resolve(null);
               const read = db
                 .transaction("firebaseLocalStorage")
                 .objectStore("firebaseLocalStorage")
                 .get("firebase:authUser:fake-key:[DEFAULT]");
               read.onsuccess = () => resolve(read.result?.value.uid ?? null);
             };
           });
         </script>`,
      ),
      { contentType: "text/html" },
    ),
  // A page of one site embedding a page of another, which tells what it kept before.
  "/embeds": () =>
    HttpServerResponse.text(
      page(
        "Embeds",
        `<script>
           window.kept = new Promise((resolve) =>
             addEventListener("message", (event) => resolve(event.data)),
           );
           const frame = document.createElement("iframe");
           frame.src = "http://elsewhere.localhost:" + location.port + "/keeps";
           document.body.append(frame);
         </script>`,
      ),
      { contentType: "text/html" },
    ),
  "/keeps": () =>
    HttpServerResponse.text(
      page(
        "Keeps",
        `<script>
           parent.postMessage(localStorage.getItem("kept"), "*");
           localStorage.setItem("kept", "1");
         </script>`,
      ),
      { contentType: "text/html" },
    ),
  // A login whose form, once sent, names how much was typed into it.
  "/login": () =>
    HttpServerResponse.text(
      page(
        "Login",
        `<form onsubmit="document.title = 'Sent ' + this.p.value.length; return false">
           <input name="p" type="password">
         </form>`,
      ),
      { contentType: "text/html" },
    ),
  // A page whose policy lets in nothing but its own script, as a strict site's does, where a
  // bot's pointer is drawn (browserHost.main.ts): what is pressed and typed shows in its title.
  // It is orange and black throughout, styled by its script as its policy allows: nothing of
  // it is blue, as the bot's pointer is, or white, as its tag is.
  "/presence": () =>
    HttpServerResponse.text(
      page(
        "Presence",
        `<button id="press">Press</button>
         <input id="field" aria-label="Field">
         <script>
           document.documentElement.style.background = "rgb(200, 140, 60)";
           for (const element of document.querySelectorAll("button, input")) {
             element.style.background = "rgb(170, 110, 40)";
             element.style.color = "black";
             element.style.border = "0";
             element.style.outline = "none";
           }
           let pressed = 0;
           document.getElementById("press").onclick = () => {
             pressed += 1;
             document.title = "Pressed " + pressed;
           };
         </script>`,
      ),
      {
        contentType: "text/html",
        headers: { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'" },
      },
    ),
  "/popup": () =>
    HttpServerResponse.text(page("Pop-up", `<button onclick="window.close()">Close</button>`), {
      contentType: "text/html",
    }),
  // A worker that answers a visit to the start page with the site's own code.
  "/worker.js": () =>
    HttpServerResponse.text(
      `self.addEventListener("install", () => self.skipWaiting());
       self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
       self.addEventListener("fetch", (event) => {
         if (event.request.mode === "navigate" && new URL(event.request.url).pathname === "/") {
           event.respondWith(new Response(
             "<script>localStorage.setItem('worker', 'ran')</script>",
             { headers: { "content-type": "text/html" } },
           ));
         }
       });`,
      { contentType: "text/javascript" },
    ),
  "/file": () =>
    HttpServerResponse.text("hello", {
      contentType: "text/plain",
      headers: { "content-disposition": 'attachment; filename="report.txt"' },
    }),
};

/** The headers the page's navigation carried, as the page shows them. */
const echoHeaders = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerResponse.text(page("Headers", `<pre id="h">${JSON.stringify(request.headers)}</pre>`), {
    contentType: "text/html",
  });

/**
 * The server's side: the host that dialed in, the fake site on the same port,
 * and the picture of the shown page the check's main sends (`/seen`).
 */
const playServer = Effect.gen(function* () {
  const reached = yield* Deferred.make<PageHost>();
  const seen = yield* Deferred.make<Uint8Array>();
  const done = yield* Deferred.make<void>();
  yield* HttpServer.serveEffect(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://check").pathname;
      if (path === HTTP_PATHS.browserHost) {
        if (request.headers["authorization"] !== `Bearer ${TOKEN}`) {
          return HttpServerResponse.empty({ status: 401 });
        }
        const socket = yield* Effect.orDie(request.upgrade);
        const { host } = yield* pageHostOnSocket(socket);
        yield* Deferred.succeed(reached, host);
        yield* Deferred.await(done);
        return HttpServerResponse.empty();
      }
      if (path === "/headers") return echoHeaders(request);
      if (path === "/seen") {
        yield* Deferred.succeed(seen, new Uint8Array(yield* Effect.orDie(request.arrayBuffer)));
        return HttpServerResponse.empty();
      }
      return PAGES[path]?.() ?? HttpServerResponse.empty({ status: 404 });
    }).pipe(Effect.scoped),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(done, undefined));
  const { address } = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(address))
    return yield* Effect.die("The check's server has no port.");
  return { port: address.port, reached, seen };
});

/** Electron running the desktop's browser, linked to `server`, in a folder of its own. */
const runBrowser = (server: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j3-browser-check-"));
      const child = NodeChildProcess.spawn(
        electronPath(),
        [NodePath.join(import.meta.dirname, "browserHost.main.ts"), "--no-sandbox"],
        {
          env: { ...process.env, J3_CHECK_SERVER: server, J3_CHECK_FOLDER: folder },
          stdio: "inherit",
        },
      );
      return { folder, child };
    }),
    ({ folder, child }) =>
      Effect.callback<void>((resume) => {
        child.once("exit", () => {
          NodeFS.rmSync(folder, { recursive: true, force: true });
          resume(Effect.void);
        });
        child.kill();
      }),
  );

const withServer = <A, E>(effect: Effect.Effect<A, E, HttpServer.HttpServer | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(NodeHttpServer.layerTest)));

type EventOf<T extends BrowserHostEvent["type"]> = Extract<BrowserHostEvent, { readonly type: T }>;

const isOf =
  <T extends BrowserHostEvent["type"]>(type: T) =>
  (event: BrowserHostEvent): event is EventOf<T> =>
    event.type === type;

/** The next event of `type` that `where` takes, skipping the others, within a step. */
const next = <T extends BrowserHostEvent["type"]>(
  events: Queue.Dequeue<BrowserHostEvent>,
  type: T,
  where: (event: EventOf<T>) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const wanted = isOf(type);
    while (true) {
      const event = yield* Queue.take(events);
      if (wanted(event) && where(event)) return event;
    }
  }).pipe(Effect.timeout(STEP));

const reasonOf = (error: BrowserHostError) => error.reason;

/** A point of the page, as the check reads it there, and the element under it. */
const decodePoint = Schema.decodeUnknownSync(
  Schema.Struct({ x: Schema.Finite, y: Schema.Finite, under: Schema.NullOr(Schema.String) }),
);

const paeth = (left: number, up: number, upLeft: number) => {
  const guess = left + up - upLeft;
  const toLeft = Math.abs(guess - left);
  const toUp = Math.abs(guess - up);
  const toUpLeft = Math.abs(guess - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
};

/**
 * How many pixels of a PNG (8 bits a channel, RGB or RGBA, not interlaced, as
 * Chromium writes them) are of the bot's pointer, blue, and of its tag, white.
 */
const inkOf = (png: Uint8Array) => {
  const read = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Array<Uint8Array> = [];
  for (let at = 8; at < png.length;) {
    const length = read.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      width = read.getUint32(at + 8);
      height = read.getUint32(at + 12);
      assert.deepStrictEqual([png[at + 16], png[at + 20]], [8, 0], "8 bits, not interlaced");
      channels = png[at + 17] === 6 ? 4 : png[at + 17] === 2 ? 3 : 0;
      assert.notStrictEqual(channels, 0, "RGB or RGBA");
    } else if (type === "IDAT") {
      data.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const rows = NodeZlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  let above = new Uint8Array(stride);
  let blue = 0;
  let white = 0;
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = rows[start] ?? 0;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (row[x - channels] ?? 0) : 0;
      const up = above[x] ?? 0;
      const upLeft = x >= channels ? (above[x - channels] ?? 0) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
      row[x] = ((rows[start + 1 + x] ?? 0) + predicted) & 0xff;
    }
    for (let x = 0; x < stride; x += channels) {
      const [red, green, blueness] = [row[x] ?? 0, row[x + 1] ?? 0, row[x + 2] ?? 0];
      if (blueness > red + 60 && blueness > green + 40) blue += 1;
      if (red > 235 && green > 235 && blueness > 235) white += 1;
    }
    above = row;
  }
  return { blue, white };
};

describe.skipIf(process.platform !== "linux" || process.env["DISPLAY"] === undefined)(
  "the desktop's browser, driven by a server",
  () => {
    it.live(
      "runs the server's tabs: pages, pop-ups, downloads, uploads, dialogs and sign-ins",
      () =>
        Effect.gen(function* () {
          const { port, reached, seen: pictured } = yield* playServer;
          yield* runBrowser(`http://127.0.0.1:${port}`);
          const host = yield* Deferred.await(reached).pipe(Effect.timeout(STEP));
          const site = `http://pages.j3test.localhost:${port}`;

          const hello = yield* host.hello;
          assert.deepStrictEqual(hello.host, {
            kind: "desktop",
            device: DeviceId.make("device-check"),
          });
          assert.isTrue(hello.capabilities.files);
          assert.match(hello.browser.userAgent, /Chrome\/\d+\.0\.0\.0 Safari/);
          assert.notMatch(hello.browser.userAgent, /Electron|J3/);
          // The person's private tab, open since before the link (browserHost.main.ts), is named nowhere.
          assert.deepStrictEqual(hello.tabs, []);
          assert.isUndefined(hello.privateTabs);
          assert.isTrue(hello.capabilities.indexedDb);
          assert.isString(hello.cookieStore);
          assert.isString(hello.browserRun);

          const events = yield* Queue.unbounded<BrowserHostEvent>();
          yield* host.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          yield* Effect.sleep(100);

          // A tab the server opens, which presents itself as Chrome to the page and its requests.
          const tab = BrowserTabRef.make("tab-check");
          const headers = yield* host.open({
            tab,
            url: `${site}/headers`,
            background: false,
            private: false,
          });
          assert.strictEqual(headers.title, "Headers");
          const seen = yield* host.evaluate({
            tab,
            expression: `({ sent: document.getElementById("h").textContent, brands: navigator.userAgentData.brands.map((b) => b.brand), agent: navigator.userAgent })`,
            awaitPromise: false,
          });
          const shown = JSON.stringify(seen.value);
          assert.include(shown, "Google Chrome");
          assert.notInclude(shown, "Electron");

          // A site's cookie is sent; the server's own write is not sent back.
          const start = yield* host.navigate({ tab, to: { kind: "url", url: `${site}/` } });
          assert.strictEqual(start.title, "Start");
          const set = yield* next(events, "cookies.changed");
          assert.deepInclude(
            set.changes.set.map(({ name, domain, hostOnly }) => ({ name, domain, hostOnly })),
            {
              name: "seen",
              domain: "pages.j3test.localhost",
              hostOnly: true,
            },
          );
          yield* host.writeCookies({
            set: [
              {
                name: "from-server",
                value: "1",
                domain: "pages.j3test.localhost",
                hostOnly: true,
                path: "/",
                secure: false,
                httpOnly: false,
                sameSite: "lax",
              },
            ],
            removed: [],
          });
          const echo = yield* next(events, "cookies.changed").pipe(Effect.timeoutOption(2_500));
          assert.isTrue(Option.isNone(echo));
          const { cookies } = yield* host.readCookies;
          assert.isTrue(cookies.some((cookie) => cookie.name === "from-server"));
          // Removed by the server, a cookie the site set over plain HTTP is gone.
          yield* host.writeCookies({
            set: [],
            removed: [
              { name: "seen", domain: "pages.j3test.localhost", hostOnly: true, path: "/" },
            ],
          });
          const after = yield* host.readCookies;
          assert.isFalse(after.cookies.some((cookie) => cookie.name === "seen"));

          // Site storage, written by the server and read by the page.
          yield* host.writeStorage([{ origin: site, localStorage: [{ name: "k", value: "v" }] }]);
          const stored = yield* host.evaluate({
            tab,
            expression: `localStorage.getItem("k")`,
            awaitPromise: false,
          });
          assert.strictEqual(stored.value, "v");
          // A site's worker never answers the read: the probe runs no code of the site's.
          const worker = yield* host.evaluate({
            tab,
            expression: `navigator.serviceWorker.register("/worker.js").then(() => navigator.serviceWorker.ready).then(() => true)`,
            awaitPromise: true,
          });
          assert.strictEqual(worker.value, true);
          const read = yield* host.readStorage({ origins: [site], indexedDb: false });
          assert.deepStrictEqual(read.origins, [
            { origin: site, localStorage: [{ name: "k", value: "v" }] },
          ]);

          // A sign-in a site keeps in IndexedDB goes from this browser to the server.
          const auth = `http://auth.j3test.localhost:${port}`;
          yield* host.navigate({ tab, to: { kind: "url", url: `${auth}/firebase` } });
          const signedIn = yield* host.evaluate({
            tab,
            expression: "window.signedIn",
            awaitPromise: true,
          });
          assert.strictEqual(signedIn.value, true);
          const taken = yield* host.readStorage({ origins: [auth], indexedDb: true });
          const databases = taken.origins[0]?.indexedDb ?? [];
          assert.deepStrictEqual(
            databases.map((database) => database.name),
            ["firebaseLocalStorageDb"],
          );
          assert.include(JSON.stringify(databases), "person-on-the-desktop");
          // And one made in another browser, which the server writes, is the site's here.
          const elsewhere = databases.map((database) => ({
            ...database,
            stores: database.stores.map((store) => ({
              ...store,
              records: store.records.map((record) => ({
                ...record,
                value: {
                  fbase_key: "firebase:authUser:fake-key:[DEFAULT]",
                  value: { uid: "person-elsewhere" },
                },
              })),
            })),
          }));
          yield* host.navigate({ tab, to: { kind: "url", url: `${site}/` } });
          const written = yield* host.writeStorage([
            { origin: auth, localStorage: [], indexedDb: elsewhere },
          ]);
          assert.deepStrictEqual(written, {});
          yield* host.navigate({ tab, to: { kind: "url", url: `${auth}/whoami` } });
          const who = yield* host.evaluate({ tab, expression: "window.who", awaitPromise: true });
          assert.strictEqual(who.value, "person-elsewhere");
          // Deleting a database a page of the origin may hold open waits until no tab shows it.
          const held = yield* host.writeStorage([
            { origin: auth, localStorage: [], indexedDb: [] },
          ]);
          assert.deepStrictEqual(held, { waiting: [auth] });
          yield* host.navigate({ tab, to: { kind: "url", url: `${site}/` } });
          const signedOut = yield* host.writeStorage([
            { origin: auth, localStorage: [], indexedDb: [] },
          ]);
          assert.deepStrictEqual(signedOut, {});
          const gone = yield* host.readStorage({ origins: [auth], indexedDb: true });
          assert.deepStrictEqual(gone.origins, [{ origin: auth, localStorage: [], indexedDb: [] }]);

          // Signing out of a site clears its storage, and what its open tab keeps for the session.
          yield* host.evaluate({
            tab,
            expression: `sessionStorage.setItem("s", "1")`,
            awaitPromise: false,
          });
          yield* host.clearStorage({ origins: [site] });
          // `sessionStorage` lasts across a tab's pages: gone after another, it was cleared.
          yield* host.navigate({ tab, to: { kind: "url", url: `${site}/` } });
          const left = yield* host.evaluate({
            tab,
            expression: `[localStorage.getItem("k"), sessionStorage.getItem("s")]`,
            awaitPromise: false,
          });
          assert.deepStrictEqual(left.value, [null, null]);
          // Signing out of a site embedded in another's page clears what it keeps there too.
          const elsewhereSite = `http://elsewhere.localhost:${port}`;
          const keptThere = Effect.gen(function* () {
            yield* host.navigate({ tab, to: { kind: "url", url: `${site}/embeds` } });
            const kept = yield* host.evaluate({
              tab,
              expression: "window.kept",
              awaitPromise: true,
            });
            return kept.value;
          });
          assert.strictEqual(yield* keptThere, null);
          assert.strictEqual(yield* keptThere, "1");
          yield* host.clearStorage({ origins: [elsewhereSite] });
          assert.strictEqual(yield* keptThere, null);
          yield* host.navigate({ tab, to: { kind: "url", url: `${site}/` } });

          // A pop-up is a tab of its own, which the server hears of and can drive.
          yield* host.act({ tab, action: { action: "click", locator: "text=Open pop-up" } });
          const opened = yield* next(events, "tab.opened");
          assert.strictEqual(opened.opener, tab);
          const popup = opened.page.tab;
          // The click closes its own page: whether the click is answered before the page
          // goes, or answers that the tab closed, is a race, and either is right.
          yield* host.act({ tab: popup, action: { action: "click", locator: "text=Close" } }).pipe(
            Effect.catchIf(
              (error) => error.reason === "closed",
              () => Effect.void,
            ),
          );
          yield* next(events, "tab.closed", (event) => event.tab === popup);

          // A bot's download is kept for the server, once.
          yield* host.act({ tab, action: { action: "click", locator: "text=Get the file" } });
          // Told as it begins, so the server decides then whose it is; finished under the same id.
          const started = yield* next(events, "download.started");
          assert.strictEqual(started.tab, tab);
          const finished = yield* next(events, "download.finished");
          assert.strictEqual(finished.download, started.download);
          assert.strictEqual(finished.name, "report.txt");
          const { bytes } = yield* host.takeDownload({ download: finished.download });
          assert.strictEqual(new TextDecoder().decode(bytes), "hello");
          assert.strictEqual(
            reasonOf(yield* Effect.flip(host.takeDownload({ download: finished.download }))),
            "invalid-target",
          );

          // Only a file the server sent for the tab: no other file of this computer's.
          assert.strictEqual(
            reasonOf(
              yield* Effect.flip(
                host.act({
                  tab,
                  action: {
                    action: "upload",
                    locator: "input[type=file]",
                    paths: [`${import.meta.dirname}/browserHost.test.ts`],
                  },
                }),
              ),
            ),
            "invalid-target",
          );

          // A file the server hands over goes to the page's file input.
          const { path } = yield* host.putFile({
            tab,
            name: "notes.txt",
            bytes: new TextEncoder().encode("notes"),
          });
          yield* host.act({
            tab,
            action: { action: "upload", locator: "input[type=file]", paths: [path] },
          });
          yield* next(events, "tab.changed", (event) => event.page.title === "notes.txt");

          // A dialog waits for an answer.
          yield* host.act({ tab, action: { action: "click", locator: "text=Alert" } });
          yield* next(events, "tab.changed", (event) => event.page.dialog !== null);
          yield* host.dialog({ tab, accept: true });

          // A saved login is typed and sent while the person's input is held: the bot's Enter passes.
          yield* host.navigate({ tab, to: { kind: "url", url: `${site}/login` } });
          yield* host.evaluate({
            tab,
            expression: `document.querySelector("input").focus()`,
            awaitPromise: false,
          });
          const { fill } = host;
          const filled = yield* fill({
            tab,
            field: "password",
            value: Redacted.make("not-a-real-password"),
            url: `${site}/login`,
            submit: true,
          });
          assert.deepStrictEqual(filled, { _tag: "typed", submitted: true, cleared: true });
          const sent = yield* host.evaluate({
            tab,
            expression: "document.title",
            awaitPromise: false,
          });
          assert.strictEqual(sent.value, "Sent 19");

          yield* host.close(tab);
          yield* next(events, "tab.closed", (event) => event.tab === tab);

          // A tab on the person's screen with a bot on it draws the bot's pointer in its page
          // (browserHost.main.ts shows it, and puts a bot on it): never in what a bot reads of
          // the page, never in the way of the person's clicks.
          const onScreen = BrowserTabRef.make("tab-presence");
          yield* host.open({
            tab: onScreen,
            url: `${site}/presence`,
            background: false,
            private: false,
          });
          const inPage = (expression: string) =>
            Effect.map(
              host.evaluate({ tab: onScreen, expression, awaitPromise: false }),
              ({ value }) => value,
            );
          yield* host.waitFor({ tab: onScreen, condition: { locator: "j3-presence" } });
          // The page sees only an element with no way in, over the whole of it, that no click lands on.
          assert.deepStrictEqual(
            yield* inPage(`(() => {
              const drawing = document.querySelector("j3-presence");
              const box = drawing.getBoundingClientRect();
              return {
                open: drawing.shadowRoot !== null,
                hidden: drawing.getAttribute("aria-hidden"),
                covers: box.width === innerWidth && box.height === innerHeight,
              };
            })()`),
            { open: false, hidden: "true", covers: true },
          );
          yield* host.act({ tab: onScreen, action: { action: "click", locator: "#press" } });
          assert.strictEqual(yield* inPage("document.title"), "Pressed 1");
          const seenByBot = yield* host.snapshot({ tab: onScreen, includeImage: false });
          assert.include(seenByBot.tree, "Press");
          assert.notInclude(seenByBot.tree, "Pointer Check");
          assert.notInclude(seenByBot.tree, "j3-presence");
          // The person's click, where the bot's pointer was drawn, lands on the page.
          const point = yield* inPage(`(() => {
            const box = document.getElementById("press").getBoundingClientRect();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            return { x, y, under: document.elementFromPoint(x, y)?.id ?? null };
          })()`).pipe(Effect.map(decodePoint));
          assert.strictEqual(point.under, "press");
          const press = (action: "down" | "up") =>
            host.input({
              tab: onScreen,
              input: {
                type: "pointer",
                action,
                x: point.x,
                y: point.y,
                button: "left",
                buttons: action === "down" ? 1 : 0,
                clickCount: 1,
                modifiers: 0,
              },
            });
          yield* press("down");
          yield* press("up");
          assert.strictEqual(yield* inPage("document.title"), "Pressed 2");
          // The person sees the bot's pointer and its tag in the page: the check's main
          // sends what the tab's view shows as its title asks.
          yield* inPage(`document.title = "Look"`);
          const asShown = inkOf(yield* Deferred.await(pictured).pipe(Effect.timeout(STEP)));
          assert.isAbove(asShown.blue, 0);
          assert.isAbove(asShown.white, 0);
          // A picture for a bot leaves the pointer out, and it shows again after.
          const image = yield* host.screenshot({ tab: onScreen, format: "png" });
          assert.deepStrictEqual(inkOf(Buffer.from(image.data, "base64")), { blue: 0, white: 0 });
          assert.strictEqual(
            yield* inPage(`getComputedStyle(document.querySelector("j3-presence")).opacity`),
            "1",
          );
          // A field the bot types in shows the bot's caret.
          yield* host.act({
            tab: onScreen,
            action: { action: "type", locator: "#field", text: "hi" },
          });
          assert.notStrictEqual(
            yield* inPage(`document.getElementById("field").style.caretColor`),
            "",
          );
        }).pipe(withServer),
      120_000,
    );
  },
);
