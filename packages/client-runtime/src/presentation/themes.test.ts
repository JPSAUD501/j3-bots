// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, type SavedTheme, ThemeId, type ThemeLibrary } from "@j3-bots/contracts";
import { stockPalette } from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { shownTheme, themePalettes } from "./themes.ts";

const dusk: SavedTheme = {
  id: ThemeId.make("dusk"),
  definition: { name: "Dusk", canvas: "#1a1426", accent: "#e0a030" },
  madeBy: { _tag: "bot", botId: BotId.make("bot_1") },
  background: null,
  updatedAt: DateTime.makeUnsafe("2026-11-20T10:00:00Z"),
};

const library = (defaultTheme: string): ThemeLibrary => ({
  themes: [dusk],
  defaultTheme: ThemeId.make(defaultTheme),
});

describe("the theme a device shows", () => {
  it("is the one its person picked, while it exists", () => {
    expect(shownTheme("dusk", library("oceano"), true)?.id).toBe("dusk");
    expect(shownTheme("grafite", null, false)?.id).toBe("grafite");
  });

  it("is the server's default when they picked none, or one since deleted", () => {
    expect(shownTheme(null, library("dusk"), true)?.id).toBe("dusk");
    expect(shownTheme("gone", library("oceano"), true)?.id).toBe("oceano");
  });

  it("is the stock theme when nothing else is known, and waits for a library on its way", () => {
    expect(shownTheme(null, null, true)?.id).toBe("palco");
    expect(shownTheme("dusk", null, false)).toBeNull();
  });
});

describe("a theme's palettes", () => {
  it("pass over a role a later release added", () => {
    const later = themePalettes({
      name: "Later",
      canvas: { light: "#ffffff", dark: "#000000" },
      accent: { light: "#101012", dark: "#f5f5f6" },
      colors: { "glow-edge": "#ff00ff" },
    });
    expect(later.dark.background).toBe("#000000");
  });

  it("are the stock ones for a theme this release cannot read", () => {
    const unreadable = themePalettes({ name: "Odd", canvas: "black", accent: "#ff0000" });
    expect(unreadable.light).toEqual(stockPalette("light"));
  });
});
