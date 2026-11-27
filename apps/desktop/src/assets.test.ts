// SPDX-License-Identifier: AGPL-3.0-or-later
import { CONNECTOR_APP_FRAME_POLICY, VISUAL_FRAME_POLICY } from "@j3-bots/contracts";
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { contentSecurityPolicy, inlineScriptSources, policyFor, resolveAsset } from "./assets.ts";

const APP = "j3bots-dev://app";
const page = (path: string, { method = "GET", accept = "*/*" } = {}) =>
  resolveAsset({ url: `${APP}${path}`, method, accept }, APP);

describe("the app's scheme", () => {
  it("serves the web build's files, and the app's shell for its own routes", () => {
    assert.deepStrictEqual(page("/assets/index-abc.js"), {
      _tag: "file",
      segments: ["assets", "index-abc.js"],
      appShell: false,
    });
    assert.deepStrictEqual(page("/bots/b1", { accept: "text/html,*/*" }), {
      _tag: "file",
      segments: ["bots", "b1"],
      appShell: true,
    });
    // A missing script is a 404, never the shell.
    assert.deepStrictEqual(page("/assets/gone.js", { accept: "text/html" }), {
      _tag: "file",
      segments: ["assets", "gone.js"],
      appShell: false,
    });
  });

  it("refuses the server's paths, which only the server answers", () => {
    for (const path of [
      "/api/server",
      "/api/pair",
      "/attachments",
      "/attachments/a1",
      "/ws",
      "/hooks/r1/s",
    ]) {
      assert.deepStrictEqual(
        page(path, { accept: "text/html" }),
        { _tag: "refused", status: 404 },
        path,
      );
    }
  });

  it("never leads outside the web build", () => {
    // The URL parser resolves dot segments, encoded ones included, within the root.
    assert.deepStrictEqual(page("/%2e%2e/%2E%2E/secret"), {
      _tag: "file",
      segments: ["secret"],
      appShell: false,
    });
    // What it leaves encoded is refused once decoded.
    for (const path of ["/assets/..%2fsecret", "/a%5c..%5csecret", "/x%00.js", "/%E0%A4%A"]) {
      assert.deepStrictEqual(page(path), { _tag: "refused", status: 400 }, path);
    }
  });

  it("refuses another host on the scheme, another scheme, and writes", () => {
    assert.deepStrictEqual(
      resolveAsset({ url: "j3bots-dev://elsewhere/index.html", method: "GET", accept: null }, APP),
      { _tag: "refused", status: 404 },
    );
    assert.deepStrictEqual(
      resolveAsset({ url: "j3bots://app/index.html", method: "GET", accept: null }, APP),
      { _tag: "refused", status: 404 },
    );
    assert.deepStrictEqual(page("/index.html", { method: "POST" }), {
      _tag: "refused",
      status: 405,
    });
  });
});

describe("the page's content security policy", () => {
  it("lets the page connect to itself and to the named server only", () => {
    const server = Schema.decodeSync(ServerOrigin)("http://192.0.2.10:3737");
    const policy = contentSecurityPolicy(server, []);
    assert.include(policy, "connect-src 'self' http://192.0.2.10:3737 ws://192.0.2.10:3737;");
    const secure = contentSecurityPolicy(
      Schema.decodeSync(ServerOrigin)("https://j3.example.test"),
      [],
    );
    assert.include(secure, "connect-src 'self' https://j3.example.test wss://j3.example.test;");
    assert.include(contentSecurityPolicy(null, []), "connect-src 'self';");
  });

  it("allows exactly the inline scripts the build ships", async () => {
    const html =
      '<head><script>document.documentElement.classList.add("dark");</script>' +
      '<script type="module" crossorigin src="/assets/index.js"></script></head>';
    const sources = await inlineScriptSources(html);
    assert.strictEqual(sources.length, 1);
    // `echo -n 'document…;' | openssl dgst -sha256 -binary | base64`
    assert.deepStrictEqual(sources, ["'sha256-2m0LKtL9TkM7m6BmMncU8A6pAb9ikh3OzrtPZXy+uhU='"]);
    assert.include(
      contentSecurityPolicy(null, sources),
      `script-src 'self' 'wasm-unsafe-eval' ${sources[0]};`,
    );
  });

  it("serves the visual and connector app pages under their own policies, every other under the app's", () => {
    assert.strictEqual(policyFor(["visual-frame.html"], null, []), VISUAL_FRAME_POLICY);
    assert.strictEqual(
      policyFor(["connector-app-frame.html"], null, []),
      CONNECTOR_APP_FRAME_POLICY,
    );
    for (const segments of [["index.html"], ["assets", "visual-frame.html"], []]) {
      assert.strictEqual(policyFor(segments, null, []), contentSecurityPolicy(null, []));
    }
    assert.include(contentSecurityPolicy(null, []), "frame-src 'self';");
  });
});
