// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { BotId } from "@j3-bots/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createTestRoot } from "../app/testRoot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageText } from "./MessageText";
import { selectedPassage } from "./quoteSelection";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createTestRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const wren = { name: "Wren", of: { _tag: "bot", botId: BotId.make("wren") } } as const;

/** Draws the messages, each by its id. */
const show = (messages: Record<string, string>) =>
  act(() =>
    root.render(
      <>
        {Object.entries(messages).map(([id, text]) => (
          <MessageText key={id} text={text} mentionable={[wren]} quoteId={id} />
        ))}
      </>,
    ),
  );

/** The `nth` text node that holds `needle`, and where `needle` starts in it. */
function find(needle: string, nth = 0): { readonly node: Text; readonly at: number } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    const at = node.data.indexOf(needle);
    if (at === -1) continue;
    if (seen === nth) return { node, at };
    seen += 1;
  }
  throw new Error(`No text holds ${needle}`);
}

/** A range from the start of `from` to the end of `to`, as the operator drags it. */
function select(from: string, to: string): Range {
  const start = find(from);
  const end = find(to);
  const range = document.createRange();
  range.setStart(start.node, start.at);
  range.setEnd(end.node, end.at + to.length);
  return range;
}

/** What the selection quotes of `text`, as `passageOf` slices it. */
const quoted = (text: string, range: Range) => {
  const passage = selectedPassage(range);
  return passage === null ? null : text.slice(passage.start, passage.end);
};

describe("a selection of a message's text", () => {
  it("maps plain text to where it stands in the text", () => {
    const text = "Booked the table for eight";
    show({ m1: text });
    expect(selectedPassage(select("table", "eight"))).toEqual({
      messageId: "m1",
      start: text.indexOf("table"),
      end: text.length,
    });
  });

  it("takes the backticks around inline code it spans, as the text has them", () => {
    const text = "Run `npm test` before you push";
    show({ m1: text });
    expect(quoted(text, select("test", "before"))).toBe("test` before");
  });

  it("maps a link as written", () => {
    const text = "The menu is at https://example.com/menu and it changes";
    show({ m1: text });
    expect(quoted(text, select("example", "and"))).toBe("example.com/menu and");
  });

  it("takes a mention whole when the selection starts inside it", () => {
    const text = "Ask @Wren about the cake";
    show({ m1: text });
    const range = select("ren", "about");
    expect(quoted(text, range)).toBe("@Wren about");
  });

  it("spans paragraphs with the blank line between them", () => {
    const text = "First things first.\n\nThen the rest.";
    show({ m1: text });
    expect(quoted(text, select("first.", "Then"))).toBe("first.\n\nThen");
  });

  it("starts at the next part when the selection starts between paragraphs", () => {
    const text = "One line.\n\nAnother line.";
    show({ m1: text });
    const paragraphs = container.querySelectorAll("p");
    const second = find("Another");
    const range = document.createRange();
    range.setStart(paragraphs[0]?.parentElement ?? container, 1);
    range.setEnd(second.node, second.at + "Another".length);
    expect(quoted(text, range)).toBe("Another");
  });

  it("takes the last paragraph whole when a triple click ends where what follows starts", () => {
    const text = "One line.\n\nThe last one.";
    show({ m1: text, m2: "Next message" });
    const last = find("The last one.");
    const next = find("Next message");
    const range = document.createRange();
    range.setStart(last.node, last.at);
    // Before the next message's words: nothing of it is selected.
    range.setEnd(next.node, 0);
    expect(quoted(text, range)).toBe("The last one.");
  });

  it("quotes nothing across two messages", () => {
    show({ m1: "Booked it", m2: "Thanks a lot" });
    expect(selectedPassage(select("Booked", "Thanks"))).toBeNull();
  });
});
