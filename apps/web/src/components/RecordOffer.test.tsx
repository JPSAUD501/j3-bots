// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { BotId, type MessageEntry } from "@j3-bots/contracts";
import { message } from "@j3-bots/client-runtime/testing";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageBubble } from "./MessageBubble";
import type { RecordScreen } from "./RecordOffer";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const scout = { _tag: "bot", botId: BotId.make("scout") } as const;
const asked = "Want to show me once? Record your screen while you do it.";
const elsewhere = "To record your screen, open the J3 Bots app on your computer.";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const show = (entry: MessageEntry, recordScreen: RecordScreen) =>
  act(() =>
    root.render(
      <MessageBubble
        message={entry}
        position="single"
        onOpenAttachment={() => {}}
        onRetry={() => {}}
        recordScreen={recordScreen}
      />,
    ),
  );

const offering = (author: MessageEntry["author"], kind: "record-screen" | "unknown") =>
  message("2026-11-27T10:00:00Z", author, asked, { offer: { kind } });

const buttons = () => [...container.querySelectorAll("button")];

describe("a bot's offer to record the screen", () => {
  it("opens the recorder where this app records", () => {
    const record = vi.fn();
    show(offering(scout, "record-screen"), { _tag: "here", record });
    const [offer] = buttons();
    act(() => offer?.click());
    expect(record).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(elsewhere);
  });

  it("says to open the app on the computer where this app cannot record, with nothing to press", () => {
    show(offering(scout, "record-screen"), { _tag: "elsewhere" });
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain(elsewhere);
  });

  it("shows nothing for an offer this version does not know, or on the operator's message", () => {
    const record = vi.fn();
    for (const entry of [
      offering(scout, "unknown"),
      offering({ _tag: "operator" }, "record-screen"),
    ]) {
      show(entry, { _tag: "here", record });
      expect(buttons()).toHaveLength(0);
      show(entry, { _tag: "elsewhere" });
      expect(container.textContent).not.toContain(elsewhere);
    }
  });
});
