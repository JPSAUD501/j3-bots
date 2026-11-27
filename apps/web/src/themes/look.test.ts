// SPDX-License-Identifier: AGPL-3.0-or-later
import { themeChoices } from "@j3-bots/client-runtime/presentation";
import { BotId, ThemeId, type ThemeLibrary } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { lookOf, THEME_ROOT } from "./look";

const own = `[data-slot="bubble"] { border-radius: 4px; }`;

const library: ThemeLibrary = {
  themes: [
    {
      id: ThemeId.make("square"),
      definition: { name: "Square", canvas: "#101418", accent: "#e8b04a", css: own },
      madeBy: { _tag: "bot", botId: BotId.make("scout") },
      background: null,
      updatedAt: DateTime.makeUnsafe("2026-11-20T10:00:00Z"),
    },
  ],
  defaultTheme: ThemeId.make("palco"),
};

const choice = (id: string) => {
  const found = themeChoices(library).find((theme) => theme.id === id);
  if (found === undefined) throw new Error(`No theme ${id}`);
  return found;
};

describe("the look a page draws for a theme", () => {
  it("is its colors over both appearances, and its own CSS only where CSS is allowed", () => {
    const withCss = lookOf(choice("square"), true);
    const colorsOnly = lookOf(choice("square"), false);
    expect(withCss?.css).toContain(`${THEME_ROOT}.dark {`);
    expect(withCss?.css).toContain(own);
    expect(colorsOnly?.css).not.toContain(own);
    expect(withCss?.canvas.dark).toBe("#101418");
    // The desktop app fills its window with it before the page paints, as hex.
    expect(withCss?.window.dark.background).toBe("#101418");
  });

  it("is nothing for the stock theme, which the app's own styles draw", () => {
    expect(lookOf(choice("palco"), true)).toBeNull();
    expect(lookOf(choice("grafite"), true)).not.toBeNull();
  });
});
