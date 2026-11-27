// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { QuickSend, QuickSendResult } from "@j3-bots/client-runtime/react";
import { type BotId, EntryId, NotFound } from "@j3-bots/contracts";
import { cardTiming } from "@j3-bots/design-tokens";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RosterProvider } from "../app/context";
import { ids, SAMPLE_NOW, sampleTeam } from "../gallery/sample";
import { type BotCardIntents, BotCardProvider, useBotCard } from "./BotCard";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const team = sampleTeam(SAMPLE_NOW);

interface Told {
  readonly talk: Array<BotId>;
  readonly sent: Array<Parameters<QuickSend>[0]>;
}

/** Wren's and Atlas's names, as roster rows have them, and a field and a button elsewhere on the page. */
function Page({ intents }: { intents: BotCardIntents }) {
  return (
    <RosterProvider roster={team.roster} engine={team.engine}>
      <BotCardProvider intents={intents}>
        <Name botId={ids.wren} name="Wren" />
        <Name botId={ids.atlas} name="Atlas" />
        <input aria-label="Elsewhere" />
        <button type="button">After</button>
      </BotCardProvider>
    </RosterProvider>
  );
}

function Name({ botId, name }: { botId: BotId; name: string }) {
  const card = useBotCard(botId);
  return (
    <button type="button" data-card-anchor="" {...card.hover} {...card.focus}>
      {name}
    </button>
  );
}

let root: Root;
let container: HTMLElement;
let told: Told;
let answer: (input: Parameters<QuickSend>[0]) => Promise<QuickSendResult>;

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  told = { talk: [], sent: [] };
  answer = () => Promise.resolve({ _tag: "done", value: EntryId.make("quick") });
  const intents: BotCardIntents = {
    talk: (botId) => told.talk.push(botId),
    startRoom: () => {},
    openRoutines: () => {},
    openDetails: () => {},
    send: (input) => {
      told.sent.push(input);
      return answer(input);
    },
    routines: () => [],
    showing: () => {},
  };
  act(() => root.render(<Page intents={intents} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  vi.useRealTimers();
});

const named = (name: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`No ${name} on the page`);
  return found;
};
const wren = () => named("Wren");
const elsewhere = () => {
  const found = container.querySelector<HTMLInputElement>("input[aria-label=Elsewhere]");
  if (found === null) throw new Error("No field elsewhere on the page");
  return found;
};
const popup = () => document.querySelector<HTMLElement>("[data-bot-card]");
const isOpen = () => popup()?.hasAttribute("data-open") === true;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const pointer = (type: "pointerover" | "pointerout", target: Element) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
  });
const key = (target: Element, init: KeyboardEventInit) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
const openByHover = () => {
  pointer("pointerover", wren());
  wait(cardTiming.open);
};

describe("a bot's card", () => {
  it("opens once the pointer rests on the bot, and goes once it has left both", () => {
    pointer("pointerover", wren());
    wait(cardTiming.open - 1);
    expect(isOpen()).toBe(false);
    wait(1);
    expect(isOpen()).toBe(true);
    expect(popup()?.textContent).toContain("Writing");

    // From the bot onto the card, it stays.
    pointer("pointerout", wren());
    const card = popup();
    if (card === null) throw new Error("No card");
    pointer("pointerover", card);
    wait(cardTiming.close);
    expect(isOpen()).toBe(true);

    pointer("pointerout", card);
    wait(cardTiming.close - 1);
    expect(isOpen()).toBe(true);
    wait(1);
    expect(isOpen()).toBe(false);
  });

  it("opens on keyboard focus without taking it; Tab enters it, Escape closes it and gives focus back", () => {
    act(() => wren().focus());
    wait(cardTiming.open);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(wren());

    key(wren(), { key: "Tab" });
    const card = popup();
    expect(card?.contains(document.activeElement)).toBe(true);

    if (document.activeElement === null) throw new Error("Nothing has focus");
    key(document.activeElement, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(wren());
    // Focus that came back from the card opens it no more.
    wait(cardTiming.open * 2);
    expect(isOpen()).toBe(false);
  });

  it("makes way for typing elsewhere: a card on its way does not come, one the pointer opened goes", () => {
    pointer("pointerover", wren());
    wait(cardTiming.open / 2);
    key(elsewhere(), { key: "a" });
    wait(cardTiming.open);
    expect(isOpen()).toBe(false);

    pointer("pointerout", wren());
    openByHover();
    expect(isOpen()).toBe(true);
    // A modifier alone is not typing.
    key(elsewhere(), { key: "Shift" });
    expect(isOpen()).toBe(true);
    key(elsewhere(), { key: "a" });
    expect(isOpen()).toBe(false);
  });

  it("sends a quick message to the bot's conversation without opening it, and says so", async () => {
    openByHover();
    const field = document.querySelector<HTMLInputElement>(
      "[data-bot-card] input[aria-label='Quick message to Wren']",
    );
    if (field === null) throw new Error("No quick message field");
    act(() => {
      // As typing does: React hears the value through the input event.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "  Can you send the draft?  ",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.form?.requestSubmit();
    });

    expect(told.sent).toEqual([
      { target: { _tag: "conversation", botId: ids.wren }, text: "Can you send the draft?" },
    ]);
    expect(told.talk).toEqual([]);
    expect(field.value).toBe("");
    expect(popup()?.textContent).toContain("Sent to Wren.");
  });

  it("stays on its bot while the operator works in it, the pointer resting on another bot", () => {
    openByHover();
    const field = document.querySelector<HTMLInputElement>("[data-bot-card] input");
    if (field === null) throw new Error("No quick message field");
    act(() => field.focus());
    pointer("pointerout", wren());
    pointer("pointerover", named("Atlas"));
    wait(cardTiming.open);
    expect(popup()?.textContent).toContain("Wren");
    expect(popup()?.textContent).not.toContain("Atlas");
    expect(document.activeElement).toBe(field);
  });

  it("says when the bot is gone and what was typed broke a limit, giving the text back", async () => {
    openByHover();
    const field = document.querySelector<HTMLInputElement>("[data-bot-card] input");
    if (field === null) throw new Error("No quick message field");
    const type = (text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field,
          text,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });

    answer = () =>
      Promise.resolve({
        _tag: "failed",
        failure: { _tag: "refused", error: new NotFound({ resource: "bot" }) },
      });
    type("Still there?");
    await act(async () => field.form?.requestSubmit());
    expect(popup()?.textContent).toContain("Wren is no longer here.");

    answer = () => Promise.resolve({ _tag: "invalid", problem: "too-long" });
    type("A very long message");
    await act(async () => field.form?.requestSubmit());
    expect(field.value).toBe("A very long message");
  });
});
