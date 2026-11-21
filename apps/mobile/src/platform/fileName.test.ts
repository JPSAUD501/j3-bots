// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { localFileName } from "./fileName.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("localFileName", () => {
  it("keeps a file inside its folder", () => {
    expect(localFileName("../../shared_prefs/x.xml")).toBe(".._.._shared_prefs_x.xml");
    expect(localFileName("a\\b\u0000c")).toBe("a_b_c");
    expect(localFileName("..")).toBe("file");
    expect(localFileName(".")).toBe("file");
  });

  it("keeps a name as given when the file system takes it", () => {
    expect(localFileName("Relatório de março.pdf")).toBe("Relatório de março.pdf");
  });

  it("shortens a name too long in bytes before its extension, by whole characters", () => {
    const name = `${"日本語".repeat(66)}.pdf`;
    const local = localFileName(name);
    expect(bytes(local)).toBeLessThanOrEqual(255);
    // Three bytes a character: 83 of them and the extension fit.
    expect(local).toBe(`${Array.from(name).slice(0, 83).join("")}.pdf`);
  });
});
