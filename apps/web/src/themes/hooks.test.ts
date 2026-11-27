// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a test that reads the client's own sources, outside any Effect program.
import * as NodeFS from "node:fs";
import { THEME_CSS_HOOKS } from "@j3-bots/design-tokens";
import { describe, expect, it } from "vite-plus/test";

// A theme's CSS is written against these selectors (decision 0104): one that
// left the interface would leave every theme written against it styling
// nothing, with no error anywhere.

const root = new URL("../", import.meta.url);
const source = NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
  .filter((path) => !path.startsWith("gallery/"))
  .map((path) => NodeFS.readFileSync(new URL(path, root), "utf8"))
  .join("\n");

describe("the selectors a theme's CSS relies on", () => {
  const slots = THEME_CSS_HOOKS.flatMap(({ selector }) => {
    const slot = /^\[data-slot="([a-z-]+)"\]$/.exec(selector)?.[1];
    return slot === undefined ? [] : [slot];
  });

  it.each(slots)("are drawn by the interface: %s", (slot) => {
    expect(source).toMatch(new RegExp(`"?data-slot"?(?:\\s*:\\s*|=)"${slot}"`));
  });

  it("say whose a message is", () => {
    expect(source).toMatch(/data-author=\{fromOperator \? "operator" : "bot"\}/);
  });
});
