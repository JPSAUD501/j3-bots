// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { parseMessageText } from "../presentation/messageText.ts";
import type { DraftMention } from "../stores/Drafts.ts";
import { FILE_MARK, fittedMarks, insertMarks, placedMessage, withoutMarks } from "./placed.ts";

const M = FILE_MARK;
const ana: DraftMention = { _tag: "bot", botId: BotId.make("ana"), label: "Ana", position: 6 };

describe("a draft's placed files", () => {
  it("send their places, and the bubble draws each file back where its mark stood", () => {
    const draft = `  Compare ${M}${M} with ${M}, then\n\n${M}\nread \`the ${M}notes\` `;
    const sent = placedMessage(draft);
    expect(sent.text).toBe("Compare  with , then\n\n\nread `the notes`");
    expect(sent.offsets).toEqual([8, 8, 14, 22, 33]);
    expect(parseMessageText(sent.text, [], sent.offsets)).toEqual([
      {
        kind: "paragraph",
        inlines: [
          { kind: "text", text: "Compare " },
          { kind: "file", index: 0 },
          { kind: "file", index: 1 },
          { kind: "text", text: " with " },
          { kind: "file", index: 2 },
          { kind: "text", text: ", then" },
        ],
      },
      // On a line of its own between paragraphs, a file is a paragraph of its own.
      { kind: "paragraph", inlines: [{ kind: "file", index: 3 }] },
      {
        kind: "paragraph",
        inlines: [
          { kind: "text", text: "read " },
          // Inside code it would split the code: it stands after it.
          { kind: "code", text: "the notes" },
          { kind: "file", index: 4 },
        ],
      },
    ]);
  });

  it("stand at the edge of the text when placed in space a message trims away", () => {
    expect(placedMessage(` ${M} hello ${M} `)).toEqual({ text: "hello", offsets: [0, 5] });
    expect(placedMessage(`${M}${M}`)).toEqual({ text: "", offsets: [0, 0] });
  });

  it("never stand between the halves of a character", () => {
    expect(placedMessage(`a\uD83D${M}\uDE42b`).offsets).toEqual([3]);
  });

  it("move the mentions after them as they are placed and taken out", () => {
    const writing = { text: "hello @Ana", mentions: [ana] };
    const placed = insertMarks(writing, 6, 2);
    expect(placed).toEqual({
      text: `hello ${M}${M}@Ana`,
      mentions: [{ ...ana, position: 8 }],
      index: 0,
    });
    expect(withoutMarks(placed, (index) => index === 1)).toEqual({
      text: `hello ${M}@Ana`,
      mentions: [{ ...ana, position: 7 }],
    });
  });

  it("are all placed in a text kept before drafts placed them, after it", () => {
    expect(fittedMarks({ text: "notes", mentions: [] }, 2).text).toBe(`notes${M}${M}`);
    expect(fittedMarks({ text: `a${M}b${M}`, mentions: [] }, 1).text).toBe(`a${M}b`);
  });
});
