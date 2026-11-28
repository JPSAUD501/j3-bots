// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Electron runs as a child the check starts and stops, on a folder it makes and removes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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

/** The server's side: the host that dialed in, and the fake site on the same port. */
const playServer = Effect.gen(function* () {
  const reached = yield* Deferred.make<PageHost>();
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
      return PAGES[path]?.() ?? HttpServerResponse.empty({ status: 404 });
    }).pipe(Effect.scoped),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(done, undefined));
  const { address } = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(address))
    return yield* Effect.die("The check's server has no port.");
  return { port: address.port, reached };
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

describe.skipIf(process.platform !== "linux" || process.env["DISPLAY"] === undefined)(
  "the desktop's browser, driven by a server",
  () => {
    it.live(
      "runs the server's tabs: pages, pop-ups, downloads, uploads, dialogs and sign-ins",
      () =>
        Effect.gen(function* () {
          const { port, reached } = yield* playServer;
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
          const filled = yield* host.fill({
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
        }).pipe(withServer),
      120_000,
    );
  },
);
