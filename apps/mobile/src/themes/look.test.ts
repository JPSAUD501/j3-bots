// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isStockTheme,
  type ThemeChoice,
  themeChoices,
  themePalettes,
} from "@j3-bots/client-runtime/presentation";
import { ThemeId } from "@j3-bots/contracts";
import { nativeThemeVariables, stockPalette } from "@j3-bots/design-tokens";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The theme as it reaches the app, with the key-value store held in memory
// and Uniwind's renderer replaced by a record of what it was handed.

const storage = vi.hoisted(() => new Map<string, string>());
const painted = vi.hoisted(() => [] as Array<readonly [string, Readonly<Record<string, string>>]>);

vi.mock("expo-sqlite/kv-store", () => ({
  Storage: {
    getItemSync: (key: string) => storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => void storage.set(key, value),
    removeItemSync: (key: string) => void storage.delete(key),
  },
}));

vi.mock("uniwind", () => ({
  Uniwind: {
    updateCSSVariables: (theme: string, variables: Readonly<Record<string, string>>) =>
      void painted.push([theme, variables]),
  },
}));

/** The look module as a fresh launch of the app loads it. */
const launch = async () => {
  vi.resetModules();
  return import("./look.ts");
};

const saved = (canvas: string): ThemeChoice => ({
  id: ThemeId.make("harbor"),
  definition: { name: "Harbor", canvas, accent: "#2f9e72" },
  origin: { _tag: "operator" },
  background: null,
});

const stock = (): ThemeChoice => {
  const found = themeChoices(null).find(isStockTheme);
  if (found === undefined) throw new Error("The built-ins have no stock theme.");
  return found;
};

const variablesOf = (choice: ThemeChoice) => {
  const palettes = themePalettes(choice.definition);
  return [
    ["light", nativeThemeVariables(palettes.light, "light")],
    ["dark", nativeThemeVariables(palettes.dark, "dark")],
  ];
};

const STOCK_VARIABLES = [
  ["light", nativeThemeVariables(stockPalette("light"), "light")],
  ["dark", nativeThemeVariables(stockPalette("dark"), "dark")],
];

describe("the theme this phone shows", () => {
  beforeEach(() => {
    storage.clear();
    painted.length = 0;
  });

  it("paints a theme in both appearances, and the next launch starts in it", async () => {
    const look = await launch();
    look.showTheme(saved("#0f1a2b"));
    expect(painted).toEqual(variablesOf(saved("#0f1a2b")));
    expect(look.shownPalettes()).toEqual(themePalettes(saved("#0f1a2b").definition));

    painted.length = 0;
    const next = await launch();
    next.applyKeptLook();
    expect(painted).toEqual(variablesOf(saved("#0f1a2b")));
  });

  it("paints again only when the colors change, though the theme keeps its id", async () => {
    const look = await launch();
    look.showTheme(saved("#0f1a2b"));
    look.showTheme(saved("#0f1a2b"));
    expect(painted).toHaveLength(2);
    look.showTheme(saved("#1d2a22"));
    expect(painted.slice(2)).toEqual(variablesOf(saved("#1d2a22")));
  });

  it("puts the stock colors back, and the next launch paints nothing", async () => {
    const look = await launch();
    look.showTheme(saved("#0f1a2b"));
    painted.length = 0;
    look.showTheme(stock());
    expect(painted).toEqual(STOCK_VARIABLES);

    painted.length = 0;
    const next = await launch();
    next.applyKeptLook();
    expect(painted).toEqual([]);
  });

  it("starts in the stock theme from a kept look it cannot read", async () => {
    storage.set("j3:theme-look", '{"definition":{"name":"Harbor"}}');
    const look = await launch();
    look.applyKeptLook();
    expect(painted).toEqual([]);
  });
});
