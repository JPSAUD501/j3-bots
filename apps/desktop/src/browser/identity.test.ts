// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { identityOf, withNavigationHints } from "./identity.ts";

const linux = identityOf({
  chromeVersion: "152.0.7977.169",
  platform: "linux",
  arch: "arm64",
  platformVersion: "",
});

it("presents the app's browser as Chrome of its own version, with nothing that names Electron", () => {
  assert.strictEqual(
    linux.userAgent,
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  assert.deepStrictEqual(linux.metadata.fullVersionList.map(({ brand }) => brand).sort(), [
    "Chromium",
    "Google Chrome",
    "Not?A_Brand",
  ]);
  assert.deepStrictEqual(linux.metadata.formFactors, ["Desktop"]);
  assert.strictEqual(linux.metadata.architecture, "arm");
});

it("orders the brands as Chromium does for the major version, the same in headers and the page", () => {
  // Chromium 152: order 152 % 6 = 2, grease characters 152 % 11 and 153 % 11, version 152 % 3.
  assert.strictEqual(
    linux.navigationHeaders["sec-ch-ua"],
    '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
  );
  assert.deepStrictEqual(
    linux.metadata.brands.map(({ brand }) => brand),
    linux.metadata.fullVersionList.map(({ brand }) => brand),
  );
});

it("adds the hints to a navigation of a secure page that has none, and leaves the rest", () => {
  const headers = { "User-Agent": linux.userAgent };
  const added = withNavigationHints(linux, {
    url: "https://shop.example/",
    resourceType: "mainFrame",
    requestHeaders: headers,
  });
  assert.strictEqual(added?.["sec-ch-ua-platform"], '"Linux"');
  for (const request of [
    { url: "http://shop.example/", resourceType: "mainFrame" },
    { url: "https://shop.example/app.js", resourceType: "script" },
  ]) {
    assert.isNull(withNavigationHints(linux, { ...request, requestHeaders: headers }));
  }
  assert.isNull(
    withNavigationHints(linux, {
      url: "http://a.j3test.localhost/",
      resourceType: "subFrame",
      requestHeaders: { ...headers, "Sec-CH-UA": "x" },
    }),
  );
});
