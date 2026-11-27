// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { type BrowserHostError, BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { MASKED_VALUE } from "./redact.ts";
import { makeDriverPage } from "./DriverPage.ts";

/** A Chromium to drive; CI and the checks set it, and without one these tests are skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

const SITE = "http://site.test";

/** Fake pages, served by the test itself: nothing leaves the machine. */
const PAGES: Readonly<Record<string, string>> = {
  "/form": `<title>Form</title>
    <label>Name <input id="name"></label>
    <button onclick="document.querySelector('#out').textContent = 'sent ' + document.querySelector('#name').value">Send</button>
    <p id="out"></p>`,
  "/other": `<title>Other</title><button>Elsewhere</button>`,
  "/secret": `<title>Signed in as hunter-two-secret</title>
    <label>Password <input type="password" value="hunter-two-secret"></label>
    <p>Your password is hunter-two-secret</p>`,
  "/dialog": `<title>Dialog</title><button onclick="document.title = String(confirm('Leave?'))">Leave</button>`,
};

/** A driver over a fresh page of a Chromium launched for the test. */
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
  yield* Effect.promise(() =>
    page.route(`${SITE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = PAGES[path];
      if (path === "/refused") return route.abort("connectionrefused");
      return body === undefined
        ? route.fulfill({ status: 404, body: "" })
        : route.fulfill({ contentType: "text/html", body });
    }),
  );
  const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
  return yield* makeDriverPage({ tab: BrowserTabRef.make("tab-1"), page, cdp });
});

const refOf = (tree: string, name: string) => {
  // Other attributes, such as [active], may come before the ref.
  const ref = new RegExp(`"${name}"(?: \\[[^\\]]+\\])*? \\[ref=(\\S+?)\\]`).exec(tree)?.[1];
  if (ref === undefined) throw new Error(`No ref for ${name} in:\n${tree}`);
  return `aria-ref=${ref}`;
};

const reason = (error: BrowserHostError) => error.reason;

describe.skipIf(executablePath === undefined)("makeDriverPage", () => {
  it.live(
    "acts by the refs of the latest snapshot, and refuses them once the page changed",
    () =>
      Effect.gen(function* () {
        const driver = yield* driven;
        yield* driver.navigate({ kind: "url", url: `${SITE}/form` }, {});
        const first = yield* driver.snapshot({ includeImage: false });
        assert.strictEqual(first.title, "Form");
        const name = refOf(first.tree, "Name");
        assert.match(name, /^aria-ref=j3-[a-z\d]+-[a-z\d]+-e\d+$/);

        yield* driver.act({ action: "type", locator: name, text: "Ada" });
        yield* driver.act({ action: "click", locator: refOf(first.tree, "Send") });
        yield* driver.waitFor({ text: "sent Ada", timeoutMs: 2_000 });
        assert.deepStrictEqual(
          yield* driver.evaluate({
            expression: "document.querySelector('#out').textContent",
            awaitPromise: false,
          }),
          { value: "sent Ada" },
        );

        // A newer snapshot replaces the refs, even of the same page.
        const second = yield* driver.snapshot({ includeImage: false });
        assert.strictEqual(
          reason(yield* Effect.flip(driver.act({ action: "hover", locator: name }))),
          "stale-ref",
        );
        const send = refOf(second.tree, "Send");
        yield* driver.navigate({ kind: "url", url: `${SITE}/other` }, {});
        assert.strictEqual(
          reason(yield* Effect.flip(driver.act({ action: "click", locator: send }))),
          "stale-ref",
        );
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "tells a tap on a text field from a tap elsewhere",
    () =>
      Effect.gen(function* () {
        const driver = yield* driven;
        yield* driver.navigate({ kind: "url", url: `${SITE}/form` }, {});
        const { tree } = yield* driver.snapshot({ includeImage: false });
        const centre = (name: string) => {
          const box = new RegExp(`"${name}".*\\[box=(\\d+),(\\d+),(\\d+),(\\d+)\\]`).exec(tree);
          const [x, y, width, height] = (box ?? []).slice(1).map(Number);
          if (x === undefined || y === undefined || width === undefined || height === undefined)
            throw new Error(`No box for ${name} in:\n${tree}`);
          return [x + width / 2, y + height / 2] as const;
        };
        assert.isTrue(yield* driver.probe(...centre("Name")));
        assert.isFalse(yield* driver.probe(...centre("Send")));
        const waited = yield* Effect.flip(driver.waitFor({ text: "never shown", timeoutMs: 300 }));
        assert.strictEqual(waited.reason, "timeout");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "hides a password's value everywhere the snapshot shows it",
    () =>
      Effect.gen(function* () {
        const driver = yield* driven;
        yield* driver.navigate({ kind: "url", url: `${SITE}/secret` }, {});
        const snapshot = yield* driver.snapshot({ includeImage: true });
        assert.notInclude(snapshot.tree, "hunter-two-secret");
        assert.include(snapshot.tree, `Your password is ${MASKED_VALUE}`);
        assert.strictEqual(snapshot.title, `Signed in as ${MASKED_VALUE}`);
        assert.strictEqual(snapshot.image?.mimeType, "image/png");
        assert.isAbove(snapshot.image?.width ?? 0, 0);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "reports a page that failed to load, and refuses an address that is not the web",
    () =>
      Effect.gen(function* () {
        const driver = yield* driven;
        const failed = yield* driver.navigate({ kind: "url", url: `${SITE}/refused` }, {});
        assert.strictEqual(failed.url, `${SITE}/refused`);
        assert.deepStrictEqual(failed.loadError, {
          url: `${SITE}/refused`,
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });
        assert.strictEqual(
          reason(
            yield* Effect.flip(driver.navigate({ kind: "url", url: "file:///etc/hosts" }, {})),
          ),
          "refused",
        );
        const loaded = yield* driver.navigate({ kind: "url", url: `${SITE}/form` }, {});
        assert.strictEqual(loaded.loadError, null);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "returns from a click that opens a dialog, and answers the dialog",
    () =>
      Effect.gen(function* () {
        const driver = yield* driven;
        yield* driver.navigate({ kind: "url", url: `${SITE}/dialog` }, {});
        const { tree } = yield* driver.snapshot({ includeImage: false });
        yield* driver.act({ action: "click", locator: refOf(tree, "Leave") });
        assert.deepStrictEqual((yield* driver.state).dialog, {
          kind: "confirm",
          message: "Leave?",
          defaultValue: "",
        });
        yield* driver.answerDialog(true);
        assert.strictEqual((yield* driver.state).title, "true");
        assert.strictEqual(reason(yield* Effect.flip(driver.answerDialog(true))), "invalid-target");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "stops a script that runs too long, and refuses a result over the limit",
    () =>
      Effect.gen(function* () {
        const driver = yield* driven;
        yield* driver.navigate({ kind: "url", url: `${SITE}/form` }, {});
        const stuck = yield* Effect.flip(
          driver.evaluate({ expression: "while (true) {}", awaitPromise: false, timeoutMs: 500 }),
        );
        assert.strictEqual(stuck.reason, "timeout");
        // The page answers again once the script is stopped.
        assert.deepStrictEqual(
          yield* driver.evaluate({ expression: "1 + 1", awaitPromise: false }),
          { value: 2 },
        );
        assert.deepStrictEqual(
          yield* driver.evaluate({
            expression: "await new Promise((done) => setTimeout(() => done('later'), 10))",
            awaitPromise: true,
          }),
          { value: "later" },
        );
        assert.strictEqual(
          reason(
            yield* Effect.flip(
              driver.evaluate({ expression: "'x'.repeat(70000)", awaitPromise: false }),
            ),
          ),
          "too-large",
        );
      }).pipe(Effect.scoped),
    60_000,
  );
});
