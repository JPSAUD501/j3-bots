// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { nativeIconFiles } from "./nativeIcons.ts";
import { readPng } from "./readPng.ts";

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

describe("Android's adaptive icon", () => {
  it("keeps the mark inside the 66 dp circle of its 108 dp layer, which every mask shows", () => {
    const body = nativeIconFiles.find(([path]) => path === "adaptive-monochrome.png")?.[1];
    const png = body?.();
    if (!(png instanceof Uint8Array)) throw new Error("The monochrome layer is a PNG.");
    const { width, rgba } = readPng(png);
    let reach = 0;
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        if ((rgba(x, y)[3] ?? 0) === 0) continue;
        reach = Math.max(reach, Math.hypot(x + 0.5 - width / 2, y + 0.5 - width / 2));
      }
    }
    expect(reach).toBeGreaterThan(0);
    expect(reach).toBeLessThan((33 / 108) * width);
  });
});
