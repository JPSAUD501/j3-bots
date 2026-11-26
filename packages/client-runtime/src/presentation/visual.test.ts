// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_VISUAL_HEIGHT,
  MIN_VISUAL_HEIGHT,
  VISUAL_CONTENT_SECURITY_POLICY,
} from "@j3-bots/contracts";
import { visualColors } from "@j3-bots/design-tokens";
import { assert, describe, it } from "@effect/vitest";
import {
  readVisualHeight,
  readVisualReport,
  VISUAL_HEIGHT_MESSAGE,
  visualDocument,
  visualShell,
} from "./visual.ts";

/** The document built for `page`, which embeds no other. */
const built = (page: string, appearance: "light" | "dark" = "dark"): string => {
  const document = visualDocument(page, appearance);
  if (document === null) throw new Error(`no document for ${page}`);
  return document;
};

describe("a visual's document", () => {
  const page = '<!doctype html><html><head><script>fetch("https://x.test")</script></head></html>';

  it("opens with the policy, then the guard and the height reporter, before anything of the page", () => {
    const document = built(page);
    const policy = `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">`;
    assert.isTrue(document.startsWith(`<!doctype html>${policy}`));
    assert.isTrue(document.endsWith(page));
    const scripts = [...document.slice(0, -page.length).matchAll(/<script>([^]*?)<\/script>/g)];
    assert.strictEqual(scripts.length, 2);
    assert.match(scripts[0]?.[1] ?? "", /RTC/, "the guard, first");
    assert.include(scripts[1]?.[1] ?? "", VISUAL_HEIGHT_MESSAGE, "then the height reporter");
  });

  it("is not built for a page that embeds another document or a declarative shadow root", () => {
    assert.isNull(
      visualDocument("<p>Chart</p><iframe srcdoc='<script>1</script>'></iframe>", "light"),
    );
    assert.isNull(
      visualDocument('<div><template shadowrootmode="open"></template></div>', "light"),
    );
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
    const light = built("<p>", "light");
    const dark = built("<p>", "dark");
    assert.include(light, `--background:${visualColors("light").background};`);
    assert.include(light, "color-scheme:light;");
    assert.include(dark, `--chart-1:${visualColors("dark")["chart-1"]};`);
    assert.include(dark, "color-scheme:dark;");
  });
});

describe("a WebView's page for a visual", () => {
  it("holds the document whole, in a frame sandboxed with scripts only, under the visual's policy", () => {
    const document = built('<p title="a &quot;quoted&quot; &amp; tag">"Range" & price</p>');
    const shell = visualShell(document);
    const policy = `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CONTENT_SECURITY_POLICY}">`;
    assert.isTrue(shell.startsWith(`<!doctype html>${policy}`));
    const frame = /<iframe id="visual" sandbox="([^"]*)" srcdoc="([^"]*)"><\/iframe>/.exec(shell);
    assert.strictEqual(frame?.[1], "allow-scripts");
    // A double-quoted attribute's value, as the parser reads it back.
    const read = (frame?.[2] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    assert.strictEqual(read, document);
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

describe("what a WebView's page for a visual passes to the app", () => {
  it("is the visual's height, or that its frame shows something else", () => {
    assert.deepStrictEqual(readVisualReport('{"type":"j3-visual-height","height":5000}'), {
      _tag: "height",
      height: MAX_VISUAL_HEIGHT,
    });
    assert.deepStrictEqual(readVisualReport('{"type":"j3-visual-gone"}'), { _tag: "gone" });
  });

  it("is nothing else", () => {
    for (const data of [
      '{"type":"j3-visual-gone","url":"https://x.test"}',
      '{"type":"j3-visual-open","url":"https://x.test"}',
      "not json",
    ]) {
      assert.isNull(readVisualReport(data), data);
    }
  });
});
