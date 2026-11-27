// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { themeChoices } from "@j3-bots/client-runtime/presentation";
import { BotId, ThemeId, type ThemeLibrary } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { drawLook, holdOwnCss, lookOf, OWN_CSS_MEDIA, THEME_ROOT } from "./look";

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
    expect(withCss?.colors).toContain(`${THEME_ROOT}.dark {`);
    expect(withCss?.css).toBe(own);
    expect(colorsOnly?.colors).toBe(withCss?.colors);
    expect(colorsOnly?.css).toBe("");
    // The browser's chrome and the desktop app's window fill with it before the page paints.
    expect(withCss?.window.dark.background).toBe("#101418");
  });

  it("is nothing for the stock theme, which the app's own styles draw", () => {
    expect(lookOf(choice("palco"), true)).toBeNull();
    expect(lookOf(choice("grafite"), true)).not.toBeNull();
  });
});

describe("a theme's own CSS", () => {
  /** The stylesheets the page applies: a sheet whose media is `not all` applies nowhere. */
  const applied = () =>
    [...document.head.querySelectorAll("style")]
      .filter((style) => style.media !== "not all")
      .map((style) => style.textContent);

  afterEach(() => {
    holdOwnCss(false);
    drawLook(null);
  });

  it("applies on a computer, and is held off while Settings is open", () => {
    const look = lookOf(choice("square"), true);
    drawLook(look);
    expect(applied()).toEqual([look?.colors, own]);
    // On a computer only: a phone or a tablet, with no Ctrl+, to reach Settings, shows the colors.
    expect(document.getElementById("j3-theme-css")?.getAttribute("media")).toBe(OWN_CSS_MEDIA);

    holdOwnCss(true);
    expect(applied()).toEqual([look?.colors]);
    // A theme that changes while Settings is open stays held off.
    drawLook(look === null ? null : { ...look, css: `${own} * { color: red; }` });
    expect(applied()).toEqual([look?.colors]);

    holdOwnCss(false);
    expect(applied()).toEqual([look?.colors, `${own} * { color: red; }`]);
  });
});
