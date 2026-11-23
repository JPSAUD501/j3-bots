// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { faceOf } from "./face.ts";

describe("faceOf", () => {
  it("leaves a nested run without a face, so it inherits its parent's", () => {
    expect(faceOf(undefined, true)).toBeUndefined();
  });

  it("puts a text on its own in the text face", () => {
    expect(faceOf(undefined, false)).toBe("text");
  });

  it("keeps a face a run names, nested or not", () => {
    expect(faceOf("mono", true)).toBe("mono");
    expect(faceOf("display", false)).toBe("display");
  });
});
