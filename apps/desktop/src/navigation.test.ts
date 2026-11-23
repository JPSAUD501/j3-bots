// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { externalUrl, isAppUrl, isVisualFrameUrl } from "./navigation.ts";
import { openingBounds } from "./window.ts";

describe("the window", () => {
  it("stays on the app's pages and sends web and mail links to the system", () => {
    assert.isTrue(isAppUrl("j3bots-dev://app/bots/b1", "j3bots-dev://app"));
    assert.isFalse(isAppUrl("j3bots://app/", "j3bots-dev://app"));
    assert.isFalse(isAppUrl("http://192.0.2.10:3737/", "j3bots-dev://app"));
    assert.strictEqual(externalUrl("https://example.com/a"), "https://example.com/a");
    assert.strictEqual(externalUrl("mailto:someone@example.com"), "mailto:someone@example.com");
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "j3bots-dev://app/x",
      "smb://host/share",
      "blob:j3bots-dev://app/1",
    ]) {
      assert.isNull(externalUrl(url), url);
    }
  });

  it("lets a frame in the page go only to the app's visual page", () => {
    assert.isTrue(isVisualFrameUrl("j3bots-dev://app/visual-frame.html", "j3bots-dev://app"));
    for (const url of [
      "j3bots-dev://app/",
      "j3bots-dev://app/visual-frame.html?x=1",
      "j3bots://app/visual-frame.html",
      "https://example.com/visual-frame.html",
      "about:blank",
      "data:text/html,<p>",
    ]) {
      assert.isFalse(isVisualFrameUrl(url, "j3bots-dev://app"), url);
    }
  });

  it("opens where it closed, unless that place is on a display that is gone", () => {
    const display = { x: 0, y: 0, width: 1920, height: 1080 };
    const saved = { x: 100, y: 80, width: 1000, height: 700, maximized: false };
    assert.deepStrictEqual(openingBounds(saved, [display]), {
      bounds: { x: 100, y: 80, width: 1000, height: 700 },
      maximized: false,
    });
    // It closed on a second display that is unplugged now.
    const elsewhere = { ...saved, x: 2500, maximized: true };
    assert.deepStrictEqual(openingBounds(elsewhere, [display]), {
      bounds: { width: 1200, height: 800 },
      maximized: true,
    });
    assert.deepStrictEqual(openingBounds(null, [display]), {
      bounds: { width: 1200, height: 800 },
      maximized: false,
    });
  });
});
