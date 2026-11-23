// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_VISUAL_HEIGHT, MIN_VISUAL_HEIGHT } from "@j3-bots/contracts";
import { visualColors } from "@j3-bots/design-tokens";
import { assert, describe, it } from "@effect/vitest";
import { readVisualHeight, VISUAL_CONTENT_SECURITY_POLICY, visualDocument } from "./visual.ts";

describe("a visual's document", () => {
  const page = '<!doctype html><html><head><script>fetch("https://x.test")</script></head></html>';

  it("opens with the policy, before anything of the page", () => {
    const document = visualDocument(page, "dark");
    const policy = `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">`;
    assert.isTrue(document.startsWith(`<!doctype html>${policy}`));
    assert.isTrue(document.endsWith(page));
  });

  it("lets nothing reach the network", () => {
    const directives = new Map(
      VISUAL_CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
        const [name = "", ...sources] = directive.split(" ");
        return [name, sources] as const;
      }),
    );
    assert.deepStrictEqual(directives.get("default-src"), ["'none'"]);
    assert.deepStrictEqual(directives.get("connect-src"), ["'none'"]);
    assert.deepStrictEqual(directives.get("img-src"), ["data:", "blob:"]);
    assert.deepStrictEqual(directives.get("font-src"), ["data:"]);
    assert.deepStrictEqual(directives.get("script-src"), ["'unsafe-inline'"]);
    for (const name of ["frame-src", "form-action", "base-uri"]) {
      assert.deepStrictEqual(directives.get(name), ["'none'"], name);
    }
  });

  it("carries the theme it is built for", () => {
    const light = visualDocument("<p>", "light");
    const dark = visualDocument("<p>", "dark");
    assert.include(light, `--background:${visualColors("light").background};`);
    assert.include(light, "color-scheme:light;");
    assert.include(dark, `--chart-1:${visualColors("dark")["chart-1"]};`);
    assert.include(dark, "color-scheme:dark;");
  });
});

describe("a visual's height", () => {
  it("is read from its own message alone, as an object or as JSON", () => {
    assert.strictEqual(readVisualHeight({ type: "j3-visual-height", height: 412.2 }), 413);
    assert.strictEqual(readVisualHeight('{"type":"j3-visual-height","height":300}'), 300);
  });

  it("is fitted to what a frame is drawn at inline", () => {
    assert.strictEqual(
      readVisualHeight({ type: "j3-visual-height", height: 1e9 }),
      MAX_VISUAL_HEIGHT,
    );
    assert.strictEqual(
      readVisualHeight({ type: "j3-visual-height", height: 3 }),
      MIN_VISUAL_HEIGHT,
    );
  });

  it("is never taken from anything else a page sends", () => {
    for (const data of [
      { type: "j3-visual-height", height: 300, navigate: "https://x.test" },
      { type: "j3-visual-height", height: "300" },
      { type: "j3-visual-height", height: Number.POSITIVE_INFINITY },
      { type: "j3-visual-height", height: -5 },
      { type: "j3-visual-open", url: "https://x.test" },
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 300 } },
      "not json",
      null,
      300,
    ]) {
      assert.isNull(readVisualHeight(data), JSON.stringify(data));
    }
  });
});
