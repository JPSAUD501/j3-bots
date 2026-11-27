// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { type BrowserFillField, BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { chromium, type Page } from "playwright-core";
import { makeDriverPage } from "./DriverPage.ts";

/** A Chromium to drive; CI and the checks set it, and without one these tests are skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

const SITE = "http://login.test";
const OTHER = "http://elsewhere.test";
const SECRET = "correct horse 7";

/** Fake pages, served by the test itself: nothing leaves the machine. */
const PAGES: Readonly<Record<string, string>> = {
  [`${SITE}/login`]: `<title>Sign in</title>
    <form method="post" action="/home">
      <input id="user" name="user" type="email">
      <input id="pw" name="pw" type="password">
      <input id="search" type="search">
      <input id="hidden" type="password" style="width: 0; height: 0; border: 0; padding: 0">
      <textarea id="comment"></textarea>
      <button>Sign in</button>
    </form>
    <iframe id="same" src="/frame"></iframe>
    <iframe id="cross" src="${OTHER}/frame"></iframe>
    <div id="host"></div>
    <script>
      document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML =
        '<input id="shadowed" type="password">';
    </script>`,
  [`${SITE}/stays`]: `<title>Sign in</title>
    <form onsubmit="event.preventDefault(); document.title = 'Wrong password'">
      <input id="pw" type="password">
    </form>`,
  [`${SITE}/pushes`]: `<title>Sign in</title>
    <form onsubmit="event.preventDefault(); history.pushState({}, '', '/try-again')">
      <input id="pw" type="password">
    </form>`,
  // Moves the focus between its field and a frame of another site on every task.
  [`${SITE}/race`]: `<title>Sign in</title>
    <input id="pw" type="password">
    <iframe id="cross" src="${OTHER}/catch"></iframe>
    <script>
      const pw = document.querySelector("#pw");
      const frame = document.querySelector("#cross");
      let inFrame = false;
      const flip = () => {
        inFrame = !inFrame;
        (inFrame ? frame : pw).focus();
        setTimeout(flip, 0);
      };
      frame.addEventListener("load", flip);
    </script>`,
  [`${OTHER}/catch`]: `<input id="inner" type="password">
    <script>addEventListener("focus", () => document.querySelector("#inner").focus());</script>`,
  [`${SITE}/frame`]: `<input id="inner" type="password">`,
  [`${OTHER}/frame`]: `<input id="inner" type="password">`,
  [`${SITE}/home`]: `<title>Home</title>`,
};

/** A driver over a page of a Chromium launched for the test, and the forms posted to it. */
const driven = Effect.gen(function* () {
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launch({
        ...(executablePath === undefined ? {} : { executablePath }),
        headless: true,
      }),
    ),
    (opened) => Effect.promise(() => opened.close()),
  );
  const page = yield* Effect.promise(() => browser.newPage());
  const posted: Array<string> = [];
  yield* Effect.promise(() =>
    page.context().route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = PAGES[`${url.origin}${url.pathname}`];
      if (request.method() === "POST") posted.push(request.postData() ?? "");
      return body === undefined
        ? route.fulfill({ status: 404, body: "" })
        : route.fulfill({ contentType: "text/html", body });
    }),
  );
  const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
  const driver = yield* makeDriverPage({ tab: BrowserTabRef.make("tab-1"), page, cdp });
  return { driver, page, posted };
});

const open = (page: Page, path: string) =>
  Effect.promise(() => page.goto(`${SITE}${path}`, { waitUntil: "load" }));

const fillOf = (field: BrowserFillField, url: string, submit = false) => ({
  field,
  value: Redacted.make(SECRET),
  url,
  submit,
});

const valueOf = (page: Page, selector: string) =>
  Effect.promise(() => page.locator(selector).inputValue());

describe.skipIf(executablePath === undefined)("fill", () => {
  it.live(
    "types a password into the focused field, submits it and leaves the next page alone",
    () =>
      Effect.gen(function* () {
        const { driver, page, posted } = yield* driven;
        yield* open(page, "/login");
        yield* Effect.promise(() => page.focus("#pw"));
        const result = yield* driver.fill(fillOf("password", `${SITE}/login`));
        assert.deepStrictEqual(result, { _tag: "typed", submitted: true, cleared: false });
        assert.strictEqual(page.url(), `${SITE}/home`);
        assert.deepStrictEqual(posted, [
          `user=&pw=${encodeURIComponent(SECRET).replaceAll("%20", "+")}`,
        ]);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "takes a password out of a field the page keeps after the submit",
    () =>
      Effect.gen(function* () {
        const { driver, page } = yield* driven;
        yield* open(page, "/stays");
        yield* Effect.promise(() => page.focus("#pw"));
        const result = yield* driver.fill(fillOf("password", `${SITE}/stays`));
        assert.deepStrictEqual(result, { _tag: "typed", submitted: true, cleared: true });
        assert.strictEqual(yield* valueOf(page, "#pw"), "");
        assert.strictEqual(yield* Effect.promise(() => page.title()), "Wrong password");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "takes a password out of a field the page keeps while it changes its address in place",
    () =>
      Effect.gen(function* () {
        const { driver, page } = yield* driven;
        yield* open(page, "/pushes");
        yield* Effect.promise(() => page.focus("#pw"));
        const result = yield* driver.fill(fillOf("password", `${SITE}/pushes`));
        assert.deepStrictEqual(result, { _tag: "typed", submitted: true, cleared: true });
        assert.strictEqual(page.url(), `${SITE}/try-again`);
        assert.strictEqual(yield* valueOf(page, "#pw"), "");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "never types into a frame the page moves the focus to, however it times the move",
    () =>
      Effect.gen(function* () {
        const { driver, page } = yield* driven;
        yield* open(page, "/race");
        const outcomes = new Set<string>();
        let typed = 0;
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = yield* driver.fill(fillOf("totp", `${SITE}/race`));
          outcomes.add(result._tag === "typed" ? "typed" : result.reason);
          if (result._tag === "typed") typed++;
        }
        // Each fill either typed into the page's own field or typed nothing.
        assert.isTrue([...outcomes].every((outcome) => outcome === "typed" || outcome === "field"));
        const inner = yield* Effect.promise(() =>
          page.frameLocator("#cross").locator("#inner").inputValue(),
        );
        assert.strictEqual(inner, "");
        assert.strictEqual(yield* valueOf(page, "#pw"), SECRET.repeat(typed));
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "types a user name into an email field, and into a field behind an open shadow root",
    () =>
      Effect.gen(function* () {
        const { driver, page } = yield* driven;
        yield* open(page, "/login");
        yield* Effect.promise(() => page.focus("#user"));
        assert.deepStrictEqual(yield* driver.fill(fillOf("username", `${SITE}/login`)), {
          _tag: "typed",
          submitted: false,
          cleared: false,
        });
        assert.strictEqual(yield* valueOf(page, "#user"), SECRET);

        yield* Effect.promise(() => page.locator("#shadowed").focus());
        const shadowed = yield* driver.fill(fillOf("password", `${SITE}/login`));
        assert.strictEqual(shadowed._tag, "typed");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "refuses a field that does not fit, and focus inside a frame, and types nothing",
    () =>
      Effect.gen(function* () {
        const { driver, page } = yield* driven;
        yield* open(page, "/login");
        const refusedIn = (focus: Effect.Effect<void>, field: BrowserFillField) =>
          focus.pipe(Effect.andThen(driver.fill(fillOf(field, `${SITE}/login`))));
        const field = { _tag: "refused", reason: "field" } as const;

        // A comment box, a search box, the wrong kind of field, a hidden one.
        assert.deepStrictEqual(
          yield* refusedIn(
            Effect.promise(() => page.focus("#comment")),
            "password",
          ),
          field,
        );
        assert.deepStrictEqual(
          yield* refusedIn(
            Effect.promise(() => page.focus("#search")),
            "username",
          ),
          field,
        );
        assert.deepStrictEqual(
          yield* refusedIn(
            Effect.promise(() => page.focus("#user")),
            "password",
          ),
          field,
        );
        assert.deepStrictEqual(
          yield* refusedIn(
            Effect.promise(() => page.focus("#hidden")),
            "password",
          ),
          field,
        );
        // A password field in an embedded frame, of the same site and of another one.
        for (const frame of ["#same", "#cross"]) {
          assert.deepStrictEqual(
            yield* refusedIn(
              Effect.promise(() => page.frameLocator(frame).locator("#inner").focus()),
              "password",
            ),
            field,
          );
          const inner = yield* Effect.promise(() =>
            page.frameLocator(frame).locator("#inner").inputValue(),
          );
          assert.strictEqual(inner, "");
        }
        for (const selector of ["#comment", "#search", "#user", "#hidden"])
          assert.strictEqual(yield* valueOf(page, selector), "");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "refuses a page that is not at the address the server checked",
    () =>
      Effect.gen(function* () {
        const { driver, page } = yield* driven;
        yield* open(page, "/login");
        yield* Effect.promise(() => page.focus("#pw"));
        assert.deepStrictEqual(yield* driver.fill(fillOf("password", `${SITE}/elsewhere`)), {
          _tag: "refused",
          reason: "navigated",
        });
        assert.strictEqual(yield* valueOf(page, "#pw"), "");
      }).pipe(Effect.scoped),
    60_000,
  );
});
