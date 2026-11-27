// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { themeChoices } from "@j3-bots/client-runtime/presentation";
import { message } from "@j3-bots/client-runtime/testing";
import { BotId, type MessageEntry, ThemeId, type ThemeLibrary } from "@j3-bots/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createTestRoot } from "../app/testRoot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ShownThemesProvider, type ShownThemes } from "../themes/ThemeRuntime";
import { MessageBubble } from "./MessageBubble";

const picked = vi.hoisted(() => ({ setThemeId: vi.fn() }));

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light", themeId: null }),
  setThemeId: picked.setThemeId,
  showLook: () => {},
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;

const library: ThemeLibrary = {
  themes: [
    {
      id: ThemeId.make("low-tide"),
      definition: { name: "Low tide", canvas: "#0f1a19", accent: "#7fd8c4" },
      madeBy: { _tag: "bot", botId: scout.botId },
      background: null,
      updatedAt: message("2026-11-27T10:00:00Z", scout, "").createdAt,
    },
  ],
  defaultTheme: ThemeId.make("palco"),
};

const themesShowing = (shown: string, known = true): ShownThemes => ({
  themes: { supported: true, library: known ? library : null, known },
  intents: {
    save: () => Promise.resolve({ _tag: "failed", failure: { _tag: "unexpected" } }),
    remove: () => Promise.resolve({ _tag: "done", value: undefined }),
    setDefault: () => Promise.resolve({ _tag: "done", value: undefined }),
    background: () => Promise.resolve({ _tag: "failed", reason: "not-found" }),
  },
  shown: themeChoices(library).find((choice) => choice.id === shown) ?? null,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createTestRoot(container);
  picked.setThemeId.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const offering = (author: MessageEntry["author"], themeId: string) =>
  message("2026-11-27T10:00:00Z", author, "I made you a theme. Want to try it?", {
    offer: { kind: "apply-theme", themeId: ThemeId.make(themeId) },
  });

const show = (entry: MessageEntry, themes: ShownThemes) =>
  act(() =>
    root.render(
      <ShownThemesProvider value={themes}>
        <MessageBubble
          message={entry}
          position="single"
          onOpenAttachment={() => {}}
          onRetry={() => {}}
        />
      </ShownThemesProvider>,
    ),
  );

const buttons = () => [...container.querySelectorAll("button")];

describe("a bot's offer of a theme", () => {
  it("shows the theme on this device when the person applies it", () => {
    show(offering(scout, "low-tide"), themesShowing("palco"));
    const [apply] = buttons();
    expect(apply?.textContent).toContain("Apply theme");
    act(() => apply?.click());
    expect(picked.setThemeId).toHaveBeenCalledWith("low-tide");
  });

  it("says the theme is in use once it shows, with nothing to press", () => {
    show(offering(scout, "low-tide"), themesShowing("low-tide"));
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain("In use on this device");
  });

  it("says a theme deleted since is gone, and waits while the library is on its way", () => {
    show(offering(scout, "ember-night"), themesShowing("palco"));
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain("This theme was deleted.");
    show(offering(scout, "ember-night"), themesShowing("palco", false));
    expect(container.textContent).not.toContain("This theme was deleted.");
  });

  it("is offered only by a bot", () => {
    show(offering({ _tag: "operator" }, "low-tide"), themesShowing("palco"));
    expect(buttons()).toHaveLength(0);
  });
});
