// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { ThemeId } from "@j3-bots/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { setAppearance, setThemeId } from "./preferences";

describe("what this browser keeps of its person's choices", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a picked theme by its id, a theme named System included", () => {
    setThemeId(ThemeId.make("system"));
    expect(localStorage.getItem("j3:theme")).toBe("system");
    setThemeId(null);
    expect(localStorage.getItem("j3:theme")).toBeNull();
  });

  it("keeps nothing for light or dark as the system's", () => {
    setAppearance("dark");
    expect(localStorage.getItem("j3:appearance")).toBe("dark");
    setAppearance("system");
    expect(localStorage.getItem("j3:appearance")).toBeNull();
  });
});
