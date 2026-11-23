// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a test that reads the client's own sources, outside any Effect program.
import * as NodeFS from "node:fs";
import { shadows } from "@j3-bots/design-tokens";
import { expect, it } from "vite-plus/test";

// The theme replaces Tailwind's shadow scale with the elevation tokens, so a
// shadow utility outside them builds no rule and draws nothing, silently.
it("uses only the elevation tokens as shadows", () => {
  const known = new Set<string>([...Object.keys(shadows), "none"]);
  const root = new URL("./", import.meta.url);
  const unknown: Array<string> = [];
  for (const path of NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!/\.(tsx?|css)$/.test(path)) continue;
    const source = NodeFS.readFileSync(new URL(path, root), "utf8");
    for (const match of source.matchAll(/(?<![\w-])shadow-([a-z][a-z0-9-]*)/g)) {
      const name = match[1];
      if (name !== undefined && !known.has(name)) unknown.push(`${path}: shadow-${name}`);
    }
  }
  expect(unknown).toEqual([]);
});
