// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { nativeIconFiles } from "./nativeIcons.ts";

const icons = fileURLToPath(new URL("../../generated/icons/", import.meta.url));

// Run `pnpm --filter @j3-bots/design-tokens generate` when these fail.
describe("generated icons", () => {
  it("are exactly the files the generator writes", () => {
    const committed = NodeFS.readdirSync(icons, { recursive: true, encoding: "utf8" }).filter(
      (path) => NodeFS.statSync(NodePath.join(icons, path)).isFile(),
    );
    expect(committed.sort()).toEqual(nativeIconFiles.map(([path]) => path).sort());
  });

  it.each(nativeIconFiles)("%s is regenerated after every token change", (path, body) => {
    const generated = body();
    const bytes = typeof generated === "string" ? new TextEncoder().encode(generated) : generated;
    expect(Buffer.compare(NodeFS.readFileSync(NodePath.join(icons, path)), bytes)).toBe(0);
  });
});
