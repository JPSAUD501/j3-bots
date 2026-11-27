// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";

/** The fake sites a test profile is signed in to. */
export const TEST_PROFILE_SITES = {
  mail: "https://mail.example.test",
  notes: "https://notes.other.test",
} as const;

const { mail, notes } = TEST_PROFILE_SITES;

/** The fake sites, served by the test itself: nothing leaves the machine. */
const PAGES: Readonly<
  Record<string, { readonly headers: Record<string, string>; readonly body: string }>
> = {
  [`${mail}/`]: {
    headers: {
      "set-cookie": [
        "remember=r1; Path=/; Max-Age=3600; Domain=example.test; Secure; SameSite=Strict",
        "plain=p1; Path=/; Max-Age=3600; Secure; HttpOnly",
      ].join("\n"),
    },
    body: `<script>
      localStorage.setItem("token", "t1");
      const open = indexedDB.open("mail", 2);
      open.onupgradeneeded = () => open.result.createObjectStore("drafts", { keyPath: "id" });
      open.onsuccess = () => {
        const done = open.result.transaction("drafts", "readwrite");
        done.objectStore("drafts").put({ id: 1, text: "hello" });
        done.oncomplete = () => { document.title = "ready"; };
      };
    </script>`,
  },
  [`${notes}/`]: {
    headers: {},
    body: `<script>localStorage.setItem("theme", "dark"); document.title = "ready";</script>`,
  },
};

/**
 * A Chromium profile at `profile`, written by the Chromium at `executable`,
 * signed in to `TEST_PROFILE_SITES`: two cookies of mail's (one for its
 * host alone, set without SameSite), its token and a database, and notes'
 * theme.
 */
export const writeTestProfile = (profile: string, executable: string) =>
  Effect.promise(async () => {
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: executable,
      headless: true,
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const page = PAGES[`${url.origin}${url.pathname}`];
      return page === undefined
        ? route.fulfill({ status: 404, body: "" })
        : route.fulfill({ contentType: "text/html", headers: page.headers, body: page.body });
    });
    const page = context.pages()[0] ?? (await context.newPage());
    for (const site of [mail, notes]) {
      await page.goto(`${site}/`);
      await page.waitForFunction('document.title === "ready"');
    }
    await context.close();
  });
