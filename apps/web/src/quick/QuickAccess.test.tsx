// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { EntryTarget } from "@j3-bots/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ids } from "../gallery/sample";
import { useSampleSource } from "../gallery/sampleSource";
import { QuickAccess } from "./QuickAccess";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));
// Nothing travels: it is in place at once, and its way out ends with the fade the test ends.
vi.mock("../lib/motion", () => ({ reducedMotion: () => true, play: () => null }));

interface Told {
  readonly closed: Array<true>;
  readonly left: Array<true>;
  /** What it said is on screen, each time it said so. */
  readonly onScreen: Array<EntryTarget | null>;
  readonly attached: Array<{ readonly target: EntryTarget; readonly names: ReadonlyArray<string> }>;
}

/** Quick access on a bot of the sample team, telling `told` what it asks for. */
function Harness({ shown, asked, told }: { shown: boolean; asked: number; told: Told }) {
  const source = useSampleSource();
  const row = source.data.roster?.flatMap((item) =>
    item._tag === "bot" && item.bot.id === ids.wren ? [item] : [],
  )[0];
  if (row === undefined) return null;
  return (
    <QuickAccess
      bot={row.bot}
      lastEntry={row.lastEntry}
      data={source.data}
      intents={{
        ...source.intents,
        attachFiles: (target, files) =>
          told.attached.push({ target, names: files.map((file) => file.name) }),
        setShown: (target) => told.onScreen.push(target),
      }}
      solid={false}
      shown={shown}
      asked={asked}
      onOpenConversation={() => {}}
      onOpenPair={() => {}}
      onOpenRoom={() => {}}
      onClose={() => told.closed.push(true)}
      onLeft={() => told.left.push(true)}
    />
  );
}

let root: Root;
let container: HTMLElement;
let told: Told;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  told = { closed: [], left: [], attached: [], onScreen: [] };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const show = (shown: boolean, asked: number) =>
  act(() => root.render(<Harness shown={shown} asked={asked} told={told} />));
const region = () => {
  const found = container.querySelector<HTMLElement>("[role=region]");
  if (found === null) throw new Error("No quick access on the page");
  return found;
};
const composer = () => container.querySelector<HTMLElement>("[data-composer]");
const note = () => new File(["note"], "note.txt", { type: "text/plain" });
/** A drop or a paste of `files`, as the browser hands one over. */
const carrying = (type: "drop" | "paste", files: ReadonlyArray<File>) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const carried = { files, types: ["Files"] };
  Object.defineProperty(event, type === "drop" ? "dataTransfer" : "clipboardData", {
    value: carried,
  });
  return event;
};

describe("quick access", () => {
  it("has the cursor in the composer as it opens, and again each time it is asked for", () => {
    show(true, 1);
    expect(composer()).not.toBeNull();
    expect(document.activeElement).toBe(composer());

    container.querySelector<HTMLElement>("button[aria-keyshortcuts=Escape]")?.focus();
    expect(document.activeElement).not.toBe(composer());
    show(true, 2);
    expect(document.activeElement).toBe(composer());
  });

  it("takes no keys and no focus while it does not show", () => {
    show(false, 0);
    expect(region().inert).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(told.closed).toHaveLength(0);
  });

  it("closes on Escape, unless something on it took the key", () => {
    show(true, 1);
    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    act(() => {
      window.dispatchEvent(taken);
    });
    expect(told.closed).toHaveLength(0);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(told.closed).toHaveLength(1);
  });

  it("has the conversation on screen only while it shows with nothing over it", async () => {
    show(true, 1);
    expect(told.onScreen.at(-1)).toEqual({ _tag: "conversation", botId: ids.wren });
    // A dialog over the card, as an image opened from it, hides it from what reads it.
    await act(async () => {
      container.setAttribute("aria-hidden", "true");
      await Promise.resolve();
    });
    expect(told.onScreen.at(-1)).toBeNull();
    await act(async () => {
      container.removeAttribute("aria-hidden");
      await Promise.resolve();
    });
    expect(told.onScreen.at(-1)).toEqual({ _tag: "conversation", botId: ids.wren });
    show(false, 1);
    expect(told.onScreen.at(-1)).toBeNull();
  });

  it("says it has left only once it is out of sight", () => {
    show(true, 1);
    show(false, 1);
    expect(told.left).toHaveLength(0);
    act(() => {
      region().dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(told.left).toHaveLength(1);
  });

  it("attaches a file dropped on the card or pasted on it, to the bot's conversation", () => {
    show(true, 1);
    const card = container.querySelector("header");
    act(() => {
      card?.dispatchEvent(carrying("drop", [note()]));
    });
    act(() => {
      window.dispatchEvent(carrying("paste", [note()]));
    });
    expect(told.attached).toEqual([
      { target: { _tag: "conversation", botId: ids.wren }, names: ["note.txt"] },
      { target: { _tag: "conversation", botId: ids.wren }, names: ["note.txt"] },
    ]);
  });

  it("takes a file dropped beside the card nowhere", () => {
    show(true, 1);
    const drop = carrying("drop", [note()]);
    act(() => {
      region().dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(told.attached).toHaveLength(0);
  });
});
