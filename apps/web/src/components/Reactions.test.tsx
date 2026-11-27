// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { BotId, type Reaction, ReactionEmoji } from "@j3-bots/contracts";
import { message } from "@j3-bots/client-runtime/testing";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createTestRoot } from "../app/testRoot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageBubble } from "./MessageBubble";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
const reacted = (emoji: string, by: Reaction["by"]): Reaction => ({
  emoji: ReactionEmoji.make(emoji),
  by,
});
const reactions = [
  reacted("🎉", { _tag: "operator" }),
  reacted("🎉", { _tag: "bot", botId: BotId.make("wren") }),
  reacted("❤️", { _tag: "bot", botId: BotId.make("atlas") }),
];

let root: Root;
let container: HTMLElement;
let sent: Array<ReactionEmoji | null>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createTestRoot(container);
  sent = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const show = (entry: ReturnType<typeof message>) =>
  act(() =>
    root.render(
      <MessageBubble
        message={entry}
        position="single"
        onOpenAttachment={() => {}}
        onRetry={() => {}}
        onReact={(emoji) => sent.push(emoji)}
      />,
    ),
  );

/** The button named `label`, wherever it is drawn: a popup's are outside the container. */
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label,
  ) ?? null;

describe("reactions under a message", () => {
  it("takes the operator's reaction off when they click their own pill", () => {
    show(message("2026-11-27T10:00:00Z", scout, "Booked", { reactions }));
    act(() => button("Remove your 🎉")?.click());
    expect(sent).toEqual([null]);
  });

  it("sets the emoji of a pill that isn't theirs as the operator's", () => {
    show(message("2026-11-27T10:00:00Z", scout, "Booked", { reactions }));
    act(() => button("❤️, 1 reaction")?.click());
    expect(sent).toEqual(["❤️"]);
  });

  it("sets what the operator picks from the bar", async () => {
    show(message("2026-11-27T10:00:00Z", scout, "Booked", { reactions }));
    await act(async () => button("React")?.click());
    await act(async () => button("👍")?.click());
    expect(sent).toEqual(["👍"]);
  });

  it("offers no reacting on a message from a server without reactions", () => {
    show(message("2026-11-27T10:00:00Z", scout, "Booked"));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
