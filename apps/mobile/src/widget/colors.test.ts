// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeFS from "node:fs";
import { colors } from "@j3-bots/design-tokens";
import { hexColor } from "@j3-bots/design-tokens/raster";
import { describe, expect, it } from "vite-plus/test";

// Android draws the widget with colors of its own resources, which cannot
// name the design tokens: these keep them the tokens' colors.

const res = new URL("../../modules/home-widget/android/src/main/res/", import.meta.url);

const colorsIn = (folder: string): ReadonlyMap<string, string> =>
  new Map(
    [
      ...NodeFS.readFileSync(new URL(`${folder}/colors.xml`, res), "utf8").matchAll(
        /<color name="([^"]+)">([^<]+)<\/color>/gu,
      ),
    ].map(([, name = "", value = ""]) => [name, value.toLowerCase()]),
  );

const tokens = {
  j3_widget_surface: colors.surface,
  j3_widget_foreground: colors.foreground,
  j3_widget_muted: colors["muted-foreground"],
};

describe("the widget's colors", () => {
  it.each([
    ["values", "light"],
    ["values-night", "dark"],
  ] as const)("in %s are the %s theme's tokens", (folder, theme) => {
    expect(Object.fromEntries(colorsIn(folder))).toEqual(
      Object.fromEntries(
        Object.entries(tokens).map(([name, token]) => [name, hexColor(token[theme])]),
      ),
    );
  });
});
