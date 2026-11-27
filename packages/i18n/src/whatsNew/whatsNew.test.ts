// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The release workflow reads the files in this folder, so the test lists them as they are on disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { WHATS_NEW } from "./index.ts";

// The release workflow refuses a tag with no `v<x.y.z>.ts` here, and reads
// nothing else: so each such file must be listed, as the release it names.

describe("What's new", () => {
  it("lists every release's file, once, as the release its name says", () => {
    const files = NodeFS.readdirSync(import.meta.dirname)
      .flatMap((name) => /^v(\d+\.\d+\.\d+)\.ts$/.exec(name)?.[1] ?? [])
      .sort();
    const listed = WHATS_NEW.map((release) => release.version).sort();
    expect(listed).toEqual(files);
  });
});
